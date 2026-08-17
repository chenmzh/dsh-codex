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

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const release = options.purpose === 'compaction'
      ? this.responses.enterCompaction(options.sessionId === undefined ? undefined : String(options.sessionId))
      : undefined
    const requestId = randomUUID()
    const requestStartedAt = Date.now()
    let usageRecorded = false
    try {
      for await (const chunk of super.stream(options)) {
        if (chunk.type === 'usage' && !usageRecorded) {
          usageRecorded = true
          const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
          const providerUsage = chunk.usage as typeof chunk.usage & { serverCredits?: unknown; credits?: unknown }
          const directCredits = typeof providerUsage.serverCredits === 'number'
            ? providerUsage.serverCredits
            : typeof providerUsage.credits === 'number' ? providerUsage.credits : undefined
          await this.usageTracker.record({
            requestId,
            durationMs: Date.now() - requestStartedAt,
            correlation: this.usageTracker.correlation(sessionId, requestId, options.purpose),
            model: options.model,
            ...options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) },
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
