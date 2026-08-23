/** Provider-neutral request usage capture over DSH's normalized LLM stream. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { usageCorrelationFor } from './adapter.ts'
import type { CodexUsageTracker } from './usage-ledger.ts'

interface ProviderUsageExtensions {
  serverCredits?: unknown
  credits?: unknown
}

export interface UsageCaptureInternals {
  now?: () => number
  requestId?: () => string
}

/**
 * Record the one normalized usage chunk emitted by any DSH provider adapter.
 * The observer yields every chunk unchanged and never turns persistence failure
 * into a model-call failure.
 */
export async function* captureProviderUsage(
  options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>,
  tracker: CodexUsageTracker,
  internals: UsageCaptureInternals = {},
): AsyncIterable<StreamChunk> {
  const now = internals.now ?? Date.now
  const requestId = (internals.requestId ?? randomUUID)()
  const startedAt = now()
  let usageRecorded = false
  for await (const chunk of next()) {
    if (chunk.type === 'usage' && !usageRecorded) {
      usageRecorded = true
      const providerUsage = chunk.usage as typeof chunk.usage & ProviderUsageExtensions
      const directCredits = typeof providerUsage.serverCredits === 'number'
        ? providerUsage.serverCredits
        : typeof providerUsage.credits === 'number' ? providerUsage.credits : undefined
      await tracker.record({
        requestId,
        durationMs: Math.max(0, now() - startedAt),
        correlation: usageCorrelationFor(options, requestId, tracker),
        provider: options.provider,
        model: options.model,
        ...options.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: String(options.reasoningEffort) },
        ...directCredits === undefined || !Number.isFinite(directCredits) || directCredits < 0
          ? {}
          : { serverCredits: directCredits },
        usage: chunk.usage,
      }).catch((error: unknown) => {
        process.emitWarning(
          `dsh-usage: failed to persist ${options.provider}/${options.model} usage: `
          + (error instanceof Error ? error.message : String(error)),
        )
      })
    }
    yield chunk
  }
}

/** Install one capture layer for every provider except routes tracked internally. */
export function installProviderUsageTracking(
  ctx: Context,
  tracker: CodexUsageTracker,
  internallyTrackedProviders: ReadonlySet<string> = new Set(),
): void {
  ctx.on('llm/stream', (options, next) => internallyTrackedProviders.has(options.provider)
    ? next()
    : captureProviderUsage(options, next, tracker))
}
