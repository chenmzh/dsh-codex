import { describe, expect, it } from 'vitest'
import { createUsageReport, isOpenAICodexSelection } from '../src/client/usage-ui-data.ts'
import type { UsageTotals } from '../src/usage-ledger.ts'

const totals = (overrides: Partial<UsageTotals> = {}): UsageTotals => ({
  inputTokens: 100,
  cachedInputTokens: 40,
  outputTokens: 20,
  reasoningTokens: 10,
  totalTokens: 120,
  credits: null,
  knownCredits: 0,
  unknownCreditRequests: 1,
  requests: 2,
  tasks: 1,
  sessions: 1,
  cacheHitRate: 0.4,
  averageCreditsPerTask: null,
  ...overrides,
})

describe('Codex usage UI data contracts', () => {
  it('shows the HUD only for the current session OpenAI Codex provider', () => {
    expect(isOpenAICodexSelection({ provider: 'openai-codex', model: 'gpt-5.6-sol' })).toBe(true)
    expect(isOpenAICodexSelection({ provider: 'anthropic', model: 'claude' })).toBe(false)
    expect(isOpenAICodexSelection({ provider: 'other-codex-like', model: 'gpt-5.6-sol' })).toBe(false)
    expect(isOpenAICodexSelection(null)).toBe(false)
  })

  it('exports the current filtered panel without removed credit fields', () => {
    const base = totals()
    const task = {
      ...base,
      taskId: 'task-1',
      sessionId: 'session-1',
      startedAt: 1_000,
      endedAt: 2_000,
      durationMs: 1_000,
      model: 'gpt-5.6-sol',
      modelFamily: 'sol' as const,
      reasoningEffort: 'max',
      weeklyShare: null,
    }
    const session = { ...task, taskId: undefined }
    const report = createUsageReport({
      summary: base,
      timeseries: [{ timestamp: 1_000, modelFamily: 'sol', tokens: 120, credits: null, unknownCreditRequests: 1, requests: 2 }],
      models: [{ key: 'sol', label: 'Sol', ...base }],
      reasoning: [{ key: 'max', label: 'max', ...base }],
      tasks: [task],
      sessions: [session],
      quota: [{ timestamp: 1_000, quotaId: 'codex', windowSeconds: 604_800, usedPercent: 36, remainingPercent: 64, resetAt: 3_000 }],
      weekly: base,
      weeklyModels: [{ key: 'sol', label: 'Sol', ...base }],
    }, { range: '7d', models: ['sol'], reasoning: ['max'], start: '', end: '' }, 1_700_000_000_000)

    expect(report.filters).toEqual({ range: '7d', models: ['sol'], reasoning: ['max'], visualizationMetric: 'tokens' })
    expect(report.summary).toMatchObject({ totalTokens: 120, requests: 2 })
    expect(report.usageOverTime[0]).toMatchObject({ modelFamily: 'sol', tokens: 120 })
    expect(report.accountQuota[0]).toMatchObject({ usedPercent: 36, remainingPercent: 64 })
    expect(JSON.stringify(report)).not.toMatch(/credit/i)
    expect(JSON.stringify(report)).not.toContain('weeklyShare')
  })
})
