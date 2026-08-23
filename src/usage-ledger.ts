/** Persistent, provider-neutral request usage ledger and backend aggregations. */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { OpenAICodexUsage } from './usage.ts'

export const OPENAI_CODEX_USAGE_DB_FILENAME = '.openai-codex-usage.sqlite3'

export type CodexModelFamily = 'sol' | 'terra' | 'luna' | 'other'
export type CreditSource = 'server' | 'calculated' | 'unknown'
export type UsageRange = 'today' | '24h' | '7d' | 'this-week' | '30d' | '90d' | 'all' | 'custom'

export interface UsageFilters {
  range?: UsageRange
  start?: number
  end?: number
  providers?: readonly string[]
  models?: readonly string[]
  reasoning?: readonly string[]
}

export interface UsageCorrelation {
  taskId: string
  sessionId: string
  conversationId: string
  runId?: string | undefined
  step?: number
}

export interface RecordCodexUsage {
  timestamp?: number
  durationMs?: number
  requestId?: string
  correlation: UsageCorrelation
  provider?: string
  model: string
  reasoningEffort?: string
  serviceTier?: string | undefined
  fastMode?: boolean
  usage: TokenUsage
  serverCredits?: number | undefined
}

export interface CodexUsageEvent {
  timestamp: number
  durationMs: number
  requestId: string
  taskId: string
  sessionId: string
  conversationId: string
  runId?: string | undefined
  provider: string
  model: string
  modelFamily: CodexModelFamily
  reasoningEffort: string
  serviceTier?: string | undefined
  fastMode: boolean
  inputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  serverCredits?: number | undefined
  calculatedCredits?: number | undefined
  creditSource: CreditSource
  rateCardId?: string | undefined
}

export interface CreditRate {
  id: string
  model: string
  inputRate: number
  cachedInputRate: number
  outputRate: number
  fastMultiplier?: number | undefined
  effectiveFrom: number
  effectiveUntil?: number | undefined
  source: string
}

export interface UsageTotals {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  credits: number | null
  knownCredits: number
  unknownCreditRequests: number
  requests: number
  tasks: number
  sessions: number
  cacheHitRate: number | null
  averageCreditsPerTask: number | null
}

export interface UsageBreakdownRow extends UsageTotals {
  key: string
  label: string
}

export interface UsageTimePoint {
  timestamp: number
  provider: string
  modelFamily: CodexModelFamily
  tokens: number
  credits: number | null
  unknownCreditRequests: number
  requests: number
}

export interface TaskUsage extends UsageTotals {
  taskId: string
  sessionId: string
  startedAt: number
  endedAt: number
  durationMs: number
  provider: string
  model: string
  modelFamily: CodexModelFamily | 'mixed'
  reasoningEffort: string
  weeklyShare: number | null
}

export interface TaskDetail extends TaskUsage {
  events: CodexUsageEvent[]
}
export interface SessionUsage extends UsageTotals {
  sessionId: string
  startedAt: number
  endedAt: number
  durationMs: number
  provider: string
  model: string
  modelFamily: CodexModelFamily | 'mixed'
  reasoningEffort: string
  weeklyShare: number | null
}


export interface QuotaSnapshot {
  timestamp: number
  quotaId: string
  quotaName?: string | undefined
  windowSeconds: number
  usedPercent: number
  remainingPercent: number
  usedCredits?: number | undefined
  remainingCredits?: number | undefined
  totalCredits?: number | undefined
  resetAt?: number | undefined
}

type Row = Record<string, unknown>

function finiteInteger(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? 0 : Math.max(0, Math.trunc(value))
}

function finiteCredit(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) || value < 0 ? undefined : value
}

export function classifyCodexModel(model: string): CodexModelFamily {
  const normalized = model.toLowerCase()
  if (/(?:^|[-_.\s])sol(?:$|[-_.\s])/.test(normalized)) return 'sol'
  if (/(?:^|[-_.\s])terra(?:$|[-_.\s])/.test(normalized)) return 'terra'
  if (/(?:^|[-_.\s])luna(?:$|[-_.\s])/.test(normalized)) return 'luna'
  return 'other'
}

export function openAICodexUsageDbPath(dshHome?: string): string {
  return resolve(join(resolveDshHome(dshHome), OPENAI_CODEX_USAGE_DB_FILENAME))
}

