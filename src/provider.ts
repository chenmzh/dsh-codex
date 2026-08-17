/** Stable OpenAI Codex provider construction for long-lived dsh module graphs. */

import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'

let oauthFlowsRegistered = false

/**
 * Register the package's static OAuth loaders before creating a lazy provider.
 *
 * pi-ai's default loader derives a relative module URL from `import.meta.url`.
 * Some long-lived native-loader/HMR graphs can evaluate that helper without the
 * metadata value, so use pi-ai's own static registration seam on Node as well as
 * Bun. Registration is process-global and intentionally idempotent here.
 */
export function createOpenAICodexProvider(): ReturnType<typeof openaiCodexProvider> {
  if (!oauthFlowsRegistered) {
    registerBunOAuthFlows()
    oauthFlowsRegistered = true
  }
  return openaiCodexProvider()
}
