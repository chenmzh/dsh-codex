import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { OpenAICodexCredentialStore } from '../src/store.ts'
import { OPENAI_CODEX_PROVIDER } from '../src/store.ts'
import {
  usageCorrelationFor,
  createOpenAICodexAdapter,
  OPENAI_CODEX_RETRY_POLICY,
} from '../src/adapter.ts'
import { Config } from '../src/index.ts'
import type { UsageCorrelation } from '../src/usage-ledger.ts'

describe('OpenAI Codex adapter policy', () => {
  it('distinguishes an omitted model list from an explicitly empty list', () => {
    expect(Config({}).models).toBeUndefined()
    expect(Config({ models: [] }).models).toEqual([])
  })

  it('registers the extended bounded retry policy on the provider route', () => {
    const adapter = createOpenAICodexAdapter(
      {} as OpenAICodexCredentialStore,
      () => undefined,
      () => ({ reasoningSummary: 'auto', useWebSocketContextReuse: false, useNativeCompaction: false }),
    )

    expect(adapter.providerRetryPolicy(OPENAI_CODEX_PROVIDER)).toBe(OPENAI_CODEX_RETRY_POLICY)
    expect(OPENAI_CODEX_RETRY_POLICY).toMatchObject({
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: expect.arrayContaining(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitterRatio: 0.2,
    })
  })

  it('advertises only configured models while keeping hidden models resolvable', async () => {
    const adapter = createOpenAICodexAdapter(
      {} as OpenAICodexCredentialStore,
      () => undefined,
      () => ({ reasoningSummary: 'auto', useWebSocketContextReuse: false, useNativeCompaction: false }),
      undefined,
      () => ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-terra'],
    )

    const models = await adapter.listModels(OPENAI_CODEX_PROVIDER)
    expect(models.map(model => model.id)).toEqual(['gpt-5.6-luna', 'gpt-5.6-terra'])

    await expect(adapter.resolveModel(OPENAI_CODEX_PROVIDER, 'gpt-5.4')).resolves.toMatchObject({
      provider: OPENAI_CODEX_PROVIDER,
      id: 'gpt-5.4',
    })
  })

  it('advertises the full provider catalog when no model list is configured', async () => {
    const adapter = createOpenAICodexAdapter(
      {} as OpenAICodexCredentialStore,
      () => undefined,
      () => ({ reasoningSummary: 'auto', useWebSocketContextReuse: false, useNativeCompaction: false }),
    )

    const models = await adapter.listModels(OPENAI_CODEX_PROVIDER)
    expect(models.map(model => model.id)).toEqual(expect.arrayContaining([
      'gpt-5.4',
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
    ]))
  })
})

interface UsageTaggedOptions extends GenerateOptions {
  usageSessionId?: string
  usagePurpose?: string
}

describe('OpenAI Codex usage correlation', () => {
  it('uses usage-only session metadata without a provider session identity', () => {
    const correlation: UsageCorrelation = {
      taskId: 'session-a:sol-advisory:request-1',
      sessionId: 'session-a',
      conversationId: 'session-a',
    }
    const usageTracker = {
      correlation: vi.fn(() => correlation),
    } as Pick<Parameters<typeof usageCorrelationFor>[2], 'correlation'>
    const options = {
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      messages: [],
      usageSessionId: 'session-a',
      usagePurpose: 'sol-advisory',
    } as UsageTaggedOptions

    expect(usageCorrelationFor(options, 'request-1', usageTracker)).toBe(correlation)
    expect(usageTracker.correlation).toHaveBeenCalledWith('session-a', 'request-1', 'sol-advisory')
    expect(options.sessionId).toBeUndefined()
  })

  it('keeps ordinary request correlation unchanged', () => {
    const usageTracker = {
      correlation: vi.fn((): UsageCorrelation => ({
        taskId: 'task-1',
        sessionId: 'session-a',
        conversationId: 'session-a',
      })),
    } as Pick<Parameters<typeof usageCorrelationFor>[2], 'correlation'>
    const options = {
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      messages: [],
      sessionId: 'session-a' as GenerateOptions['sessionId'],
      purpose: 'compaction',
    } as GenerateOptions

    usageCorrelationFor(options, 'request-2', usageTracker)
    expect(usageTracker.correlation).toHaveBeenCalledWith('session-a', 'request-2', 'compaction')
  })
})
