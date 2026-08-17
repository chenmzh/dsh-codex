/**
 * Optional OpenAI Codex subscription bundle with ChatGPT OAuth, Codex models,
 * standalone search, browser settings, and vision-aware image input.
 * @module dsh-codex
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { createOpenAICodexAdapter } from './adapter.ts'
import { registerOpenAICodexAuthRoutes } from './auth-routes.ts'
import { registerOpenAICodexUsageRoutes } from './usage-routes.ts'
import { installReadImageEnhancement } from './read-image-enhancement.ts'
import { imagegenTool } from './imagegen.ts'
import { ImageToolPolicy } from './tool-policy.ts'
import {
  installOpenAICodexSearchEvent,
  recordOpenAICodexSearchRequest,
} from './search-event.ts'

export { READ_IMAGE_TOOL_NAME } from './read-image-enhancement.ts'
export {
  IMAGEGEN_TOOL_NAME,
  OPENAI_CODEX_IMAGE_EDITS_URL,
  OPENAI_CODEX_IMAGE_GENERATIONS_URL,
  OPENAI_CODEX_IMAGE_MODEL,
  OpenAICodexImageClient,
} from './imagegen.ts'
export {
  DEFAULT_IMAGE_TOOL_PREFERENCES,
  DEFAULT_RESPONSE_API_PREFERENCES,
  ImageToolPolicy,
  OPENAI_CODEX_REASONING_SUMMARIES,
} from './tool-policy.ts'
export type {
  ImageToolPreferences,
  OpenAICodexReasoningSummary,
  ResponseApiPreferences,
} from './tool-policy.ts'
export { OPENAI_CODEX_USAGE_URL, parseOpenAICodexUsage, readOpenAICodexRateLimits } from './usage.ts'
export type {
  OpenAICodexCredits,
  OpenAICodexIndividualLimit,
  OpenAICodexRateLimit,
  OpenAICodexRateLimitWindow,
  OpenAICodexUsage,
} from './usage.ts'
export {
  installOpenAICodexSearchEvent,
  OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT,
  recordOpenAICodexSearchRequest,
} from './search-event.ts'
import {
  DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE,
  DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS,
  DEFAULT_OPENAI_CODEX_SEARCH_MODE,
  DEFAULT_OPENAI_CODEX_SEARCH_MODEL,
  OpenAICodexSearchProvider,
} from './search.ts'
import type { OpenAICodexSearchContextSize, OpenAICodexSearchMode } from './search.ts'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from './store.ts'
import { OpenAICodexService } from './service.ts'
import { OPENAI_CODEX_REASONING_SUMMARIES } from './tool-policy.ts'
import type { OpenAICodexReasoningSummary } from './tool-policy.ts'

export { OpenAICodexService } from './service.ts'
export {
  classifyCodexModel,
  CodexUsageLedger,
  CodexUsageTracker,
  OPENAI_CODEX_USAGE_DB_FILENAME,
  openAICodexUsageDbPath,
} from './usage-ledger.ts'
export type {
  CodexModelFamily,
  CodexUsageEvent,
  CreditRate,
  CreditSource,
  QuotaSnapshot,
  SessionUsage,
  TaskDetail,
  TaskUsage,
  UsageBreakdownRow,
  UsageFilters,
  UsageTimePoint,
  UsageTotals,
} from './usage-ledger.ts'
export type { OpenAICodexServiceOptions } from './service.ts'

export { loginOpenAICodex, logoutOpenAICodex, openAICodexAuthStatus } from './auth.ts'
export type { OpenAICodexAuthStatus } from './auth.ts'
export {
  OpenAICodexCredentialStore,
  OPENAI_CODEX_AUTH_FILENAME,
  OPENAI_CODEX_PROVIDER,
  openAICodexAuthPath,
} from './store.ts'
export {
  DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE,
  DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS,
  DEFAULT_OPENAI_CODEX_SEARCH_MODE,
  DEFAULT_OPENAI_CODEX_SEARCH_MODEL,
  mapOpenAICodexSearchResponse,
  OpenAICodexSearchProvider,
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_SEARCH_PROVIDER,
  OPENAI_CODEX_SEARCH_URL,
} from './search.ts'
export type {
  OpenAICodexSearchContextSize,
  OpenAICodexSearchMode,
  OpenAICodexSearchProviderOptions,
  OpenAICodexSearchRequestRecord,
} from './search.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-openai-codex'

/** LLM and web registries required before the composite provider can register. */
export const inject = ['llm', 'web']

