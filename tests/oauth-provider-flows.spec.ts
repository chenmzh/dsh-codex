import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('@earendil-works/pi-ai/bun-oauth')
  vi.doUnmock('@earendil-works/pi-ai/providers/openai-codex')
  vi.resetModules()
})

describe('static OpenAI Codex OAuth flow registration', () => {
  it('registers the static OAuth flows once before constructing providers', async () => {
    const order: string[] = []
    vi.doMock('@earendil-works/pi-ai/bun-oauth', () => ({
      registerBunOAuthFlows: () => { order.push('register') },
    }))
    vi.doMock('@earendil-works/pi-ai/providers/openai-codex', () => ({
      openaiCodexProvider: () => {
        order.push('provider')
        return { id: 'openai-codex', auth: { oauth: undefined } }
      },
    }))

    const { openaiCodexProvider } = await import('../src/oauth-provider.ts')
    openaiCodexProvider()
    openaiCodexProvider()

    expect(order).toEqual(['register', 'provider', 'provider'])
  })
})
