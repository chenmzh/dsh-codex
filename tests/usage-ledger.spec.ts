import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyCodexModel,
  CodexUsageLedger,
  CodexUsageTracker,
} from '../src/usage-ledger.ts'

let root: string | undefined
const openLedgers: CodexUsageLedger[] = []

afterEach(async () => {
  for (const ledger of openLedgers.splice(0)) ledger.close()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function ledger(): Promise<CodexUsageLedger> {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-codex-ledger-'))
  const value = new CodexUsageLedger(join(root, 'usage.sqlite3'))
  await value.open()
  openLedgers.push(value)
  return value
}

function correlation(taskId: string, sessionId = 'session-a', step = 1) {
  return { taskId, sessionId, conversationId: sessionId, runId: taskId, step }
}

describe('Codex usage ledger', () => {
  it('keeps cached input and reasoning as subsets without double counting', async () => {
    const value = await ledger()
    await value.record({
      timestamp: 1_000,
      requestId: 'request-1',
      correlation: correlation('task-1'),
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
      usage: { inputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 20, outputTokens: 80, reasoningTokens: 60 },
    })
    const summary = await value.summary({ range: 'all' })
    expect(summary).toMatchObject({
      inputTokens: 520,
      cachedInputTokens: 400,
      outputTokens: 80,
      reasoningTokens: 60,
      totalTokens: 600,
      requests: 1,
      tasks: 1,
      credits: null,
      unknownCreditRequests: 1,
    })
    const detail = await value.taskDetail('task-1')
    expect(detail?.events[0]).toMatchObject({ modelFamily: 'sol', reasoningEffort: 'max', totalTokens: 600 })
    expect(detail?.totalTokens).toBe(summary.totalTokens)
  })

  it('aggregates multiple requests by task and isolates concurrent sessions', async () => {
    const tracker = new CodexUsageTracker(await ledger())
    const taskA = tracker.noteStep('session-a', 2, 1)
    const taskB = tracker.noteStep('session-b', 4, 1)
    await Promise.all([
      tracker.record({ requestId: 'a1', timestamp: 2_000, correlation: taskA, model: 'gpt-5.6-terra', reasoningEffort: 'high', usage: { inputTokens: 10, outputTokens: 2 } }),
      tracker.record({ requestId: 'b1', timestamp: 2_001, correlation: taskB, model: 'gpt-5.6-luna', reasoningEffort: 'medium', usage: { inputTokens: 20, outputTokens: 3 } }),
      tracker.record({ requestId: 'a2', timestamp: 2_002, correlation: { ...taskA, step: 2 }, model: 'gpt-5.6-terra', reasoningEffort: 'high', usage: { inputTokens: 30, outputTokens: 4 } }),
    ])
    expect(await tracker.ledger.taskDetail('session-a:turn:2')).toMatchObject({ requests: 2, totalTokens: 46, sessionId: 'session-a' })
    expect(await tracker.ledger.taskDetail('session-b:turn:4')).toMatchObject({ requests: 1, totalTokens: 23, sessionId: 'session-b' })
    expect(await tracker.ledger.sessionUsage('session-a')).toMatchObject({ requests: 2, totalTokens: 46, tasks: 1, sessionId: 'session-a', model: 'gpt-5.6-terra', reasoningEffort: 'high' })
    expect(await tracker.ledger.sessionUsage('session-b')).toMatchObject({ requests: 1, totalTokens: 23, tasks: 1, sessionId: 'session-b', model: 'gpt-5.6-luna', reasoningEffort: 'medium' })
  })

  it('freezes credits against the rate version effective at request time', async () => {
    const value = await ledger()
    await value.addRate({ id: 'sol-v1', model: 'gpt-5.6-sol', inputRate: 1, cachedInputRate: 0.1, outputRate: 2, effectiveFrom: 1_000, effectiveUntil: 2_000, source: 'test-v1' })
    await value.addRate({ id: 'sol-v2', model: 'gpt-5.6-sol', inputRate: 2, cachedInputRate: 0.2, outputRate: 4, effectiveFrom: 2_000, source: 'test-v2' })
    const first = await value.record({ timestamp: 1_500, requestId: 'old', correlation: correlation('old-task'), model: 'gpt-5.6-sol', usage: { inputTokens: 10, cacheReadTokens: 10, outputTokens: 5 } })
    const second = await value.record({ timestamp: 2_500, requestId: 'new', correlation: correlation('new-task'), model: 'gpt-5.6-sol', usage: { inputTokens: 10, cacheReadTokens: 10, outputTokens: 5 } })
    expect(first).toMatchObject({ rateCardId: 'sol-v1', calculatedCredits: 21, creditSource: 'calculated' })
    expect(second).toMatchObject({ rateCardId: 'sol-v2', calculatedCredits: 42, creditSource: 'calculated' })
    await value.addRate({ id: 'sol-v3', model: 'gpt-5.6-sol', inputRate: 99, cachedInputRate: 99, outputRate: 99, effectiveFrom: 3_000, source: 'future' })
    expect((await value.taskDetail('old-task'))?.credits).toBe(21)
  })

  it('prefers server credits and leaves unknown models auditable', async () => {
    const value = await ledger()
    await value.addRate({ id: 'known', model: 'gpt-5.6-sol', inputRate: 100, cachedInputRate: 100, outputRate: 100, effectiveFrom: 0, source: 'test' })
    const server = await value.record({ timestamp: 1, requestId: 'server', correlation: correlation('server-task'), model: 'gpt-5.6-sol', serverCredits: 1.234567, usage: { inputTokens: 1, outputTokens: 1 } })
    const unknown = await value.record({ timestamp: 2, requestId: 'unknown', correlation: correlation('unknown-task'), model: 'gpt-6-nova', usage: { inputTokens: 2, outputTokens: 3 } })
    expect(server).toMatchObject({ serverCredits: 1.234567, creditSource: 'server' })
    expect(server).not.toHaveProperty('calculatedCredits')
    expect(unknown).toMatchObject({ modelFamily: 'other', creditSource: 'unknown', totalTokens: 5 })
    expect((await value.summary({ range: 'all' })).credits).toBeNull()
  })

  it('applies time/model/reasoning filters to every backend aggregation', async () => {
    const value = await ledger()
    await value.record({ timestamp: 1_000, requestId: 'sol', correlation: correlation('sol-task'), model: 'gpt-5.6-sol', reasoningEffort: 'max', serverCredits: 2, usage: { inputTokens: 10, outputTokens: 1 } })
    await value.record({ timestamp: 2_000, requestId: 'terra', correlation: correlation('terra-task'), model: 'gpt-5.6-terra', reasoningEffort: 'high', serverCredits: 3, usage: { inputTokens: 20, outputTokens: 2 } })
    const filters = { range: 'custom' as const, start: 500, end: 1_500, models: ['sol'], reasoning: ['max'] }
    expect(await value.summary(filters)).toMatchObject({ totalTokens: 11, credits: 2, requests: 1, tasks: 1 })
    expect(await value.breakdown('model_family', filters)).toHaveLength(1)
    expect(await value.usageOverTime(filters)).toHaveLength(1)
    expect(await value.tasks(filters)).toHaveLength(1)
    expect(await value.sessions(filters)).toMatchObject([{ sessionId: 'session-a', totalTokens: 11, requests: 1 }])
  })

  it('calculates weekly share only with an exact server denominator and survives restart', async () => {
    const value = await ledger()
    await value.record({ timestamp: 1_000, requestId: 'weekly', correlation: correlation('weekly-task'), model: 'gpt-5.6-luna', serverCredits: 5, usage: { inputTokens: 5, outputTokens: 5 } })
    await value.saveQuota({ rateLimits: [{ id: 'codex', windows: [{ windowSeconds: 604_800, remainingPercent: 71 }] }] }, 2_000)
    expect((await value.taskDetail('weekly-task'))?.weeklyShare).toBeNull()
    await value.saveQuota({ rateLimits: [{ id: 'codex', windows: [{ windowSeconds: 604_800, remainingPercent: 70, totalCredits: 1_000 }] }] }, 3_000)
    expect((await value.taskDetail('weekly-task'))?.weeklyShare).toBe(0.5)
    const filename = value.filename
    value.close()
    const reopened = new CodexUsageLedger(filename)
    openLedgers.push(reopened)
    expect(await reopened.taskDetail('weekly-task')).toMatchObject({ totalTokens: 10, credits: 5, weeklyShare: 0.5 })
  })

  it('classifies Sol, Terra, Luna, and future models dynamically', () => {
    expect(classifyCodexModel('gpt-5.6-sol')).toBe('sol')
    expect(classifyCodexModel('GPT_5.6_TERRA')).toBe('terra')
    expect(classifyCodexModel('codex.luna.fast')).toBe('luna')
    expect(classifyCodexModel('gpt-6-nova')).toBe('other')
  })

  it('switches the HUD aggregate on task lifecycle and retains the completed task', async () => {
    const tracker = new CodexUsageTracker(await ledger())
    const first = tracker.noteStep('session-hud', 1, 1)
    expect(await tracker.currentTask()).toBeUndefined()
    await tracker.record({ requestId: 'hud-1', timestamp: 100, durationMs: 40, correlation: first, model: 'gpt-5.6-sol', reasoningEffort: 'max', serverCredits: 4, usage: { inputTokens: 8, outputTokens: 2 } })
    expect(await tracker.currentTask()).toMatchObject({ taskId: 'session-hud:turn:1', totalTokens: 10, credits: 4, durationMs: 40 })
    tracker.finishTask('session-hud', 1)
    expect(await tracker.currentTask()).toMatchObject({ taskId: 'session-hud:turn:1', totalTokens: 10 })
    tracker.noteStep('session-hud', 2, 1)
    expect(await tracker.currentTask()).toBeUndefined()
  })
})
