import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { installLiveTpsProjection, liveTpsProjectionDefinition as unit } from '../src/live-tps.ts'
import type { LiveTpsState } from '../src/live-tps.ts'

function start(time = 0, turn = 0, step = 0): SessionEvent {
  return { type: 'step/start', time, seq: SessionSeq(0), data: { turn, step } }
}

function chunk(time: number, value: StreamChunk = { type: 'text-delta', index: 0, text: 'abcd' }, turn = 0, step = 0): SessionEvent {
  return { type: 'assistant/chunk', time, seq: SessionSeq(0), data: { turn, step, chunk: value } }
}

// Unknown usage fixtures deliberately exercise legacy malformed/unreported counters.
function close(time: number, usage?: unknown, turn = 0, step = 0): SessionEvent {
  return { type: 'assistant/message', time, seq: SessionSeq(0), data: {
    turn, step, message: { role: 'assistant', content: [] },
    ...(usage === undefined ? {} : { usage }),
  } } as SessionEvent
}

function fold(...events: SessionEvent[]): LiveTpsState {
  return events.reduce((state, event) => unit.apply(state, event), unit.init())
}

describe('liveTps version-1 fold', () => {
  it('keeps the legacy key, persisted state and tiny strict wire shape', () => {
    const state = unit.init()
    expect(unit.key).toBe('liveTps')
    expect(unit.stateVersion).toBe(1)
    expect(state).toEqual({ openStep: null, turnDecodeMs: 0, turnDecodeTokens: 0, tps: null, updatedAt: null })
    expect(unit.stateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
    expect(unit.wire.view(state)).toEqual({ tps: null, updatedAt: null })
    expect(() => unit.stateSchema.parse({ ...state, unexpected: 1 })).toThrow()
    expect(() => unit.wire.viewSchema.parse({ tps: -1, updatedAt: 0 })).toThrow()
    expect(() => unit.wire.viewSchema.parse({ tps: 1, updatedAt: 0, unexpected: 1 })).toThrow()
  })

  it('ignores empty deltas, wrong steps/turns and unrelated events by reference', () => {
    const empty = unit.init()
    expect(unit.apply(empty, chunk(10))).toBe(empty)
    expect(unit.apply(empty, close(10))).toBe(empty)
    const state = fold(start())
    for (const event of [chunk(10, { type: 'text-delta', index: 0, text: '' }),
      chunk(10, { type: 'reasoning-delta', index: 0, text: '' }),
      chunk(10, undefined, 1), chunk(10, undefined, 0, 1),
      close(10, undefined, 1), close(10, undefined, 0, 1),
      { type: 'step/end', time: 10, seq: SessionSeq(0), data: { turn: 0, step: 0 } } as SessionEvent]) {
      expect(unit.apply(state, event)).toBe(state)
    }
  })

  it('excludes first-token latency and gates strictly above 500ms', () => {
    let state = fold(start(), chunk(1000), chunk(1500))
    expect(state.tps).toBeNull()
    expect(state.openStep).toMatchObject({ firstTokenTime: 1000, outputChars: 8 })
    state = unit.apply(state, chunk(1501, { type: 'reasoning-delta', index: 0, text: 'x' }))
    expect(state.tps).toBeCloseTo(3 / 0.501)
    expect(state.updatedAt).toBe(1501)
  })

  it('counts tool names and argument deltas as output, including a name-only boundary', () => {
    const tool = (argumentsDelta: string, name?: string): StreamChunk => ({
      type: 'tool-call-delta', index: 0, id: ToolCallId('tps-tool'), argumentsDelta, ...(name === undefined ? {} : { name }),
    })
    const initial = fold(start())
    expect(unit.apply(initial, chunk(50, tool('')))).toBe(initial)
    const state = fold(start(), chunk(100, tool('', 'tool')), chunk(1100, tool('abcde')))
    expect(state.openStep).toMatchObject({ firstTokenTime: 100, outputChars: 9 })
    expect(state.tps).toBe(3)
    expect(fold(start(), chunk(100, tool('', ''))).openStep?.firstTokenTime).toBe(100)
  })

  it('prefers provider counters and accumulates only decode spans across steps', () => {
    const state = fold(start(), chunk(1000), close(2000, { outputTokens: 20 }),
      start(9000, 0, 1), chunk(10000, undefined, 0, 1), chunk(11000, undefined, 0, 1))
    expect(state.turnDecodeMs).toBe(1000)
    expect(state.turnDecodeTokens).toBe(20)
    expect(state.tps).toBe(11)
    const closed = unit.apply(state, close(12000, { outputTokens: 40 }, 0, 1))
    expect(closed).toMatchObject({ openStep: null, turnDecodeMs: 3000, turnDecodeTokens: 60, tps: 20, updatedAt: 12000 })
    expect(unit.apply(closed, close(12001))).toBe(closed)
  })

  it.each([undefined, null, {}, { outputTokens: -1 }, { outputTokens: Infinity }, { outputTokens: NaN }, { outputTokens: '12' }])('falls back to rounded character estimates for invalid usage %j', usage => {
    const state = fold(start(), chunk(100, { type: 'text-delta', index: 0, text: 'abcde' }), close(1100, usage))
    expect(state).toMatchObject({ turnDecodeMs: 1000, turnDecodeTokens: 2, tps: 2, updatedAt: 1100 })
  })

  it('accepts zero provider output and publishes short positive decode spans at close', () => {
    expect(fold(start(), chunk(100), close(200, { outputTokens: 0 })))
      .toMatchObject({ tps: 0, updatedAt: 200, turnDecodeMs: 100, turnDecodeTokens: 0 })
  })

  it('does not fabricate a decode span when no tokens arrive or clocks do not advance', () => {
    expect(fold(start(), close(1000, { outputTokens: 20 }))).toEqual(unit.init())
    for (const time of [99, 100]) {
      expect(fold(start(), chunk(100), close(time, { outputTokens: 20 })))
        .toMatchObject({ openStep: null, turnDecodeMs: 0, turnDecodeTokens: 20, tps: null, updatedAt: null })
    }
  })

  it.each(['completed', 'interrupted'] as const)('resets a %s turn but retains the last reading for fade', kind => {
    const state = fold(start(), chunk(100), chunk(1100))
    const end: SessionEvent = { type: 'turn/end', time: 1200, seq: SessionSeq(0), data: { turn: 0, reason: { kind } } }
    const reset = unit.apply(state, end)
    expect(reset).toEqual({ ...unit.init(), tps: 2, updatedAt: 1100 })
    const next = unit.apply(unit.apply(reset, start(2000, 1)), chunk(3000, undefined, 1))
    expect(next).toMatchObject({ turnDecodeMs: 0, turnDecodeTokens: 0, tps: 2, updatedAt: 1100 })
  })

  it('resumes a serialized open-step checkpoint without changing results', () => {
    const state = fold(start(), chunk(100), chunk(1100))
    const restored = unit.stateSchema.parse(JSON.parse(JSON.stringify(state)))
    expect(unit.apply(restored, close(2100, { outputTokens: 17 })))
      .toEqual(unit.apply(state, close(2100, { outputTokens: 17 })))
  })
})

describe('optional scoped TPS registration', () => {
  it('activates after a late registry and removes its only key on plugin disposal', async () => {
    const ctx = new Context()
    const fibers: Array<{ dispose(): unknown }> = []
    try {
      fibers.push(await ctx.plugin(SessionStore))
      const owner = await ctx.plugin(installLiveTpsProjection)
      fibers.push(owner)
      expect(ctx.get('sessionProjections')).toBeUndefined()
      fibers.push(await ctx.plugin(SessionProjectionRegistry))
      const session = ctx.sessions.create()
      expect(ctx.sessionProjections.snapshot(session).values.liveTps).toEqual({ tps: null, updatedAt: null })
      await owner.dispose()
      expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('liveTps')
      const replacement = await ctx.plugin(installLiveTpsProjection)
      fibers.push(replacement)
      expect(ctx.sessionProjections.snapshot(session).values.liveTps).toEqual({ tps: null, updatedAt: null })
      await replacement.dispose()
      expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('liveTps')
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  })

  it('registers immediately with an existing registry and folds committed events', async () => {
    const ctx = new Context()
    const fibers: Array<{ dispose(): unknown }> = []
    try {
      fibers.push(await ctx.plugin(SessionStore))
      fibers.push(await ctx.plugin(SessionProjectionRegistry))
      const owner = await ctx.plugin(installLiveTpsProjection)
      fibers.push(owner)
      const session = ctx.sessions.create()
      session.append('step/start', { turn: 0, step: 0 })
      expect(ctx.sessionProjections.stateOf(session, 'liveTps')?.openStep).toMatchObject({ turn: 0, step: 0 })
      await owner.dispose()
      expect(ctx.sessionProjections.stateOf(session, 'liveTps')).toBeUndefined()
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  })
})
