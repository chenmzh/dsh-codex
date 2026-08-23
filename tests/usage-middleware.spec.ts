import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { captureProviderUsage } from '../src/usage-middleware.ts'
import { CodexUsageLedger, CodexUsageTracker } from '../src/usage-ledger.ts'

const ledgers: CodexUsageLedger[] = []

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close()
})

async function tracker(): Promise<CodexUsageTracker> {
  const ledger = new CodexUsageLedger(':memory:')
  await ledger.open()
  ledgers.push(ledger)
  return new CodexUsageTracker(ledger)
}

async function drain(
  usageTracker: CodexUsageTracker,
  provider: string,
  model: string,
  sessionId: string,
  usage: TokenUsage,
  requestId: string,
): Promise<StreamChunk[]> {
  const chunk: StreamChunk = { type: 'usage', usage }
  const options = {
    provider,
    model,
    messages: [],
    sessionId: sessionId as GenerateOptions['sessionId'],
  } as GenerateOptions
  async function* source(): AsyncIterable<StreamChunk> {
    yield chunk
  }
  const output: StreamChunk[] = []
  for await (const item of captureProviderUsage(options, source, usageTracker, {
    now: () => 1_000,
    requestId: () => requestId,
  })) output.push(item)
  return output
}

describe('provider-neutral session usage middleware', () => {
  it('records normalized DeepSeek, OpenCode Go, and Kimi usage in one session ledger', async () => {
    const usageTracker = await tracker()

    expect(await drain(
      usageTracker,
      'deepseek',
      'deepseek-reasoner',
      'session-deepseek',
      { inputTokens: 60, cacheReadTokens: 40, outputTokens: 20, reasoningTokens: 15 },
      'request-deepseek',
    )).toEqual([{ type: 'usage', usage: { inputTokens: 60, cacheReadTokens: 40, outputTokens: 20, reasoningTokens: 15 } }])
    await drain(
      usageTracker,
      'opencode-go',
      'deepseek-v4-flash',
      'session-opencode',
      { inputTokens: 10, outputTokens: 3 },
      'request-opencode',
    )
    await drain(
      usageTracker,
      'kimi-coding',
      'kimi-k2.5',
      'session-kimi',
      { inputTokens: 7, outputTokens: 5 },
      'request-kimi',
    )

    expect(await usageTracker.ledger.sessionUsage('session-deepseek')).toMatchObject({
      provider: 'deepseek', model: 'deepseek-reasoner', inputTokens: 100,
      cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 15, totalTokens: 120,
    })
    expect(await usageTracker.ledger.sessionUsage('session-opencode')).toMatchObject({
      provider: 'opencode-go', model: 'deepseek-v4-flash', totalTokens: 13,
    })
    expect(await usageTracker.ledger.sessionUsage('session-kimi')).toMatchObject({
      provider: 'kimi-coding', model: 'kimi-k2.5', totalTokens: 12,
    })
    expect(await usageTracker.ledger.breakdown('provider', { range: 'all' })).toMatchObject([
      { key: 'deepseek', totalTokens: 120 },
      { key: 'opencode-go', totalTokens: 13 },
      { key: 'kimi-coding', totalTokens: 12 },
    ])
  })
})