function rangeBounds(filters: UsageFilters, now = Date.now()): { start?: number; end?: number } {
  const end = filters.end ?? now
  switch (filters.range ?? '7d') {
    case 'today': {
      const start = new Date(end)
      start.setHours(0, 0, 0, 0)
      return { start: start.getTime(), end }
    }
    case '24h': return { start: end - 86_400_000, end }
    case '7d': return { start: end - 7 * 86_400_000, end }
    case 'this-week': {
      const start = new Date(end)
      const day = start.getDay()
      start.setDate(start.getDate() - (day === 0 ? 6 : day - 1))
      start.setHours(0, 0, 0, 0)
      return { start: start.getTime(), end }
    }
    case '30d': return { start: end - 30 * 86_400_000, end }
    case '90d': return { start: end - 90 * 86_400_000, end }
    case 'all': return filters.end === undefined ? {} : { end }
    case 'custom': return { ...filters.start === undefined ? {} : { start: filters.start }, end }
  }
}

function filterSql(filters: UsageFilters, alias = 'e'): { sql: string; values: Array<string | number> } {
  // pi-ai emits a terminal usage chunk for both completed and failed streams.
  // Failures without provider usage carry an all-zero object; older plugin
  // versions persisted those placeholders. Keep them auditable on disk, but
  // never let them become requests, tasks, sessions, or chart points.
  const clauses: string[] = [`${alias}.total_tokens > 0`]
  const values: Array<string | number> = []
  const bounds = rangeBounds(filters)
  if (bounds.start !== undefined) {
    clauses.push(`${alias}.timestamp >= ?`)
    values.push(bounds.start)
  }
  if (bounds.end !== undefined) {
    clauses.push(`${alias}.timestamp <= ?`)
    values.push(bounds.end)
  }
  if (filters.providers !== undefined && filters.providers.length > 0) {
    clauses.push(`${alias}.provider IN (${filters.providers.map(() => '?').join(', ')})`)
    values.push(...filters.providers)
  }
  if (filters.models !== undefined && filters.models.length > 0) {
    clauses.push(`${alias}.model IN (${filters.models.map(() => '?').join(', ')})`)
    values.push(...filters.models)
  }
  if (filters.reasoning !== undefined && filters.reasoning.length > 0) {
    clauses.push(`${alias}.reasoning_effort IN (${filters.reasoning.map(() => '?').join(', ')})`)
    values.push(...filters.reasoning.map(value => value.toLowerCase()))
  }
  return { sql: `WHERE ${clauses.join(' AND ')}`, values }
}

