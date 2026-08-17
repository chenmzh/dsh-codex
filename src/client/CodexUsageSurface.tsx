import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { ReasoningBreakdown, SessionTotals } from './UsageBreakdownTables.tsx'
import { createUsageReport, isOpenAICodexSelection } from './usage-ui-data.ts'
import type { AnalyticsPayload, CodexHudModelDirectory } from './usage-ui-data.ts'
import type { CodexModelFamily, QuotaSnapshot, SessionUsage, TaskDetail, TaskUsage, UsageBreakdownRow, UsageTimePoint, UsageTotals } from '../usage-ledger.ts'

const API = '/plugins/dsh-openai-codex/usage'
const families: CodexModelFamily[] = ['sol', 'terra', 'luna', 'other']
const familyColors: Record<CodexModelFamily, string> = { sol: '#8b5cf6', terra: '#10b981', luna: '#3b82f6', other: '#94a3b8' }
const familyLabels: Record<CodexModelFamily, string> = { sol: 'Sol', terra: 'Terra', luna: 'Luna', other: 'Other' }
const hairline = '1px solid color-mix(in srgb, var(--dsw-alias-border-l2, #374151) 62%, transparent)'
const panel: CSSProperties = { color: 'var(--dsw-alias-label-primary, #e5e7eb)', background: 'var(--dsw-alias-bg-layer-1, #111827)', border: hairline, boxShadow: '0 12px 36px rgba(0,0,0,.18)' }
const section: CSSProperties = { color: 'var(--dsw-alias-label-primary, #e5e7eb)', borderTop: hairline, padding: '18px 0' }
const button: CSSProperties = { color: 'inherit', background: 'var(--dsw-alias-bg-layer-1, transparent)', border: hairline, borderRadius: 8, padding: '5px 10px', minHeight: 32, cursor: 'pointer', font: 'inherit', fontSize: 12 }
const muted: CSSProperties = { color: 'var(--dsw-alias-label-secondary, #9ca3af)' }

