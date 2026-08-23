import type { QuotaSnapshot, SessionUsage, TaskUsage, UsageBreakdownRow, UsageTimePoint, UsageTotals } from '../usage-ledger.ts'

export interface AnalyticsPayload {
  summary: UsageTotals
  timeseries: UsageTimePoint[]
  providers?: UsageBreakdownRow[]
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
  providers?: string[]
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

export function isUsageSelection(selection: ModelSelectionSnapshot['current']): boolean {
  return selection !== null && selection.provider.length > 0 && selection.model.length > 0
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
    provider: row.provider,
    modelFamily: row.modelFamily,
    reasoningEffort: row.reasoningEffort,
    ...'taskId' in row ? { taskId: row.taskId } : {},
  }))
  return {
    schemaVersion: 2,
    generatedAt: new Date(generatedAt).toISOString(),
    filters: {
      range: filters.range,
      models: [...filters.models],
      reasoning: [...filters.reasoning],
      providers: [...(filters.providers ?? [])],
      visualizationMetric: filters.metric ?? 'tokens',
      ...filters.range === 'custom' && filters.start !== '' ? { start: new Date(filters.start).toISOString() } : {},
      ...filters.range === 'custom' && filters.end !== '' ? { end: new Date(filters.end + 'T23:59:59.999').toISOString() } : {},
    },
    summary: visibleTotals(data.summary),
    usageOverTime: data.timeseries.map(point => ({
      timestamp: point.timestamp,
      time: new Date(point.timestamp).toISOString(),
      provider: point.provider,
      tokens: point.tokens,
      requests: point.requests,
    })),
    modelBreakdown: breakdown(data.models),
    reasoningBreakdown: breakdown(data.reasoning),
    thisWeek: { summary: visibleTotals(data.weekly), modelBreakdown: breakdown(data.weeklyModels) },
    providerBreakdown: breakdown(data.providers ?? []),
    recentTasks: aggregate(data.tasks),
    sessions: aggregate(data.sessions),
  }
}