function number(row: Row, key: string): number {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function nullableNumber(row: Row, key: string): number | null {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function text(row: Row, key: string): string {
  const value = row[key]
  return typeof value === 'string' ? value : ''
}

function totals(row: Row): UsageTotals {
  const inputTokens = number(row, 'input_tokens')
  const cachedInputTokens = number(row, 'cached_input_tokens')
  const knownCredits = number(row, 'known_credits')
  const unknownCreditRequests = number(row, 'unknown_credit_requests')
  const tasks = number(row, 'tasks')
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens: number(row, 'output_tokens'),
    reasoningTokens: number(row, 'reasoning_tokens'),
    totalTokens: number(row, 'total_tokens'),
    credits: unknownCreditRequests === 0 ? knownCredits : null,
    knownCredits,
    unknownCreditRequests,
    requests: number(row, 'requests'),
    tasks,
    sessions: number(row, 'sessions'),
    cacheHitRate: inputTokens === 0 ? null : cachedInputTokens / inputTokens,
    averageCreditsPerTask: tasks === 0 || unknownCreditRequests > 0 ? null : knownCredits / tasks,
  }
}

const TOTAL_COLUMNS = `
  COALESCE(SUM(e.input_tokens), 0) AS input_tokens,
  COALESCE(SUM(e.cached_input_tokens), 0) AS cached_input_tokens,
  COALESCE(SUM(e.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(e.reasoning_tokens), 0) AS reasoning_tokens,
  COALESCE(SUM(e.total_tokens), 0) AS total_tokens,
  COALESCE(SUM(COALESCE(e.server_credits, e.calculated_credits)), 0) AS known_credits,
  COALESCE(SUM(CASE WHEN e.credit_source = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_credit_requests,
  COUNT(*) AS requests,
  COUNT(DISTINCT e.task_id) AS tasks,
  COUNT(DISTINCT e.session_id) AS sessions`

function eventFromRow(row: Row): CodexUsageEvent {
  const optional = (key: string): string | undefined => text(row, key) || undefined
  return {
    timestamp: number(row, 'timestamp'),
    durationMs: number(row, 'duration_ms'),
    requestId: text(row, 'request_id'),
    taskId: text(row, 'task_id'),
    sessionId: text(row, 'session_id'),
    conversationId: text(row, 'conversation_id'),
    ...optional('run_id') === undefined ? {} : { runId: optional('run_id') },
    provider: text(row, 'provider'),
    model: text(row, 'model'),
    modelFamily: text(row, 'model_family') as CodexModelFamily,
    reasoningEffort: text(row, 'reasoning_effort'),
    ...optional('service_tier') === undefined ? {} : { serviceTier: optional('service_tier') },
    fastMode: number(row, 'fast_mode') === 1,
    inputTokens: number(row, 'input_tokens'),
    cachedInputTokens: number(row, 'cached_input_tokens'),
    cacheWriteTokens: number(row, 'cache_write_tokens'),
    outputTokens: number(row, 'output_tokens'),
    reasoningTokens: number(row, 'reasoning_tokens'),
    totalTokens: number(row, 'total_tokens'),
    ...nullableNumber(row, 'server_credits') === null ? {} : { serverCredits: nullableNumber(row, 'server_credits') ?? undefined },
    ...nullableNumber(row, 'calculated_credits') === null ? {} : { calculatedCredits: nullableNumber(row, 'calculated_credits') ?? undefined },
    creditSource: text(row, 'credit_source') as CreditSource,
    ...optional('rate_card_id') === undefined ? {} : { rateCardId: optional('rate_card_id') },
  }
}

/** One SQLite authority used by both the live HUD and every analytics query. */
export class CodexUsageLedger {
  readonly filename: string
  private db: DatabaseSync | undefined
  private opening: Promise<DatabaseSync> | undefined

  constructor(filename: string = openAICodexUsageDbPath()) {
    this.filename = filename === ':memory:' ? filename : resolve(filename)
  }

  async open(): Promise<void> {
    await this.database()
  }

  close(): void {
    this.db?.close()
    this.db = undefined
    this.opening = undefined
  }

  private async database(): Promise<DatabaseSync> {
    if (this.db !== undefined) return this.db
    if (this.opening !== undefined) return this.opening
    this.opening = (async () => {
      if (this.filename !== ':memory:') await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
      const db = new DatabaseSync(this.filename, { timeout: 5_000 })
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS codex_credit_rates (
          id TEXT PRIMARY KEY,
          model TEXT NOT NULL,
          input_rate REAL NOT NULL,
          cached_input_rate REAL NOT NULL,
          output_rate REAL NOT NULL,
          fast_multiplier REAL,
          effective_from INTEGER NOT NULL,
          effective_until INTEGER,
          source TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS codex_credit_rates_lookup
          ON codex_credit_rates(model, effective_from, effective_until);
        CREATE TABLE IF NOT EXISTS codex_usage_events (
          timestamp INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          request_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          run_id TEXT,
          step INTEGER,
          provider TEXT NOT NULL DEFAULT 'openai-codex',
          model TEXT NOT NULL,
          model_family TEXT NOT NULL,
          reasoning_effort TEXT NOT NULL,
          service_tier TEXT,
          fast_mode INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL,
          cached_input_tokens INTEGER NOT NULL,
          cache_write_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          reasoning_tokens INTEGER NOT NULL,
          total_tokens INTEGER NOT NULL,
          server_credits REAL,
          calculated_credits REAL,
          credit_source TEXT NOT NULL,
          rate_card_id TEXT,
          FOREIGN KEY(rate_card_id) REFERENCES codex_credit_rates(id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS codex_usage_events_time ON codex_usage_events(timestamp);
        CREATE INDEX IF NOT EXISTS codex_usage_events_task ON codex_usage_events(task_id, timestamp);
        CREATE INDEX IF NOT EXISTS codex_usage_events_session ON codex_usage_events(session_id, timestamp);
        CREATE TABLE IF NOT EXISTS codex_quota_snapshots (
          timestamp INTEGER NOT NULL,
          quota_id TEXT NOT NULL,
          quota_name TEXT,
          window_seconds INTEGER NOT NULL,
          used_percent REAL NOT NULL,
          remaining_percent REAL NOT NULL,
          used_credits REAL,
          remaining_credits REAL,
          total_credits REAL,
          reset_at INTEGER,
          PRIMARY KEY(timestamp, quota_id, window_seconds)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS codex_quota_latest
          ON codex_quota_snapshots(quota_id, window_seconds, timestamp DESC);
      `)
      const eventColumns = db.prepare('PRAGMA table_info(codex_usage_events)').all() as Row[]
      if (!eventColumns.some(row => text(row, 'name') === 'duration_ms')) {
        db.exec('ALTER TABLE codex_usage_events ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0')
      }
      if (!eventColumns.some(row => text(row, 'name') === 'provider')) {
        db.exec("ALTER TABLE codex_usage_events ADD COLUMN provider TEXT NOT NULL DEFAULT 'openai-codex'")
      }
      db.exec('CREATE INDEX IF NOT EXISTS codex_usage_events_provider_filters '
        + 'ON codex_usage_events(provider, model, reasoning_effort, timestamp)')
      this.db = db
      return db
    })()
    try {
      return await this.opening
    } catch (error) {
      this.opening = undefined
      throw error
    }
  }

  async addRate(rate: CreditRate): Promise<void> {
    const db = await this.database()
    db.prepare(`INSERT INTO codex_credit_rates
      (id, model, input_rate, cached_input_rate, output_rate, fast_multiplier, effective_from, effective_until, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        model=excluded.model, input_rate=excluded.input_rate, cached_input_rate=excluded.cached_input_rate,
        output_rate=excluded.output_rate, fast_multiplier=excluded.fast_multiplier,
        effective_from=excluded.effective_from, effective_until=excluded.effective_until, source=excluded.source`)
      .run(rate.id, rate.model, rate.inputRate, rate.cachedInputRate, rate.outputRate,
        rate.fastMultiplier ?? null, rate.effectiveFrom, rate.effectiveUntil ?? null, rate.source)
  }

  async record(input: RecordCodexUsage): Promise<CodexUsageEvent | undefined> {
    const timestamp = input.timestamp ?? Date.now()
    const requestId = input.requestId ?? randomUUID()
    const cacheRead = finiteInteger(input.usage.cacheReadTokens)
    const cacheWrite = finiteInteger(input.usage.cacheWriteTokens)
    const uncachedInput = finiteInteger(input.usage.inputTokens)
    const inputTokens = uncachedInput + cacheRead + cacheWrite
    const outputTokens = finiteInteger(input.usage.outputTokens)
    const reasoningTokens = Math.min(outputTokens, finiteInteger(input.usage.reasoningTokens))
    // A terminal provider error is translated by pi-ai into a usage chunk full
    // of zeros. It contains no measured usage and must not create a ledger row.
    if (inputTokens + outputTokens === 0) return undefined
    const db = await this.database()

    const rateRow = db.prepare(`SELECT * FROM codex_credit_rates
      WHERE model = ? AND effective_from <= ? AND (effective_until IS NULL OR effective_until > ?)
      ORDER BY effective_from DESC LIMIT 1`).get(input.model, timestamp, timestamp) as Row | undefined
    const serverCredits = finiteCredit(input.serverCredits)
    let calculatedCredits: number | undefined
    let rateCardId: string | undefined
    if (serverCredits === undefined && rateRow !== undefined) {
      const multiplier = input.fastMode === true ? nullableNumber(rateRow, 'fast_multiplier') ?? 1 : 1
      calculatedCredits = (
        uncachedInput * number(rateRow, 'input_rate')
        + (cacheRead + cacheWrite) * number(rateRow, 'cached_input_rate')
        + outputTokens * number(rateRow, 'output_rate')
      ) * multiplier
      rateCardId = text(rateRow, 'id')
    }
    const creditSource: CreditSource = serverCredits !== undefined
      ? 'server'
      : calculatedCredits !== undefined ? 'calculated' : 'unknown'
    const event: CodexUsageEvent = {
      timestamp,
      durationMs: finiteInteger(input.durationMs),
      requestId,
      taskId: input.correlation.taskId,
      sessionId: input.correlation.sessionId,
      conversationId: input.correlation.conversationId,
      ...input.correlation.runId === undefined ? {} : { runId: input.correlation.runId },
      model: input.model,
      provider: input.provider ?? 'openai-codex',
      modelFamily: classifyCodexModel(input.model),
      reasoningEffort: (input.reasoningEffort ?? 'none').toLowerCase(),
      ...input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier },
      fastMode: input.fastMode ?? false,
      inputTokens,
      cachedInputTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      outputTokens,
      reasoningTokens,
      totalTokens: inputTokens + outputTokens,
      ...serverCredits === undefined ? {} : { serverCredits },
      ...calculatedCredits === undefined ? {} : { calculatedCredits },
      creditSource,
      ...rateCardId === undefined ? {} : { rateCardId },
    }
    db.prepare(`INSERT OR IGNORE INTO codex_usage_events (
      timestamp, duration_ms, request_id, task_id, session_id, conversation_id, run_id, step,
      provider, model, model_family, reasoning_effort, service_tier, fast_mode,
      input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens,
      server_credits, calculated_credits, credit_source, rate_card_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.timestamp, event.durationMs, event.requestId, event.taskId, event.sessionId, event.conversationId,
        event.runId ?? null, input.correlation.step ?? null, event.provider, event.model, event.modelFamily,
        event.reasoningEffort, event.serviceTier ?? null, event.fastMode ? 1 : 0,
        event.inputTokens, event.cachedInputTokens, event.cacheWriteTokens, event.outputTokens,
        event.reasoningTokens, event.totalTokens, event.serverCredits ?? null,
        event.calculatedCredits ?? null, event.creditSource, event.rateCardId ?? null)
    return event
  }

  async summary(filters: UsageFilters = {}): Promise<UsageTotals> {
    const db = await this.database()
    const where = filterSql(filters)
    return totals(db.prepare(`SELECT ${TOTAL_COLUMNS} FROM codex_usage_events e ${where.sql}`)
      .get(...where.values) as Row)
  }

  async breakdown(column: 'provider' | 'model' | 'model_family' | 'reasoning_effort', filters: UsageFilters = {}): Promise<UsageBreakdownRow[]> {
    const db = await this.database()
    const where = filterSql(filters)
    const rows = db.prepare(`SELECT e.${column} AS key, ${TOTAL_COLUMNS}
      FROM codex_usage_events e ${where.sql} GROUP BY e.${column} ORDER BY known_credits DESC, total_tokens DESC`)
      .all(...where.values) as Row[]
    return rows.map(row => ({ key: text(row, 'key'), label: text(row, 'key'), ...totals(row) }))
  }

  async usageOverTime(filters: UsageFilters = {}): Promise<UsageTimePoint[]> {
    const db = await this.database()
    const where = filterSql(filters)
    const bounds = rangeBounds(filters)
    const span = (bounds.end ?? Date.now()) - (bounds.start ?? 365 * 86_400_000)
    const bucket = span <= 2 * 86_400_000 ? 3_600_000
      : span <= 90 * 86_400_000 ? 86_400_000
        : span <= 730 * 86_400_000 ? 7 * 86_400_000 : 30 * 86_400_000
    const rows = db.prepare(`SELECT CAST(e.timestamp / ? AS INTEGER) * ? AS bucket,
      e.provider, COALESCE(SUM(e.total_tokens), 0) AS tokens,
      COALESCE(SUM(COALESCE(e.server_credits, e.calculated_credits)), 0) AS known_credits,
      COALESCE(SUM(CASE WHEN e.credit_source = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_credit_requests,
      COUNT(*) AS requests FROM codex_usage_events e ${where.sql}
      GROUP BY bucket, e.provider ORDER BY bucket ASC, e.provider ASC`)
      .all(bucket, bucket, ...where.values) as Row[]
    return rows.map(row => ({
      timestamp: number(row, 'bucket'),
      provider: text(row, 'provider'),
      tokens: number(row, 'tokens'),
      credits: number(row, 'unknown_credit_requests') === 0 ? number(row, 'known_credits') : null,
      modelFamily: classifyCodexModel(text(row, 'provider')),
      unknownCreditRequests: number(row, 'unknown_credit_requests'),
      requests: number(row, 'requests'),
    }))
  }

  async tasks(filters: UsageFilters = {}, limit = 100): Promise<TaskUsage[]> {
    const db = await this.database()
    const where = filterSql(filters)
    const rows = db.prepare(`SELECT e.task_id, MIN(e.session_id) AS session_id,
      MIN(e.timestamp - e.duration_ms) AS started_at, MAX(e.timestamp) AS ended_at,
      CASE WHEN COUNT(DISTINCT e.provider) = 1 THEN MIN(e.provider) ELSE 'mixed' END AS provider,
      CASE WHEN COUNT(DISTINCT e.model) = 1 THEN MIN(e.model) ELSE 'Mixed' END AS model,
      CASE WHEN COUNT(DISTINCT e.model_family) = 1 THEN MIN(e.model_family) ELSE 'mixed' END AS model_family,
      CASE WHEN COUNT(DISTINCT e.reasoning_effort) = 1 THEN MIN(e.reasoning_effort) ELSE 'mixed' END AS reasoning_effort,
      ${TOTAL_COLUMNS} FROM codex_usage_events e ${where.sql}
      GROUP BY e.task_id ORDER BY ended_at DESC LIMIT ?`).all(...where.values, Math.max(1, Math.min(500, limit))) as Row[]
    const allowance = await this.weeklyCreditAllowance()
    return rows.map(row => {
      const aggregate = totals(row)
      const credits = aggregate.credits
      const startedAt = number(row, 'started_at')
      const endedAt = number(row, 'ended_at')
      return {
        taskId: text(row, 'task_id'), sessionId: text(row, 'session_id'), startedAt, endedAt,
        durationMs: Math.max(0, endedAt - startedAt), provider: text(row, 'provider'), model: text(row, 'model'),
        modelFamily: text(row, 'model_family') as CodexModelFamily | 'mixed',
        reasoningEffort: text(row, 'reasoning_effort'),
        weeklyShare: allowance === null || credits === null ? null : credits / allowance * 100,
        ...aggregate,
      }
    })
  }


  async sessions(filters: UsageFilters = {}, limit = 100): Promise<SessionUsage[]> {
    const db = await this.database()
    const where = filterSql(filters)
    const rows = db.prepare(`SELECT e.session_id, MIN(e.timestamp - e.duration_ms) AS started_at,
      MAX(e.timestamp) AS ended_at,
      CASE WHEN COUNT(DISTINCT e.provider) = 1 THEN MIN(e.provider) ELSE 'mixed' END AS provider,
      CASE WHEN COUNT(DISTINCT e.model) = 1 THEN MIN(e.model) ELSE 'Mixed' END AS model,
      CASE WHEN COUNT(DISTINCT e.model_family) = 1 THEN MIN(e.model_family) ELSE 'mixed' END AS model_family,
      CASE WHEN COUNT(DISTINCT e.reasoning_effort) = 1 THEN MIN(e.reasoning_effort) ELSE 'mixed' END AS reasoning_effort,
      ${TOTAL_COLUMNS} FROM codex_usage_events e ${where.sql} GROUP BY e.session_id
      ORDER BY ended_at DESC LIMIT ?`).all(...where.values, Math.max(1, Math.min(500, limit))) as Row[]
    const allowance = await this.weeklyCreditAllowance()
    return rows.map(row => this.sessionUsageFromRow(row, allowance))
  }

  async sessionUsage(sessionId: string): Promise<SessionUsage | undefined> {
    const db = await this.database()
    const row = db.prepare(`SELECT e.session_id, MIN(e.timestamp - e.duration_ms) AS started_at,
      MAX(e.timestamp) AS ended_at,
      CASE WHEN COUNT(DISTINCT e.provider) = 1 THEN MIN(e.provider) ELSE 'mixed' END AS provider,
      CASE WHEN COUNT(DISTINCT e.model) = 1 THEN MIN(e.model) ELSE 'Mixed' END AS model,
      CASE WHEN COUNT(DISTINCT e.model_family) = 1 THEN MIN(e.model_family) ELSE 'mixed' END AS model_family,
      CASE WHEN COUNT(DISTINCT e.reasoning_effort) = 1 THEN MIN(e.reasoning_effort) ELSE 'mixed' END AS reasoning_effort,
      ${TOTAL_COLUMNS} FROM codex_usage_events e WHERE e.session_id = ? AND e.total_tokens > 0 GROUP BY e.session_id`)
      .get(sessionId) as Row | undefined
    return row === undefined ? undefined : this.sessionUsageFromRow(row, await this.weeklyCreditAllowance())
  }

  private sessionUsageFromRow(row: Row, allowance: number | null): SessionUsage {
    const startedAt = number(row, 'started_at')
    const endedAt = number(row, 'ended_at')
    const aggregate = totals(row)
    return {
      sessionId: text(row, 'session_id'), startedAt, endedAt,
      durationMs: Math.max(0, endedAt - startedAt), provider: text(row, 'provider'), model: text(row, 'model'),
      modelFamily: text(row, 'model_family') as CodexModelFamily | 'mixed',
      reasoningEffort: text(row, 'reasoning_effort'),
      weeklyShare: allowance === null || aggregate.credits === null ? null : aggregate.credits / allowance * 100,
      ...aggregate,
    }
  }
  async taskDetail(taskId: string): Promise<TaskDetail | undefined> {
    const db = await this.database()
    const rows = db.prepare('SELECT * FROM codex_usage_events WHERE task_id = ? AND total_tokens > 0 ORDER BY timestamp, request_id')
      .all(taskId) as Row[]
    if (rows.length === 0) return undefined
    const [aggregate] = await this.taskAggregate(taskId)
    return aggregate === undefined ? undefined : { ...aggregate, events: rows.map(eventFromRow) }
  }

  private async taskAggregate(taskId: string): Promise<TaskUsage[]> {
    const db = await this.database()
    const row = db.prepare(`SELECT e.task_id, MIN(e.session_id) AS session_id,
      MIN(e.timestamp - e.duration_ms) AS started_at, MAX(e.timestamp) AS ended_at,
      CASE WHEN COUNT(DISTINCT e.provider) = 1 THEN MIN(e.provider) ELSE 'mixed' END AS provider,
      CASE WHEN COUNT(DISTINCT e.model) = 1 THEN MIN(e.model) ELSE 'Mixed' END AS model,
      CASE WHEN COUNT(DISTINCT e.model_family) = 1 THEN MIN(e.model_family) ELSE 'mixed' END AS model_family,
      CASE WHEN COUNT(DISTINCT e.reasoning_effort) = 1 THEN MIN(e.reasoning_effort) ELSE 'mixed' END AS reasoning_effort,
      ${TOTAL_COLUMNS} FROM codex_usage_events e WHERE e.task_id = ? AND e.total_tokens > 0 GROUP BY e.task_id`).get(taskId) as Row | undefined
    if (row === undefined) return []
    const aggregate = totals(row)
    const credits = aggregate.credits
    const allowance = await this.weeklyCreditAllowance()
    const startedAt = number(row, 'started_at')
    const endedAt = number(row, 'ended_at')
    return [{
      taskId, sessionId: text(row, 'session_id'), startedAt, endedAt,
      durationMs: Math.max(0, endedAt - startedAt), provider: text(row, 'provider'), model: text(row, 'model'),
      modelFamily: text(row, 'model_family') as CodexModelFamily | 'mixed',
      reasoningEffort: text(row, 'reasoning_effort'),
      weeklyShare: allowance === null || credits === null ? null : credits / allowance * 100,
      ...aggregate,
    }]
  }

  async latestTask(): Promise<TaskDetail | undefined> {
    const db = await this.database()
    const row = db.prepare('SELECT task_id FROM codex_usage_events WHERE total_tokens > 0 ORDER BY timestamp DESC LIMIT 1').get() as Row | undefined
    return row === undefined ? undefined : this.taskDetail(text(row, 'task_id'))
  }

  async rateHistory(): Promise<CreditRate[]> {
    const db = await this.database()
    const rows = db.prepare('SELECT * FROM codex_credit_rates ORDER BY effective_from DESC').all() as Row[]
    return rows.map(row => ({
      id: text(row, 'id'), model: text(row, 'model'), inputRate: number(row, 'input_rate'),
      cachedInputRate: number(row, 'cached_input_rate'), outputRate: number(row, 'output_rate'),
      ...nullableNumber(row, 'fast_multiplier') === null ? {} : { fastMultiplier: nullableNumber(row, 'fast_multiplier') ?? undefined },
      effectiveFrom: number(row, 'effective_from'),
      ...nullableNumber(row, 'effective_until') === null ? {} : { effectiveUntil: nullableNumber(row, 'effective_until') ?? undefined },
      source: text(row, 'source'),
    }))
  }

  async saveQuota(usage: OpenAICodexUsage, timestamp = Date.now()): Promise<void> {
    const db = await this.database()
    const insert = db.prepare(`INSERT OR REPLACE INTO codex_quota_snapshots
      (timestamp, quota_id, quota_name, window_seconds, used_percent, remaining_percent,
       used_credits, remaining_credits, total_credits, reset_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const limit of usage.rateLimits) {
      for (const window of limit.windows) {
        insert.run(timestamp, limit.id, limit.name ?? null, window.windowSeconds,
          100 - window.remainingPercent, window.remainingPercent,
          window.usedCredits ?? null, window.remainingCredits ?? null, window.totalCredits ?? null,
          window.resetAt ?? null)
      }
    }
  }

  async latestQuota(): Promise<QuotaSnapshot[]> {
    const db = await this.database()
    const rows = db.prepare(`SELECT q.* FROM codex_quota_snapshots q JOIN (
      SELECT quota_id, window_seconds, MAX(timestamp) AS timestamp FROM codex_quota_snapshots
      GROUP BY quota_id, window_seconds
    ) latest ON latest.quota_id=q.quota_id AND latest.window_seconds=q.window_seconds AND latest.timestamp=q.timestamp
      ORDER BY q.quota_id, q.window_seconds DESC`).all() as Row[]
    return rows.map(row => ({
      timestamp: number(row, 'timestamp'), quotaId: text(row, 'quota_id'),
      ...text(row, 'quota_name') === '' ? {} : { quotaName: text(row, 'quota_name') },
      windowSeconds: number(row, 'window_seconds'), usedPercent: number(row, 'used_percent'),
      remainingPercent: number(row, 'remaining_percent'),
      ...nullableNumber(row, 'used_credits') === null ? {} : { usedCredits: nullableNumber(row, 'used_credits') ?? undefined },
      ...nullableNumber(row, 'remaining_credits') === null ? {} : { remainingCredits: nullableNumber(row, 'remaining_credits') ?? undefined },
      ...nullableNumber(row, 'total_credits') === null ? {} : { totalCredits: nullableNumber(row, 'total_credits') ?? undefined },
      ...nullableNumber(row, 'reset_at') === null ? {} : { resetAt: nullableNumber(row, 'reset_at') ?? undefined },
    }))
  }

  async weeklyCreditAllowance(): Promise<number | null> {
    const snapshots = await this.latestQuota()
    const exact = snapshots.find(snapshot => snapshot.quotaId === 'codex' && snapshot.windowSeconds === 604_800 && snapshot.totalCredits !== undefined)
    return exact?.totalCredits ?? null
  }
}

export interface UsageTrackerSnapshot {
  currentTaskId?: string
  active: boolean
  revision: number
}

/** Runtime task correlation and notifications; durable numbers always come back from the ledger. */
export class CodexUsageTracker {
  private readonly contexts = new Map<string, UsageCorrelation>()
  private currentTaskId: string | undefined
  private active = false
  private revision = 0
  private readonly listeners = new Set<(snapshot: UsageTrackerSnapshot) => void>()

  constructor(readonly ledger: CodexUsageLedger = new CodexUsageLedger()) {}

  noteStep(sessionId: string, turn: number, step: number): UsageCorrelation {
    const taskId = `${sessionId}:turn:${turn}`
    const correlation: UsageCorrelation = {
      taskId,
      sessionId,
      conversationId: sessionId,
      runId: taskId,
      step,
    }
    this.contexts.set(sessionId, correlation)
    this.currentTaskId = taskId
    this.active = true
    this.notify()
    return correlation
  }

  finishTask(sessionId: string, turn: number): void {
    const taskId = `${sessionId}:turn:${turn}`
    if (this.currentTaskId === taskId) this.active = false
    this.notify()
  }

  correlation(sessionId: string | undefined, requestId: string, purpose?: string): UsageCorrelation {
    if (sessionId !== undefined && purpose === undefined) {
      const tracked = this.contexts.get(sessionId)
      if (tracked !== undefined) return tracked
    }
    const session = sessionId ?? 'standalone'
    return {
      taskId: `${session}:${purpose ?? 'request'}:${requestId}`,
      sessionId: session,
      conversationId: session,
      runId: requestId,
    }
  }

  async record(input: RecordCodexUsage): Promise<CodexUsageEvent | undefined> {
    const event = await this.ledger.record(input)
    if (event === undefined) return undefined
    this.currentTaskId = event.taskId
    this.notify()
    return event
  }

  snapshot(): UsageTrackerSnapshot {
    return {
      ...this.currentTaskId === undefined ? {} : { currentTaskId: this.currentTaskId },
      active: this.active,
      revision: this.revision,
    }
  }

  subscribe(listener: (snapshot: UsageTrackerSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Notify live HUD clients after a non-ledger presentation setting changes. */
  refresh(): void {
    this.notify()
  }

  async currentTask(): Promise<TaskDetail | undefined> {
    if (this.currentTaskId === undefined) return this.ledger.latestTask()
    const current = await this.ledger.taskDetail(this.currentTaskId)
    return current ?? (this.active ? undefined : this.ledger.latestTask())
  }

  private notify(): void {
    this.revision++
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
