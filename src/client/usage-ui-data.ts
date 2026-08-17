import type { QuotaSnapshot, SessionUsage, TaskUsage, UsageBreakdownRow, UsageTimePoint, UsageTotals } from '../usage-ledger.ts'

export interface AnalyticsPayload {
  summary: UsageTotals
  timeseries: UsageTimePoint[]
  models: UsageBreakdownRow[]
  reasoning: UsageBreakdownRow[]
  tasks: TaskUsage[]
  sessions: SessionUsage[]
  quota: QuotaSnapshot[]
  weekly: UsageTotals
  weeklyModels: UsageBreakdownRow[]
}

interface ModelSelectionSnapshot {
  current: { provider: string; model: string; reasoningEffort?: string | undefined } | null
}
export interface CodexHudModelDirectory {
  readonly store: {
    getSnapshot(): ModelSelectionSnapshot
    subscribe(listener: () => void): () => void
  }
  load(): Promise<unknown>
}
export interface UsageReportFilters {
  range: string
  models: string[]
  reasoning: string[]
  start: string
  end: string
  metric?: 'tokens' | 'requests' | undefined
}

function visibleTotals(value: UsageTotals) {
  return {
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    outputTokens: value.outputTokens,
    reasoningTokens: value.reasoningTokens,
    totalTokens: value.totalTokens,
    requests: value.requests,
    tasks: value.tasks,
    sessions: value.sessions,
    cacheHitRate: value.cacheHitRate,
  }
}

export function isOpenAICodexSelection(selection: ModelSelectionSnapshot['current']): boolean {
  return selection?.provider === 'openai-codex'
}

export function createUsageReport(data: AnalyticsPayload, filters: UsageReportFilters, generatedAt = Date.now()) {
  const breakdown = (rows: UsageBreakdownRow[]) => rows.map(row => ({ key: row.key, label: row.label, ...visibleTotals(row) }))
  const aggregate = (rows: Array<TaskUsage | SessionUsage>) => rows.map(row => ({
    ...visibleTotals(row),
    sessionId: row.sessionId,
    startedAt: row.startedAt,
    startedAtIso: new Date(row.startedAt).toISOString(),
    endedAt: row.endedAt,
    endedAtIso: new Date(row.endedAt).toISOString(),
    durationMs: row.durationMs,
    model: row.model,
    modelFamily: row.modelFamily,
    reasoningEffort: row.reasoningEffort,
    ...'taskId' in row ? { taskId: row.taskId } : {},
  }))
  return {
    schemaVersion: 1,
    generatedAt: new Date(generatedAt).toISOString(),
    filters: {
      range: filters.range,
      models: [...filters.models],
      reasoning: [...filters.reasoning],
      visualizationMetric: filters.metric ?? 'tokens',
      ...filters.range === 'custom' && filters.start !== '' ? { start: new Date(filters.start).toISOString() } : {},
      ...filters.range === 'custom' && filters.end !== '' ? { end: new Date(filters.end + 'T23:59:59.999').toISOString() } : {},
    },
    summary: visibleTotals(data.summary),
    usageOverTime: data.timeseries.map(point => ({
      timestamp: point.timestamp,
      time: new Date(point.timestamp).toISOString(),
      modelFamily: point.modelFamily,
      tokens: point.tokens,
      requests: point.requests,
    })),
    modelBreakdown: breakdown(data.models),
    reasoningBreakdown: breakdown(data.reasoning),
    thisWeek: { summary: visibleTotals(data.weekly), modelBreakdown: breakdown(data.weeklyModels) },
    accountQuota: data.quota.map(item => ({
      timestamp: item.timestamp,
      time: new Date(item.timestamp).toISOString(),
      quotaId: item.quotaId,
      quotaName: item.quotaName ?? null,
      windowSeconds: item.windowSeconds,
      usedPercent: item.usedPercent,
      remainingPercent: item.remainingPercent,
      resetAt: item.resetAt ?? null,
      resetAtIso: item.resetAt === undefined ? null : new Date(item.resetAt).toISOString(),
    })),
    recentTasks: aggregate(data.tasks),
    sessions: aggregate(data.sessions),
  }
}
