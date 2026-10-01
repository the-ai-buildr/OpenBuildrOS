'use client'

import { useEffect, useState } from 'react'

import { listAudit, screenUrl, type AuditRow } from '@/lib/api'

const REFRESH_MS = 2500

interface ComputerPanelProps {
  botId: string
  /** A run is streaming: refresh the screen and activity while it works. */
  active: boolean
}

/**
 * The bot's own computer: a live view of its browser and the gateway's record of
 * every action it took or was refused.
 */
export function ComputerPanel({ botId, active }: ComputerPanelProps) {
  const [nonce, setNonce] = useState(() => Date.now())
  const [rows, setRows] = useState<AuditRow[]>([])
  // The refresh whose screen failed to load (the computer may not have started yet); each refresh retries.
  const [failedNonce, setFailedNonce] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const tick = () => {
      setNonce(Date.now())
      listAudit(botId)
        .then((next) => !cancelled && setRows(next))
        .catch(() => undefined)
    }
    tick()
    if (!active) {
      return () => {
        cancelled = true
      }
    }
    const timer = setInterval(tick, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
      tick()
    }
  }, [botId, active])

  return (
    <aside className="computer" aria-label="Computer">
      <header>
        <h2>Computer</h2>
        <span className={`small ${active ? 'live' : 'muted'}`}>{active ? '● working' : 'idle'}</span>
      </header>
      <div className="screen">
        {/* eslint-disable-next-line @next/next/no-img-element -- live PNG from the proxy, not a static asset */}
        <img
          key={nonce}
          src={screenUrl(botId, nonce)}
          alt={`${botId}'s screen`}
          hidden={failedNonce === nonce}
          onError={() => setFailedNonce(nonce)}
        />
        {failedNonce === nonce && (
          <p className="muted small">The computer starts the first time this bot uses it.</p>
        )}
      </div>
      <h3>Activity</h3>
      <ol className="audit" data-testid="computer-activity">
        {rows.length === 0 && <li className="muted small">No computer actions yet.</li>}
        {rows.map((row) => (
          <li key={row.id} className={`audit-${row.decision}`} title={row.rule || row.detail || undefined}>
            <span className="badge">{row.decision}</span>
            <code>{row.tool}</code>
            <span className="target">{row.target}</span>
            {row.decision !== 'allowed' && <span className="why small">{row.rule || row.detail}</span>}
          </li>
        ))}
      </ol>
    </aside>
  )
}
