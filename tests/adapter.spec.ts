import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { usageCorrelationFor } from '../src/adapter.ts'
import type { UsageCorrelation } from '../src/usage-ledger.ts'

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
