/** OpenAI Codex adapter assembled from public dsh-llm-pi-ai extension points. */

import { randomUUID } from 'node:crypto'
import { createModels } from '@earendil-works/pi-ai'
import type { MutableModels, Provider } from '@earendil-works/pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { OpenAICodexCredentialStore } from './store.ts'
import { OPENAI_CODEX_PROVIDER } from './store.ts'
import { OpenAICodexResponseRuntime } from './responses.ts'
import type { ResponseApiPreferences } from './tool-policy.ts'
import { createOpenAICodexProvider } from './provider.ts'
import type { CodexUsageTracker } from './usage-ledger.ts'

/**
 * Usage-only correlation metadata for auxiliary calls.
 *
 * These fields are deliberately separate from GenerateOptions.sessionId: they
 * let a caller attach an auxiliary request to a Harness session in analytics
 * without sending a provider continuation identity or changing the provider
 * request itself.
 */
export interface UsageCorrelationHint {
  readonly usageSessionId?: string
  readonly usagePurpose?: string
}

export function usageCorrelationFor(
  options: GenerateOptions,
  requestId: string,
  usageTracker: Pick<CodexUsageTracker, 'correlation'>,
) {
  const hint = options as GenerateOptions & UsageCorrelationHint
  const sessionId = hint.usageSessionId
    ?? (options.sessionId === undefined ? undefined : String(options.sessionId))
  const purpose = hint.usagePurpose ?? options.purpose
  return usageTracker.correlation(sessionId, requestId, purpose)
}

/** Provider idle ceiling used by the composite route. */
export const OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Give the generic dsh adapter a request-scoped bearer-token entry without
 * changing the provider's user-facing OAuth flow. The resolver accepts only
 * the explicit override supplied by this plugin; it never discovers an API
 * key from the environment or persistent api-key credentials.
 */
function requestProvider(provider: Provider): Provider {
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        name: 'OpenAI Codex OAuth bearer token',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'OAuth' }
        },
      },
    },
  }
}

/** Preserve Harness call purpose until the generic pi-ai adapter reaches the provider. */
class OpenAICodexAdapter extends PiAiAdapter {
  constructor(
    options: ConstructorParameters<typeof PiAiAdapter>[0],
    private readonly responses: OpenAICodexResponseRuntime,
    private readonly usageTracker: CodexUsageTracker,
  ) {
    super(options)
  }

  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{ model: unknown; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    const parent = (PiAiAdapter.prototype as unknown as { prepareCall?: (p: string, m: string, s?: AbortSignal) => Promise<{ model: unknown; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> }).prepareCall
    const base = parent !== undefined
      ? parent.call(this, provider, model, signal)
      : this.resolveModel(provider, model, signal).then(resolved => ({
          model: resolved,
          stream: (options: GenerateOptions) => this.stream(options),
        }))
    return Promise.resolve(base).then(prepared => ({
      ...prepared,
      stream: (options: GenerateOptions) => this.streamWrapped(options, prepared.stream),
    }))
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.streamWrapped(options, opts => super.stream(opts))
  }

  private async *streamWrapped(
    options: GenerateOptions,
    delegate: (opts: GenerateOptions) => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const effectiveOptions: GenerateOptions = options.model === 'gpt-5.6-luna' && (options.reasoningEffort === undefined || options.reasoningEffort === 'medium')
      ? { ...options, reasoningEffort: 'max' as any }
      : options
    const release = effectiveOptions.purpose === 'compaction'
      ? this.responses.enterCompaction(effectiveOptions.sessionId === undefined ? undefined : String(effectiveOptions.sessionId))
      : undefined
    const requestId = randomUUID()
    const requestStartedAt = Date.now()
    let usageRecorded = false
    try {
      for await (const chunk of delegate(effectiveOptions)) {
        if (chunk.type === 'usage' && !usageRecorded) {
          usageRecorded = true
          const providerUsage = chunk.usage as typeof chunk.usage & { serverCredits?: unknown; credits?: unknown }
          const directCredits = typeof providerUsage.serverCredits === 'number'
            ? providerUsage.serverCredits
            : typeof providerUsage.credits === 'number' ? providerUsage.credits : undefined
          await this.usageTracker.record({
            requestId,
            durationMs: Date.now() - requestStartedAt,
            correlation: usageCorrelationFor(effectiveOptions, requestId, this.usageTracker),
            model: effectiveOptions.model,
            ...effectiveOptions.reasoningEffort === undefined ? {} : { reasoningEffort: String(effectiveOptions.reasoningEffort) },
            ...directCredits === undefined || !Number.isFinite(directCredits) || directCredits < 0
              ? {}
              : { serverCredits: directCredits },
            usage: chunk.usage,
          }).catch((error: unknown) => {
            process.emitWarning(`dsh-openai-codex: failed to persist usage: ${error instanceof Error ? error.message : String(error)}`)
          })
        }
        yield chunk
      }
    } finally {
      release?.()
    }
  }
}

/**
 * Create the Codex subscription adapter without requiring a dsh fork. The
 * public pi-ai adapter owns Harness message conversion, image attachment
 * resolution, streaming, and reasoning metadata. This plugin adds optional
 * Codex-native request state/compaction and supplies the provider OAuth token.
 */
export function createOpenAICodexAdapter(
  credentials: OpenAICodexCredentialStore,
  resolveAttachments: () => AttachmentStore | undefined,
  responsePreferences: () => ResponseApiPreferences,
  usageTracker: CodexUsageTracker,
): PiAiAdapter {
  const provider = createOpenAICodexProvider()
  const responses = new OpenAICodexResponseRuntime(responsePreferences)
  const profiles = new Map<string, ResolvedPiAiProviderProfile>([[OPENAI_CODEX_PROVIDER, {
    provider: OPENAI_CODEX_PROVIDER,
    displayName: 'OpenAI Codex',
    streamIdleTimeoutMs: OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-openai-codex retryPolicy'),
    configuredMaxTokens: new Map(),
    piProvider: responses.wrap(requestProvider(provider)),
  }]])
  const models: MutableModels = createModels({ credentials })
  models.setProvider(provider)
  return new OpenAICodexAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => (await models.getAuth(OPENAI_CODEX_PROVIDER))?.auth.apiKey,
    resolveAttachments,
  }, responses, usageTracker)
}
