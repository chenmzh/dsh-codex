import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { SessionUsage, TaskUsage, UsageBreakdownRow, UsageTotals } from '../usage-ledger.ts'
import { isUsageSelection } from './usage-ui-data.ts'
import type { CodexHudModelDirectory } from './usage-ui-data.ts'

const API = '/plugins/dsh-openai-codex/usage'
const border = '1px solid color-mix(in srgb, var(--dsw-alias-border-l2, #374151) 62%, transparent)'
const button: CSSProperties = {
  color: 'inherit', background: 'var(--dsw-alias-bg-layer-1, transparent)', border,
  borderRadius: 8, padding: '5px 10px', minHeight: 32, cursor: 'pointer', font: 'inherit', fontSize: 12,
}
const muted: CSSProperties = { color: 'var(--dsw-alias-label-secondary, #9ca3af)' }

interface CurrentSessionPayload {
  session: SessionUsage | null
  showUsageHud: boolean
  pinUsageHud: boolean
}

function tokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { accept: 'application/json' }, cache: 'no-store' })
  if (!response.ok) throw new Error(`Usage API ${response.status}`)
  return response.json() as Promise<T>
}

function Hud({ sessionId, modelDirectory }: { sessionId?: string; modelDirectory: CodexHudModelDirectory }) {
  const [payload, setPayload] = useState<CurrentSessionPayload>()
  const selection = useSyncExternalStore(
    modelDirectory.store.subscribe,
    modelDirectory.store.getSnapshot,
    modelDirectory.store.getSnapshot,
  ).current
  const active = isUsageSelection(selection)
  const refresh = useCallback(() => {
    if (sessionId === undefined || sessionId === '' || !active) return setPayload(undefined)
    void getJson<CurrentSessionPayload>(`/current-session?sessionId=${encodeURIComponent(sessionId)}`).then(setPayload, () => {})
  }, [active, sessionId])
  useEffect(() => { void modelDirectory.load().catch(() => {}) }, [modelDirectory])
  useEffect(() => {
    refresh()
    if (!active) return
    const source = new EventSource(`${API}/events`)
    source.addEventListener('usage', refresh)
    return () => { source.close() }
  }, [active, refresh])
  if (!active || payload === undefined || payload.showUsageHud === false) return null
  const usage = payload.session
  return <div style={{
    boxSizing: 'border-box', width: 'calc(100% - 2 * var(--dsh-composer-side-clearance))',
    maxWidth: 'var(--dsh-composer-card-max-width)', margin: '0 auto',
    display: 'flex', justifyContent: 'flex-start', pointerEvents: 'none',
  }}>
    <output aria-label="Session token usage" title="Provider-reported token usage for this DSH session." style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', padding: '3px 8px',
      borderRadius: 999, border: payload.pinUsageHud ? border : '1px solid transparent',
      background: payload.pinUsageHud ? 'color-mix(in srgb, var(--dsw-alias-bg-layer-1, #111827) 72%, transparent)' : 'transparent',
      color: 'var(--dsw-alias-label-secondary, #9ca3af)', fontSize: 10, lineHeight: '14px',
      fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    }}>
      <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--dsw-alias-brand-primary, #8b5cf6)' }} />
      <span>{selection?.provider}/{selection?.model}</span>
      <strong style={{ color: 'var(--dsw-alias-label-primary, #e5e7eb)', fontWeight: 600 }}>{tokens(usage?.totalTokens ?? 0)} tok</strong>
      <span>in {tokens(usage?.inputTokens ?? 0)}</span>
      <span>out {tokens(usage?.outputTokens ?? 0)}</span>
      {(usage?.cachedInputTokens ?? 0) === 0 ? null : <span>cache {tokens(usage?.cachedInputTokens ?? 0)}</span>}
    </output>
  </div>
}

function query(range: string, provider: string, model: string, reasoning: string): string {
  const params = new URLSearchParams({ range })
  if (provider !== '') params.set('provider', provider)
  if (model !== '') params.set('model', model)
  if (reasoning !== '') params.set('reasoning', reasoning)
  return params.toString()
}

function Breakdown({ title, rows }: { title: string; rows: UsageBreakdownRow[] }) {
  return <section style={{ borderTop: border, padding: '16px 0' }}><h2 style={{ marginTop: 0, fontSize: 13 }}>{title}</h2>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead><tr><th align="left">Name</th><th align="right">Tokens</th><th align="right">Requests</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.key} style={{ borderTop: border }}>
        <td style={{ padding: '8px 0' }}>{row.label}</td><td align="right">{tokens(row.totalTokens)}</td><td align="right">{row.requests}</td>
      </tr>)}</tbody>
    </table>
  </section>
}

interface AnalyticsData {
  summary: UsageTotals
  providers: UsageBreakdownRow[]
  models: UsageBreakdownRow[]
  reasoning: UsageBreakdownRow[]
  tasks: TaskUsage[]
}

