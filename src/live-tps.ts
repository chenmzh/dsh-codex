/**
 * dsh-live-tps — live decode-throughput (TPS) projection.
 *
 * Registers the `liveTps` session-projection unit: a turn-level fold that
 * recomputes the CURRENT instantaneous decode rate on every token-bearing
 * stream chunk, borrowing dsh-TUI's posture (channel.ts, ccch1mneyyy/dsh-TUI):
 *
 * - one fold per open step: first-token time → now, output chars ÷ 4
 *   (the same chars-per-token heuristic DSH's own token-meter uses);
 * - the reading is published only after 500ms of decode so the number
 *   does not jitter between 0 and a spike on the first chunk;
 * - the turn accumulates closed-step decode spans, preferring the
 *   provider-reported completion-token count at step close (exact) over
 *   the chars/4 estimate (interim);
 * - `turn/end` resets the turn accumulator; the last `tps`/`updatedAt`
 *   pair survives so a client can fade the reading out on its own clock.
 *
 * The wire value is deliberately tiny: `{ tps, updatedAt }`. Anything
 * prettier (gauges, sparklines) is the client's business.
 *
 * @module dsh-live-tps
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent'

/** Client wire contract, unchanged from the standalone dsh-live-tps plugin. */
export interface LiveTpsReading {
  tps: number | null
  updatedAt: number | null
}

/** Version-1 persisted fold state; preserve this shape for existing caches. */
export interface LiveTpsState extends LiveTpsReading {
  openStep: {
    turn: number
    step: number
    firstTokenTime: number | null
    outputChars: number
  } | null
  turnDecodeMs: number
  turnDecodeTokens: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    liveTps: LiveTpsState
  }
  interface SessionProjectionMap {
    liveTps: LiveTpsReading
  }
}
/**
 * Whether a stream chunk carries visible model output (first-token boundary).
 * Host dsh-llm (0.1.2-rc.1) no longer exports this from .../message; kept
 * locally with identical semantics to the removed export.
 */
function isTokenDelta(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}

/** Publish a new reading only after this much decode has elapsed (ms). */
const REFRESH_GATE_MS = 500

/** The chars-per-token heuristic (matches dsh-token-meter's fixed estimator). */
const CHARS_PER_TOKEN = 4

/** Character payload of one token-bearing stream delta. */
function tokenDeltaChars(chunk: StreamChunk): number {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text.length
    case 'tool-call-delta':
      return (chunk.name?.length ?? 0) + chunk.argumentsDelta.length
    default:
      return 0
  }
}

/** Provider-reported completion tokens, guarded; null when unreported/invalid. */
function usageOutputTokens(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null || !('outputTokens' in usage)) return null
  const value = usage.outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

const openStepSchema = z.object({
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  firstTokenTime: z.number().nonnegative().nullable(),
  outputChars: z.number().int().nonnegative(),
})

const stateSchema = z.object({
  /** The open step's decode boundary; null between steps. */
  openStep: openStepSchema.nullable(),
  /** Summed decode wall time over closed steps of the current turn, ms. */
  turnDecodeMs: z.number().nonnegative(),
  /** Output tokens over the same closed steps (provider counts when reported). */
  turnDecodeTokens: z.number().nonnegative(),
  /** Last published instantaneous reading; survives turn end for client fade. */
  tps: z.number().nonnegative().nullable(),
  /** Host-clock ms of the event that produced `tps`; null before any reading. */
  updatedAt: z.number().nonnegative().nullable(),
}).strict()

const viewSchema = z.object({
  tps: z.number().nonnegative().nullable(),
  updatedAt: z.number().nonnegative().nullable(),
}).strict()

/**
 * The `liveTps` unit registered on `ctx.sessionProjections`.
 */
export const liveTpsProjectionDefinition = {
  key: 'liveTps',
  stateVersion: 1,
  stateSchema,
  init: (): LiveTpsState => ({
    openStep: null,
    turnDecodeMs: 0,
    turnDecodeTokens: 0,
    tps: null,
    updatedAt: null,
  }),
  apply: (state: LiveTpsState, event) => {
    switch (event.type) {
      case 'step/start':
        return {
          ...state,
          openStep: {
            turn: event.data.turn,
            step: event.data.step,
            firstTokenTime: null,
            outputChars: 0,
          },
        }
      case 'assistant/chunk': {
        const open = state.openStep
        if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) return state
        if (!isTokenDelta(event.data.chunk)) return state
        const firstTokenTime = open.firstTokenTime ?? event.time
        const outputChars = open.outputChars + tokenDeltaChars(event.data.chunk)
        const next = { ...state, openStep: { ...open, firstTokenTime, outputChars } }
        const elapsedMs = event.time - firstTokenTime
        if (elapsedMs > REFRESH_GATE_MS) {
          // Turn-level instantaneous reading: closed-step exact tokens plus
          // this step's chars/4 estimate over the summed decode spans.
          const decodeMs = state.turnDecodeMs + elapsedMs
          const tokens = state.turnDecodeTokens + Math.ceil(outputChars / CHARS_PER_TOKEN)
          next.tps = tokens / (decodeMs / 1000)
          next.updatedAt = event.time
        }
        return next
      }
      case 'assistant/message': {
        const open = state.openStep
        if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) return state
        const next = { ...state, openStep: null }
        if (open.firstTokenTime !== null) {
          const decodeMs = Math.max(0, event.time - open.firstTokenTime)
          const providerTokens = usageOutputTokens(event.data.usage)
          next.turnDecodeMs = state.turnDecodeMs + decodeMs
          next.turnDecodeTokens = state.turnDecodeTokens
            + (providerTokens ?? Math.ceil(open.outputChars / CHARS_PER_TOKEN))
          if (decodeMs > 0) {
            next.tps = next.turnDecodeTokens / (next.turnDecodeMs / 1000)
            next.updatedAt = event.time
          }
        }
        return next
      }
      case 'turn/end':
        // Keep the last reading (clients fade it on their clock); drop the
        // turn accumulator so the next turn starts clean.
        return { ...state, openStep: null, turnDecodeMs: 0, turnDecodeTokens: 0 }
      default:
        return state
    }
  },
  wire: {
    viewSchema,
    view: (state: LiveTpsState) => ({ tps: state.tps, updatedAt: state.updatedAt }),
  },
} satisfies ProjectionDefinition<'liveTps', LiveTpsState>

/**
 * Register the `liveTps` unit; the registration is an effect on this
 * plugin's fiber, so unloading removes the key.
 * The optional child injection leaves hosts without the registry functional.
 * @param ctx - registrant context.
 */
export function installLiveTpsProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(liveTpsProjectionDefinition)
  })
}