interface CurrentSessionPayload { session: SessionUsage | null; quota: QuotaSnapshot[]; showUsageHud: boolean; pinUsageHud: boolean }
function downloadUsageReport(report: ReturnType<typeof createUsageReport>): void {
  const blob = new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'codex-usage-' + report.generatedAt.slice(0, 10) + '.json'
  anchor.click()
  URL.revokeObjectURL(url)
}

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}
function formatPercent(value: number): string { return `${String(value)}%` }
function weeklyQuota(quota: QuotaSnapshot[]): QuotaSnapshot | undefined { return quota.find(item => item.quotaId === 'codex' && item.windowSeconds === 604_800) ?? quota.find(item => item.windowSeconds === 604_800) }
async function getJson<T>(path: string): Promise<T> { const response = await fetch(`${API}${path}`, { headers: { accept: 'application/json' }, cache: 'no-store' }); if (!response.ok) throw new Error(`Usage API ${response.status}`); return response.json() as Promise<T> }
function Metric({ label, value, sub }: { label: string; value: string; sub?: string | undefined }) {
  return <div style={{ minWidth: 0, paddingRight: 12 }}>
    <div style={{ ...muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.09em' }}>{label}</div>
    <div style={{ fontSize: 20, fontWeight: 650, lineHeight: 1.25, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
    {sub === undefined ? null : <div style={{ ...muted, fontSize: 10, marginTop: 2 }}>{sub}</div>}
  </div>
}

function Hud({ sessionId, modelDirectory }: { sessionId?: string | undefined; modelDirectory: CodexHudModelDirectory }) {
  const [payload, setPayload] = useState<CurrentSessionPayload>()
  const selection = useSyncExternalStore(modelDirectory.store.subscribe, modelDirectory.store.getSnapshot, modelDirectory.store.getSnapshot).current
  const active = isOpenAICodexSelection(selection)
  const refresh = useCallback(() => {
    if (sessionId === undefined || sessionId === '' || !active) {
      setPayload(undefined)
      return
    }
    void getJson<CurrentSessionPayload>(`/current-session?sessionId=${encodeURIComponent(sessionId)}`).then(setPayload, () => {})
  }, [active, sessionId])
  useEffect(() => {
    void modelDirectory.load().catch(() => {})
  }, [modelDirectory])
  useEffect(() => {
    if (!active) {
      setPayload(undefined)
      return
    }
    refresh()
    const source = new EventSource(`${API}/events`)
    source.addEventListener('usage', refresh)
    return () => { source.close() }
  }, [active, refresh])
  if (sessionId === undefined || payload?.showUsageHud === false || !active) return null
  const accountWeek = weeklyQuota(payload?.quota ?? [])
  if (accountWeek === undefined) return null
  const pinned = payload?.pinUsageHud === true
  const explanation = 'OpenAI account weekly usage, shown at the precision returned by the server.'
  return <div style={{
    boxSizing: 'border-box',
    width: 'calc(100% - 2 * var(--dsh-composer-side-clearance))',
    maxWidth: 'var(--dsh-composer-card-max-width)',
    margin: '0 auto',
    display: 'flex', justifyContent: 'flex-start', pointerEvents: 'none',
  }}>
    <output aria-label="Codex weekly usage" title={explanation} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
      padding: '3px 8px', borderRadius: 999,
      border: pinned ? '1px solid color-mix(in srgb, var(--dsw-alias-border-l2, #374151) 72%, transparent)' : '1px solid transparent',
      background: pinned ? 'color-mix(in srgb, var(--dsw-alias-bg-layer-1, #111827) 72%, transparent)' : 'transparent',
      color: 'var(--dsw-alias-label-secondary, #9ca3af)',
      fontSize: 10, lineHeight: '14px', fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    }}>
      <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--dsw-alias-brand-primary, #8b5cf6)', flex: '0 0 auto' }} />
      <span>Week</span>
      <strong style={{ color: 'var(--dsw-alias-label-primary, #e5e7eb)', fontWeight: 600 }}>{formatPercent(accountWeek.usedPercent)} used</strong>
    </output>
  </div>
}
function params(range: string, models: string[], reasoning: string[], start: string, end: string): string {
  const query = new URLSearchParams({ range }); for (const model of models) query.append('model', model); for (const effort of reasoning) query.append('reasoning', effort); if (range === 'custom' && start !== '') query.set('start', String(new Date(start).getTime())); if (range === 'custom' && end !== '') query.set('end', String(new Date(end).getTime() + 86_399_999)); return query.toString()
}

function Trend({ points, metric }: { points: UsageTimePoint[]; metric: 'tokens' | 'requests' }) {
  const [hovered, setHovered] = useState<number>()
  const buckets = useMemo(() => {
    const grouped = new Map<number, Partial<Record<CodexModelFamily, number>>>()
    for (const point of points) {
      const values = grouped.get(point.timestamp) ?? {}
      values[point.modelFamily] = metric === 'tokens' ? point.tokens : point.requests
      grouped.set(point.timestamp, values)
    }
    return [...grouped.entries()].sort(([left], [right]) => left - right).map(([timestamp, values]) => ({
      timestamp,
      values,
      total: families.reduce((sum, family) => sum + (values[family] ?? 0), 0),
    }))
  }, [points, metric])
  const maximum = Math.max(1, ...buckets.map(bucket => bucket.total))
  const formatValue = (value: number): string => metric === 'tokens' ? formatTokens(value) : String(value)
  if (buckets.length === 0) return <div style={{ ...muted, padding: 28, textAlign: 'center' }}>No usage in this period.</div>
  const labelAt = (index: number): string => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(buckets[index]?.timestamp)
  const middle = Math.floor((buckets.length - 1) / 2)
  return <div style={{ display: 'grid', gridTemplateColumns: '48px minmax(0, 1fr)', gridTemplateRows: '168px auto', columnGap: 8, rowGap: 7, marginTop: 12 }}>
    <div aria-label={metric + ' y axis'} style={{ position: 'relative', ...muted, fontSize: 9, fontVariantNumeric: 'tabular-nums' }}>
      <span style={{ position: 'absolute', top: -5, right: 0 }}>{formatValue(maximum)}</span>
      <span style={{ position: 'absolute', top: '50%', right: 0, transform: 'translateY(-50%)' }}>{formatValue(maximum / 2)}</span>
      <span style={{ position: 'absolute', bottom: -4, right: 0 }}>0</span>
    </div>
    <div style={{ position: 'relative', minWidth: 0 }}>
      {[0, 50, 100].map(position => <i key={position} aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, top: position + '%', borderTop: hairline, opacity: position === 100 ? .75 : .38 }} />)}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'end', gap: 3 }}>
        {buckets.map((bucket, index) => {
          const active = hovered === bucket.timestamp
          const details = families.map(family => familyLabels[family] + ' ' + formatValue(bucket.values[family] ?? 0)).join(', ')
          return <div key={bucket.timestamp} tabIndex={0} aria-label={new Date(bucket.timestamp).toLocaleString() + ': ' + details} onMouseEnter={() => { setHovered(bucket.timestamp) }} onMouseLeave={() => { setHovered(undefined) }} onFocus={() => { setHovered(bucket.timestamp) }} onBlur={() => { setHovered(undefined) }} style={{ position: 'relative', minWidth: 8, flex: 1, height: '100%', display: 'flex', flexDirection: 'column-reverse', justifyContent: 'flex-start', outline: 'none' }}>
            {families.map(family => {
              const value = bucket.values[family] ?? 0
              return value === 0 ? null : <div key={family} style={{ height: value / maximum * 100 + '%', minHeight: 1, background: familyColors[family], opacity: active ? 1 : .78 }} />
            })}
            {active ? <div role="tooltip" style={{ position: 'absolute', zIndex: 2, left: index === 0 ? 0 : index === buckets.length - 1 ? 'auto' : '50%', right: index === buckets.length - 1 ? 0 : 'auto', top: 8, transform: index === 0 || index === buckets.length - 1 ? 'none' : 'translateX(-50%)', width: 174, padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2, #1f2937)', border: hairline, boxShadow: '0 8px 24px rgba(0,0,0,.22)', fontSize: 10, pointerEvents: 'none' }}>
              <b style={{ display: 'block', marginBottom: 5 }}>{new Date(bucket.timestamp).toLocaleString()}</b>
              {families.map(family => <span key={family} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, color: familyColors[family] }}><span>{familyLabels[family]}</span><span>{formatValue(bucket.values[family] ?? 0)}</span></span>)}
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: 14, borderTop: hairline, marginTop: 5, paddingTop: 5 }}><b>Total</b><b>{formatValue(bucket.total)}</b></span>
            </div> : null}
          </div>
        })}
      </div>
    </div>
    <div style={{ ...muted, fontSize: 9, textAlign: 'right', textTransform: 'capitalize' }}>{metric}</div>
    <div aria-label="Time x axis" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', ...muted, fontSize: 9 }}>
      <span>{labelAt(0)}</span><span style={{ textAlign: 'center' }}>{labelAt(middle)}</span><span style={{ textAlign: 'right' }}>{labelAt(buckets.length - 1)}</span>
    </div>
  </div>
}

