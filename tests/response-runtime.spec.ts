import { describe, expect, it } from 'vitest'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  SimpleStreamOptions,
  Transport,
} from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { OpenAICodexResponseRuntime } from '../src/responses.ts'

function runtimeHarness(initialReuse: boolean, initialSummary: 'auto' | 'concise' | 'detailed' = 'auto') {
  let reuse = initialReuse
  let reasoningSummary = initialSummary
  const transports: Array<Transport | undefined> = []
  const streamOptions: SimpleStreamOptions[] = []
  const sources: AssistantMessageEventStream[] = []
  const base = openaiCodexProvider()
  const provider = {
    ...base,
    streamSimple: (_model, _context, options?: SimpleStreamOptions) => {
      transports.push(options?.transport)
      if (options !== undefined) streamOptions.push(options)
      const source = createAssistantMessageEventStream()
      sources.push(source)
      return source
    },
  } satisfies typeof base
  const runtime = new OpenAICodexResponseRuntime(() => ({
    reasoningSummary,
    useWebSocketContextReuse: reuse,
    useNativeCompaction: false,
  }))
  const wrapped = runtime.wrap(provider)
  const model = base.getModels().find(candidate => candidate.id === 'gpt-5.6-sol')
    ?? base.getModels()[0]
  if (model === undefined) throw new Error('Codex provider has no test model')
  const call = (sessionId: string): AssistantMessageEventStream => (
    wrapped.streamSimple(model, { messages: [] }, { sessionId })
  )
  return {
    sources,
    transports,
    streamOptions,
    runtime,
    model,
    call,
    setReuse(value: boolean): void { reuse = value },
    setReasoningSummary(value: 'auto' | 'concise' | 'detailed'): void { reasoningSummary = value },
  }
}

function failedMessage(message: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: message,
    timestamp: Date.now(),
  }
}

describe('OpenAICodexResponseRuntime transport policy', () => {
  it('uses explicit SSE while context reuse is disabled', () => {
    const harness = runtimeHarness(false)

    harness.call('session-sse')

    expect(harness.transports).toEqual(['sse'])
  })

  it('delegates matching continuation state to pi-ai WebSocket caching', () => {
    const harness = runtimeHarness(true)

    harness.call('session-websocket')

    expect(harness.transports).toEqual(['websocket-cached'])
  })

  it('preserves the provider-owned store:false payload', async () => {
    const harness = runtimeHarness(true)
    harness.call('session-store-false')

    const transformed = await harness.streamOptions[0]?.onPayload?.({ store: false, input: [] }, harness.model)

    expect(transformed).toEqual({ store: false, input: [] })
  })

  it('rewrites each generated payload to the selected reasoning summary detail', async () => {
    const harness = runtimeHarness(false, 'detailed')

    harness.call('session-detailed-summary')
    harness.setReasoningSummary('concise')
    harness.call('session-concise-summary')

    const detailed = await harness.streamOptions[0]?.onPayload?.(
      { input: [], reasoning: { effort: 'high', summary: 'auto' } },
      harness.model,
    )
    const concise = await harness.streamOptions[1]?.onPayload?.(
      { input: [], reasoning: { effort: 'high', summary: 'auto' } },
      harness.model,
    )

    expect(detailed).toMatchObject({ reasoning: { effort: 'high', summary: 'detailed' } })
    expect(concise).toMatchObject({ reasoning: { effort: 'high', summary: 'concise' } })
  })

  it('keeps Harness compaction calls off the conversation WebSocket chain', () => {
    const harness = runtimeHarness(true)
    const leaveCompaction = harness.runtime.enterCompaction('session-compact')

    harness.call('session-compact')
    leaveCompaction()
    harness.call('session-compact')

    expect(harness.transports).toEqual(['sse', 'websocket-cached'])
  })

  it('applies live preference changes without retaining plugin continuation state', () => {
    const harness = runtimeHarness(false)

    harness.call('session-live')
    harness.setReuse(true)
    harness.call('session-live')
    harness.setReuse(false)
    harness.call('session-live')

    expect(harness.transports).toEqual(['sse', 'websocket-cached', 'sse'])
  })

  it('normalizes numeric WebSocket closes for durable transport retry', async () => {
    const harness = runtimeHarness(true)
    const result = harness.call('session-websocket-close')

    harness.sources[0]?.push({
      type: 'error',
      reason: 'error',
      error: failedMessage('WebSocket closed 1006'),
    })

    const events = []
    for await (const event of result) events.push(event)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'error',
      error: { errorMessage: 'WebSocket connection closed 1006' },
    })
  })

  it('does not relabel unrelated provider failures', async () => {
    const harness = runtimeHarness(true)
    const result = harness.call('session-provider-error')

    harness.sources[0]?.push({
      type: 'error',
      reason: 'error',
      error: failedMessage('WebSocket authorization failed'),
    })

    const events = []
    for await (const event of result) events.push(event)

    expect(events[0]).toMatchObject({
      type: 'error',
      error: { errorMessage: 'WebSocket authorization failed' },
    })
  })
})