function Analytics() {
  const [range, setRange] = useState('7d')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [reasoning, setReasoning] = useState('')
  const [data, setData] = useState<AnalyticsData>()
  const [error, setError] = useState<string>()
  const suffix = useMemo(() => '?' + query(range, provider, model, reasoning), [range, provider, model, reasoning])
  const refresh = useCallback(() => {
    void Promise.all([
      getJson<UsageTotals>('/summary' + suffix),
      getJson<UsageBreakdownRow[]>('/providers' + suffix),
      getJson<UsageBreakdownRow[]>('/models' + suffix),
      getJson<UsageBreakdownRow[]>('/reasoning' + suffix),
      getJson<TaskUsage[]>('/tasks' + suffix),
    ]).then(([summary, providers, models, efforts, tasks]) => {
      setData({ summary, providers, models, reasoning: efforts, tasks })
      setError(undefined)
    }, reason => { setError(reason instanceof Error ? reason.message : String(reason)) })
  }, [suffix])
  useEffect(refresh, [refresh])
  useEffect(() => {
    const source = new EventSource(`${API}/events`)
    source.addEventListener('usage', refresh)
    return () => { source.close() }
  }, [refresh])
  const summary = data?.summary
  return <div style={{ width: '100%', maxWidth: 1180, color: 'var(--dsw-alias-label-primary,#e5e7eb)' }}>
    <h1 style={{ marginBottom: 4, fontSize: 20 }}>LLM Usage Analytics</h1>
    <div style={muted}>Provider-reported tokens recorded locally by DSH; no account quota is queried.</div>
    <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', margin: '16px 0' }}>
      <select aria-label="Time range" value={range} onChange={event => { setRange(event.currentTarget.value) }} style={button}>
        {['today', '24h', '7d', 'this-week', '30d', '90d', 'all'].map(value => <option key={value}>{value}</option>)}
      </select>
      <select aria-label="Provider" value={provider} onChange={event => { setProvider(event.currentTarget.value); setModel('') }} style={button}>
        <option value="">All providers</option>{data?.providers.map(row => <option key={row.key}>{row.key}</option>)}
      </select>
      <select aria-label="Model" value={model} onChange={event => { setModel(event.currentTarget.value) }} style={button}>
        <option value="">All models</option>{data?.models.map(row => <option key={row.key}>{row.key}</option>)}
      </select>
      <select aria-label="Reasoning effort" value={reasoning} onChange={event => { setReasoning(event.currentTarget.value) }} style={button}>
        <option value="">All reasoning</option>{data?.reasoning.map(row => <option key={row.key}>{row.key}</option>)}
      </select>
      <button style={button} onClick={refresh}>Refresh</button>
    </div>
    {error === undefined ? null : <div style={{ color: '#f59e0b' }}>{error}</div>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 20, padding: '16px 0', borderTop: border }}>
      {[
        ['Total', summary?.totalTokens ?? 0], ['Input', summary?.inputTokens ?? 0],
        ['Output', summary?.outputTokens ?? 0], ['Cached input', summary?.cachedInputTokens ?? 0],
        ['Requests', summary?.requests ?? 0], ['Sessions', summary?.sessions ?? 0],
      ].map(([label, value]) => <div key={String(label)}><div style={{ ...muted, fontSize: 10, textTransform: 'uppercase' }}>{label}</div>
        <strong style={{ display: 'block', fontSize: 20, marginTop: 4 }}>{label === 'Requests' || label === 'Sessions' ? value : tokens(Number(value))}</strong></div>)}
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 18 }}>
      <Breakdown title="Providers" rows={data?.providers ?? []} />
      <Breakdown title="Exact Models" rows={data?.models ?? []} />
      <Breakdown title="Reasoning" rows={data?.reasoning ?? []} />
    </div>
    <section style={{ borderTop: border, padding: '16px 0', overflowX: 'auto' }}><h2 style={{ fontSize: 13 }}>Recent Tasks</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 720 }}>
        <thead><tr><th align="left">Provider</th><th align="left">Model</th><th align="left">Reasoning</th><th align="right">Requests</th><th align="right">Tokens</th></tr></thead>
        <tbody>{data?.tasks.map(task => <tr key={task.taskId} style={{ borderTop: border }}>
          <td style={{ padding: '8px 0' }}>{task.provider}</td><td>{task.model}</td><td>{task.reasoningEffort}</td><td align="right">{task.requests}</td><td align="right">{tokens(task.totalTokens)}</td>
        </tr>)}</tbody>
      </table>
    </section>
  </div>
}

export function CodexUsageHud(props: { sessionId?: string; modelDirectory: CodexHudModelDirectory }) { return <Hud {...props} /> }
export function CodexUsageAnalyticsSettings() { return <Analytics /> }
