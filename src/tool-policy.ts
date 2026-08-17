import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { OPENAI_CODEX_PROVIDER } from './store.ts'

/** User-controlled image-tool integration. */
export interface ImageToolPreferences {
  modifyReadImage: boolean
  shareImagegenWithOtherModels: boolean
}

/** Experimental request behavior used only by the OpenAI Codex adapter. */
export const OPENAI_CODEX_REASONING_SUMMARIES = ['auto', 'concise', 'detailed'] as const
export type OpenAICodexReasoningSummary = typeof OPENAI_CODEX_REASONING_SUMMARIES[number]

export interface ResponseApiPreferences {
  reasoningSummary: OpenAICodexReasoningSummary
  useWebSocketContextReuse: boolean
  useNativeCompaction: boolean
}

/** Browser presentation preferences shared by UI controls and /codex commands. */
export interface UsageUiPreferences {
  showUsageHud: boolean
  pinUsageHud: boolean
}

interface OpenAICodexPreferences extends ImageToolPreferences, ResponseApiPreferences, UsageUiPreferences {
  /** Migration-only key written by the unreleased store:true experiment. */
  useStatefulResponses: boolean
}

/** Defaults keep generic vision-model interoperability enabled. */
export const DEFAULT_IMAGE_TOOL_PREFERENCES: ImageToolPreferences = {
  modifyReadImage: true,
  shareImagegenWithOtherModels: true,
}

/** Conservative defaults preserve the established stateless Harness behavior. */
export const DEFAULT_RESPONSE_API_PREFERENCES: ResponseApiPreferences = {
  reasoningSummary: 'auto',
  useWebSocketContextReuse: false,
  useNativeCompaction: false,
}

export const DEFAULT_USAGE_UI_PREFERENCES: UsageUiPreferences = {
  showUsageHud: true,
  pinUsageHud: false,
}

const NAMESPACE = settingsNamespace('openai-codex')
const schema: z<OpenAICodexPreferences> = z.object({
  modifyReadImage: z.boolean().default(true),
  shareImagegenWithOtherModels: z.boolean().default(true),
  reasoningSummary: z.union(OPENAI_CODEX_REASONING_SUMMARIES).default('auto'),
  useWebSocketContextReuse: z.boolean().default(false),
  useStatefulResponses: z.boolean().default(false),
  useNativeCompaction: z.boolean().default(false),
  showUsageHud: z.boolean().default(true),
  pinUsageHud: z.boolean().default(false),
})

/** Live policy shared by the host tools, Codex adapter, and settings HTTP surface. */
export class ImageToolPolicy {
  private current: OpenAICodexPreferences
  private scope: SettingsScope<OpenAICodexPreferences> | undefined
  private readonly imageWatchers = new Set<() => void>()

  constructor(base: Partial<OpenAICodexPreferences> = {}) {
    this.current = {
      ...DEFAULT_IMAGE_TOOL_PREFERENCES,
      ...DEFAULT_RESPONSE_API_PREFERENCES,
      ...DEFAULT_USAGE_UI_PREFERENCES,
      useStatefulResponses: false,
      ...base,
    }
    if (this.current.useStatefulResponses && base.useWebSocketContextReuse === undefined) {
      this.current = { ...this.current, useWebSocketContextReuse: true }
    }
  }

  /** Register durable live settings when the active profile supplies ctx.settings. */
  attach(ctx: Context): void {
    const scope = ctx.settings.register(NAMESPACE, schema, { base: this.current, applies: 'live' })
    this.scope = scope
    this.replace(scope.get())
    const unwatch = scope.watch(next => { this.replace(next) })
    ctx.effect(() => () => {
      unwatch()
      if (this.scope === scope) this.scope = undefined
    }, 'dsh-openai-codex: image tool preferences')
  }

  /** Return a detached settings projection for the browser. */
  snapshot(): ImageToolPreferences {
    return {
      modifyReadImage: this.current.modifyReadImage,
      shareImagegenWithOtherModels: this.current.shareImagegenWithOtherModels,
    }
  }

  /** Observe live changes that add or remove the scoped `read_image` enhancement. */
  watchImagePreferences(listener: () => void): () => void {
    this.imageWatchers.add(listener)
    return () => { this.imageWatchers.delete(listener) }
  }

  /** Persist a partial browser update through the settings service. */
  async update(patch: Partial<ImageToolPreferences>): Promise<ImageToolPreferences> {
    if (this.scope === undefined) throw new Error('OpenAI Codex settings service is unavailable')
    await this.scope.update(patch)
    this.replace(this.scope.get())
    return this.snapshot()
  }

  /** Return the current Codex-only Responses API experiments. */
  responseApiSnapshot(): ResponseApiPreferences {
    return {
      reasoningSummary: this.current.reasoningSummary,
      useWebSocketContextReuse: this.current.useWebSocketContextReuse,
      useNativeCompaction: this.current.useNativeCompaction,
    }
  }

  /** Persist a partial Responses API experiment update. */
  async updateResponseApi(patch: Partial<ResponseApiPreferences>): Promise<ResponseApiPreferences> {
    if (this.scope === undefined) throw new Error('OpenAI Codex settings service is unavailable')
    await this.scope.update({
      ...patch,
      ...patch.useWebSocketContextReuse === undefined ? {} : { useStatefulResponses: false },
    })
    this.replace(this.scope.get())
    return this.responseApiSnapshot()
  }

  usageUiSnapshot(): UsageUiPreferences {
    return { showUsageHud: this.current.showUsageHud, pinUsageHud: this.current.pinUsageHud }
  }

  async updateUsageUi(patch: Partial<UsageUiPreferences>): Promise<UsageUiPreferences> {
    if (this.scope === undefined) throw new Error('OpenAI Codex settings service is unavailable')
    await this.scope.update(patch)
    this.replace(this.scope.get())
    return this.usageUiSnapshot()
  }

  /** Enforce imagegen's cross-provider toggle at execution time. */
  assertAllowed(exec: ToolExecution, tool: 'imagegen'): void {
    const configured = exec.agent?.session.requestHeader()?.config
    const provider = configured?.provider ?? exec.agent?.options.provider
    if (provider === OPENAI_CODEX_PROVIDER) return
    if (!this.current.shareImagegenWithOtherModels) {
      throw new Error(`${tool} is disabled for models outside the openai-codex provider in Settings`)
    }
  }

  private replace(next: OpenAICodexPreferences): void {
    next = next.useStatefulResponses && !next.useWebSocketContextReuse
      ? { ...next, useWebSocketContextReuse: true }
      : next
    const imageChanged = next.modifyReadImage !== this.current.modifyReadImage
      || next.shareImagegenWithOtherModels !== this.current.shareImagegenWithOtherModels
    this.current = next
    if (imageChanged) {
      for (const listener of this.imageWatchers) listener()
    }
  }
}