function Analytics() {
  const [range, setRange] = useState('7d'), [models, setModels] = useState<string[]>([]), [reasoning, setReasoning] = useState<string[]>([]), [start, setStart] = useState(''), [end, setEnd] = useState('')
  const [metric, setMetric] = useState<'tokens' | 'requests'>('tokens'), [data, setData] = useState<AnalyticsPayload>(), [detail, setDetail] = useState<TaskDetail>(), [error, setError] = useState<string>()
  const query = useMemo(() => params(range, models, reasoning, start, end), [range, models, reasoning, start, end])
  const refresh = useCallback(() => { const suffix = `?${query}`, weeklyQuery = params('this-week', models, reasoning, '', ''); void Promise.all([getJson<UsageTotals>(`/summary${suffix}`), getJson<UsageTimePoint[]>(`/timeseries${suffix}`), getJson<UsageBreakdownRow[]>(`/models${suffix}`), getJson<UsageBreakdownRow[]>(`/reasoning${suffix}`), getJson<TaskUsage[]>(`/tasks${suffix}`), getJson<SessionUsage[]>(`/sessions${suffix}`), getJson<{ snapshots: QuotaSnapshot[] }>('/quota'), getJson<UsageTotals>(`/summary?${weeklyQuery}`), getJson<UsageBreakdownRow[]>(`/models?${weeklyQuery}`)]).then(([summary, timeseries, modelRows, reasoningRows, tasks, sessions, quota, weekly, weeklyModels]) => { setData({ summary, timeseries, models: modelRows, reasoning: reasoningRows, tasks, sessions, quota: quota.snapshots, weekly, weeklyModels }); setError(undefined) }, reason => { setError(reason instanceof Error ? reason.message : String(reason)) }) }, [query, models, reasoning])
  useEffect(() => { refresh(); void getJson('/quota?refresh=1').then(refresh) }, [refresh]); useEffect(() => { const source = new EventSource(`${API}/events`); source.addEventListener('usage', refresh); return () => { source.close() } }, [refresh])
  const summary = data?.summary, quota = weeklyQuota(data?.quota ?? [])
  return <div style={{ width: '100%', minWidth: 0, color: 'var(--dsw-alias-label-primary, #e5e7eb)' }}><div style={{ maxWidth: 1180 }}>
    <header style={{ paddingBottom: 2 }}><h1 style={{ margin: 0, fontSize: 20, fontWeight: 650, letterSpacing: '-.02em' }}>Codex Usage Analytics</h1><div style={{ ...muted, marginTop: 4 }}>Local request ledger and separate OpenAI account quota</div></header>
    <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', margin: '16px 0 14px' }}><select aria-label="Time range" value={range} onChange={event => { setRange(event.currentTarget.value) }} style={button}><option value="today">Today</option><option value="24h">24 Hours</option><option value="7d">7 Days</option><option value="this-week">This Week</option><option value="30d">30 Days</option><option value="90d">90 Days</option><option value="all">All Time</option><option value="custom">Custom</option></select><select aria-label="Model" value={models[0] ?? ''} onChange={event => { const value = event.currentTarget.value; setModels(value === '' ? [] : [value]) }} style={{ ...button, minWidth: 120 }}><option value="">All models</option>{families.map(family => <option key={family} value={family}>{familyLabels[family]}</option>)}</select><select aria-label="Reasoning effort" value={reasoning[0] ?? ''} onChange={event => { const value = event.currentTarget.value; setReasoning(value === '' ? [] : [value]) }} style={{ ...button, minWidth: 132 }}><option value="">All reasoning</option>{['none', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => <option key={value}>{value}</option>)}</select>{range !== 'custom' ? null : <><input aria-label="Start date" type="date" value={start} onChange={event => { setStart(event.currentTarget.value) }} style={button} /><input aria-label="End date" type="date" value={end} onChange={event => { setEnd(event.currentTarget.value) }} style={button} /></>}<button style={button} onClick={() => { void getJson('/quota?refresh=1').then(refresh) }}>Refresh</button><button style={{ ...button, opacity: data === undefined ? .5 : 1 }} disabled={data === undefined} onClick={() => { if (data !== undefined) downloadUsageReport(createUsageReport(data, { range, models, reasoning, start, end, metric })) }}>Download JSON</button>{models.length === 0 && reasoning.length === 0 ? null : <button style={button} onClick={() => { setModels([]); setReasoning([]) }}>Clear</button>}</div>
    {error === undefined ? null : <div style={{ color: '#f59e0b', marginBottom: 12 }}>{error}</div>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '16px 24px', padding: '16px 0', borderTop: hairline, borderBottom: hairline }}><Metric label="Total Tokens" value={formatTokens(summary?.totalTokens ?? 0)} /><Metric label="Weekly Used" value={quota === undefined ? 'N/A' : formatPercent(quota.usedPercent)} sub="OpenAI account quota" /><Metric label="Requests" value={String(summary?.requests ?? 0)} /><Metric label="Tasks" value={String(summary?.tasks ?? 0)} /><Metric label="Sessions" value={String(summary?.sessions ?? 0)} /><Metric label="Cache Hit Rate" value={summary?.cacheHitRate == null ? 'N/A' : `${(summary.cacheHitRate * 100).toFixed(1)}%`} /></div>
    <section style={{ ...section, marginTop: 14 }}><div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}><h2 style={{ margin: 0, fontSize: 13 }}>Usage Over Time</h2><div>{(['tokens', 'requests'] as const).map(value => <button key={value} onClick={() => { setMetric(value) }} style={{ ...button, background: metric === value ? 'rgba(139,92,246,.24)' : 'transparent', marginLeft: 5 }}>{value}</button>)}</div></div><Trend points={data?.timeseries ?? []} metric={metric} /><div style={{ display: 'flex', gap: 12, ...muted, fontSize: 11 }}>{families.map(family => <span key={family}><i style={{ display: 'inline-block', width: 8, height: 8, background: familyColors[family], marginRight: 4 }} />{familyLabels[family]}</span>)}</div></section>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14, marginTop: 14 }}><ModelBreakdown rows={data?.models ?? []} select={key => { setModels([key]) }} /><ReasoningBreakdown rows={data?.reasoning ?? []} select={key => { setReasoning([key]) }} /><TokenBreakdown summary={summary} /></div>
    <Weekly data={data} quota={quota} />
    <Tasks tasks={data?.tasks ?? []} open={task => { void getJson<TaskDetail>(`/tasks/${encodeURIComponent(task.taskId)}`).then(setDetail) }} />
    <SessionTotals sessions={data?.sessions ?? []} />
  </div>{detail === undefined ? null : <TaskDetailModal detail={detail} close={() => { setDetail(undefined) }} />}</div>
}