/** Composite model and standalone-search configuration. */
export interface Config {
  /** Model used for auxiliary standalone searches. */
  searchModel?: string
  /** Cached, indexed, or live web access. */
  searchMode?: OpenAICodexSearchMode
  /** Amount of search context returned by the provider. */
  searchContextSize?: OpenAICodexSearchContextSize
  /** Maximum generated tokens returned by the standalone search endpoint. */
  searchMaxOutputTokens?: number
  /** Extend Harness read_image with HTTP(S) URL input. */
  modifyReadImage?: boolean
  /** Allow non-Codex vision models to call imagegen. */
  shareImagegenWithOtherModels?: boolean
  /** Request a provider-authored reasoning summary; raw private reasoning is unavailable. */
  reasoningSummary?: OpenAICodexReasoningSummary
  /** Reuse matching Codex context through the session's WebSocket connection. */
  useWebSocketContextReuse?: boolean
  /** Use Codex V2 Responses compaction for Harness compaction calls. */
  useNativeCompaction?: boolean
}

export const Config: z<Config> = z.object({
  searchModel: z.string().default(DEFAULT_OPENAI_CODEX_SEARCH_MODEL),
  searchMode: z.union(['cached', 'indexed', 'live'] as const).default(DEFAULT_OPENAI_CODEX_SEARCH_MODE),
  searchContextSize: z.union(['low', 'medium', 'high'] as const).default(DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE),
  searchMaxOutputTokens: z.number().step(1).min(1).default(DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS),
  modifyReadImage: z.boolean().default(true),
  shareImagegenWithOtherModels: z.boolean().default(true),
  reasoningSummary: z.union(OPENAI_CODEX_REASONING_SUMMARIES).default('auto'),
  useWebSocketContextReuse: z.boolean().default(false),
  useNativeCompaction: z.boolean().default(false),
})

/**
 * Register the `openai-codex` LLM route and standalone web-search provider
 * with one provider-native OAuth credential store.
 * @param ctx - plugin context carrying the LLM and web registries plus optional agent and attachment services.
 * @param config - standalone-search model, access mode, context size, and output budget.
 */
export function apply(ctx: Context, config: Config): void {
  installOpenAICodexSearchEvent()
  const service = new OpenAICodexService({
    modifyReadImage: config.modifyReadImage ?? true,
    shareImagegenWithOtherModels: config.shareImagegenWithOtherModels ?? true,
    reasoningSummary: config.reasoningSummary ?? 'auto',
    useWebSocketContextReuse: config.useWebSocketContextReuse ?? false,
    useNativeCompaction: config.useNativeCompaction ?? false,
  })
  const credentials = service.credentials
  const imageTools = service.policy
  const usageTracker = service.usageTracker
  ctx.provide('openAICodex', service)
  ctx.inject(['settings'], settingsCtx => { service.attachSettings(settingsCtx) })
  ctx.llm.registerAdapter(
    [OPENAI_CODEX_PROVIDER],
    createOpenAICodexAdapter(
      credentials,
      () => ctx.get('attachments'),
      () => imageTools.responseApiSnapshot(),
      usageTracker,
    ),
  )
  ctx.web.registerSearchProvider(new OpenAICodexSearchProvider({
    credentials,
    model: config.searchModel ?? DEFAULT_OPENAI_CODEX_SEARCH_MODEL,
    mode: config.searchMode ?? DEFAULT_OPENAI_CODEX_SEARCH_MODE,
    contextSize: config.searchContextSize ?? DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE,
    maxOutputTokens: config.searchMaxOutputTokens ?? DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS,
    resolveRequestId: () => String(ctx.get('agents')?.currentInitiator()?.session.id ?? randomUUID()),
    recordRequest: request => { recordOpenAICodexSearchRequest(ctx, request) },
  }))
  ctx.inject(['webServer'], webCtx => {
    registerOpenAICodexAuthRoutes(webCtx, credentials, imageTools)
    registerOpenAICodexUsageRoutes(webCtx, service)
  })
  ctx.inject(['agents'], agentCtx => {
    agentCtx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision.kind === 'enter') usageTracker.noteStep(String(payload.agent.id), payload.turn, payload.step)
      return decision
    })
    agentCtx.on('agent/turn-stopping', payload => {
      usageTracker.finishTask(String(payload.agent.id), payload.turn)
      void service.usage().catch(() => undefined)
    })
  })
  ctx.inject(['tools', 'fs', 'attachments'], toolCtx => {
    toolCtx.tools.register(imagegenTool(toolCtx, credentials, imageTools))
  })
  ctx.inject(['tools', 'fs', 'attachments', 'agents'], toolCtx => {
    installReadImageEnhancement(toolCtx, imageTools)
  })
  ctx.effect(() => () => usageTracker.ledger.close(), 'dsh-openai-codex: close usage ledger')
}
