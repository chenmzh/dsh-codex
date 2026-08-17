import type { CSSProperties } from 'react'
import type { SessionUsage, UsageBreakdownRow } from '../usage-ledger.ts'

const panel: CSSProperties = {
  color: 'var(--dsw-alias-label-primary, #e5e7eb)',
  background: 'transparent',
  border: 0,
  borderTop: '1px solid color-mix(in srgb, var(--dsw-alias-border-l2, #374151) 62%, transparent)',
  boxShadow: 'none',
  borderRadius: 0,
  padding: '18px 0',
}
const border = '1px solid color-mix(in srgb, var(--dsw-alias-border-l2, #374151) 62%, transparent)'

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

export function ReasoningBreakdown({ rows, select }: {
  rows: UsageBreakdownRow[]
  select(key: string): void
}) {
  return <section style={panel}>
    <h2 style={{ marginTop: 0, fontSize: 13 }}>Reasoning Breakdown</h2>
    {rows.map(row => <div key={row.key} onClick={() => { select(row.key) }} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, cursor: 'pointer', padding: '8px 0', borderTop: border }}>
      <span>{row.label}</span><span>{tokens(row.totalTokens)} tok</span>
    </div>)}
  </section>
}

export function SessionTotals({ sessions }: { sessions: SessionUsage[] }) {
  return <section style={{ ...panel, marginTop: 14, overflowX: 'auto' }}>
    <h2 style={{ marginTop: 0, fontSize: 13 }}>Session Totals</h2>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead><tr><th align="left">Session</th><th align="right">Tasks</th><th align="right">Requests</th><th align="right">Tokens</th></tr></thead>
      <tbody>{sessions.map(session => <tr key={session.sessionId} style={{ borderTop: border }}>
        <td style={{ padding: '8px 0' }}>{session.sessionId}</td><td align="right">{session.tasks}</td><td align="right">{session.requests}</td><td align="right">{tokens(session.totalTokens)}</td>
      </tr>)}</tbody>
    </table>
  </section>
}