function ModelBreakdown({ rows, select }: { rows: UsageBreakdownRow[]; select(key: string): void }) { return <section style={{ ...section }}><h2 style={{ marginTop: 0, fontSize: 13 }}>Model Breakdown</h2><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}><thead><tr><th align="left">Model</th><th align="right">Tokens</th><th align="right">Tasks</th><th align="right">Requests</th></tr></thead><tbody>{rows.map(row => <tr key={row.key} onClick={() => { select(row.key) }} style={{ cursor: 'pointer', borderTop: hairline }}><td style={{ padding: '8px 0' }}>{row.label}</td><td align="right">{formatTokens(row.totalTokens)}</td><td align="right">{row.tasks}</td><td align="right">{row.requests}</td></tr>)}</tbody></table></section> }
function TokenBreakdown({ summary }: { summary?: UsageTotals | undefined }) { return <section style={{ ...section }}><h2 style={{ marginTop: 0, fontSize: 13 }}>Token Breakdown</h2><div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '9px 20px' }}><span>Input</span><b>{formatTokens(summary?.inputTokens ?? 0)}</b><span style={muted}>↳ Cached input (subset)</span><b>{formatTokens(summary?.cachedInputTokens ?? 0)}</b><span>Output</span><b>{formatTokens(summary?.outputTokens ?? 0)}</b><span style={muted}>↳ Reasoning (subset)</span><b>{formatTokens(summary?.reasoningTokens ?? 0)}</b><span>Total (Input + Output)</span><b>{formatTokens(summary?.totalTokens ?? 0)}</b></div></section> }
function Weekly({ data, quota }: { data?: AnalyticsPayload | undefined; quota?: QuotaSnapshot | undefined }) { return <><section style={{ ...section, marginTop: 14 }}><h2 style={{ marginTop: 0, fontSize: 13 }}>This Week — Local Codex Usage</h2><div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '7px 20px', maxWidth: 600 }}><b>Model</b><b>Tokens</b>{families.map(family => { const row = data?.weeklyModels.find(item => item.key === family); return [<span key={`${family}-name`}>{familyLabels[family]}</span>, <span key={`${family}-tokens`}>{formatTokens(row?.totalTokens ?? 0)}</span>] })}<b>Total</b><b>{formatTokens(data?.weekly.totalTokens ?? 0)}</b></div><div style={{ ...muted, marginTop: 10 }}>{data?.weekly.tasks ?? 0} tasks · {data?.weekly.requests ?? 0} requests</div></section><section style={{ ...section, marginTop: 14 }}><h2 style={{ marginTop: 0, fontSize: 13 }}>OpenAI Account Weekly Quota</h2>{quota === undefined ? <div style={muted}>No weekly quota snapshot available.</div> : <><div style={{ height: 4, background: 'color-mix(in srgb, var(--dsw-alias-border-l2, #374151) 55%, transparent)', borderRadius: 99, overflow: 'hidden' }}><div style={{ width: `${Math.min(100, quota.usedPercent)}%`, height: '100%', background: 'var(--dsw-alias-brand-primary, #8b5cf6)' }} /></div><div style={{ display: 'flex', gap: 24, marginTop: 10 }}><span>Used {formatPercent(quota.usedPercent)}</span><span>Remaining {formatPercent(quota.remainingPercent)}</span><span>Reset {quota.resetAt === undefined ? 'N/A' : new Date(quota.resetAt).toLocaleString()}</span></div><div style={{ ...muted, marginTop: 8 }}>Tracked by this plugin this week: {formatTokens(data?.weekly.totalTokens ?? 0)} tokens. Account quota may include other clients.</div></>}</section></> }
function Tasks({ tasks, open }: { tasks: TaskUsage[]; open(task: TaskUsage): void }) { return <section style={{ ...section, marginTop: 14, overflowX: 'auto' }}><h2 style={{ marginTop: 0, fontSize: 13 }}>Recent Tasks</h2><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 700 }}><thead><tr><th align="left">Time</th><th align="left">Task</th><th align="left">Model</th><th align="left">Reasoning</th><th align="right">Requests</th><th align="right">Tokens</th><th align="right">Duration</th></tr></thead><tbody>{tasks.map(task => <tr key={task.taskId} onClick={() => { open(task) }} style={{ cursor: 'pointer', borderTop: hairline }}><td style={{ padding: '8px 0' }}>{new Date(task.startedAt).toLocaleString()}</td><td>{task.taskId}</td><td>{task.model}</td><td>{task.reasoningEffort}</td><td align="right">{task.requests}</td><td align="right">{formatTokens(task.totalTokens)}</td><td align="right">{(task.durationMs / 1000).toFixed(1)}s</td></tr>)}</tbody></table></section> }
function TaskDetailModal({ detail, close }: { detail: TaskDetail; close(): void }) { return <div style={{ position: 'fixed', inset: 0, zIndex: 1120, background: 'rgba(0,0,0,.65)', display: 'grid', placeItems: 'center', padding: 20 }} onMouseDown={close}><div style={{ ...panel, width: 'min(900px, 95vw)', maxHeight: '88vh', overflow: 'auto', borderRadius: 14, padding: 20 }} onMouseDown={event => { event.stopPropagation() }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><div><h2 style={{ margin: 0 }}>Task Detail</h2><div style={{ ...muted, marginTop: 4 }}>{detail.taskId}</div></div><button style={button} onClick={close}>Close</button></div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 8, margin: '16px 0' }}><Metric label="Tokens" value={formatTokens(detail.totalTokens)} /><Metric label="Model" value={detail.model} /><Metric label="Reasoning" value={detail.reasoningEffort} /><Metric label="Requests" value={String(detail.requests)} /></div>{detail.events.map((event, index) => <div key={event.requestId} style={{ borderTop: hairline, padding: '12px 0' }}><b>Request #{index + 1}</b> · {event.model} / {event.reasoningEffort}<div style={{ ...muted, marginTop: 4 }}>Input {formatTokens(event.inputTokens)} · Cached {formatTokens(event.cachedInputTokens)} · Output {formatTokens(event.outputTokens)} · Reasoning {formatTokens(event.reasoningTokens)} · Total {formatTokens(event.totalTokens)}</div></div>)}</div></div> }

export function CodexUsageHud({ sessionId, modelDirectory }: { sessionId?: string | undefined; modelDirectory: CodexHudModelDirectory }) { return <Hud sessionId={sessionId} modelDirectory={modelDirectory} /> }
export function CodexUsageAnalyticsSettings() { return <Analytics /> }
