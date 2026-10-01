'use client'

import type { ToolView } from '@/lib/toolview'

/** A one-line description of a tool result, shown next to the tool's name. */
export function toolHeadline(view: ToolView): string {
  switch (view.type) {
    case 'refused':
      return `refused: ${view.reason}`
    case 'failed':
      return view.message
    case 'page':
      return view.title || view.url
    case 'shell':
      return view.timedOut ? 'timed out' : `exit ${view.exitCode}`
    case 'file':
      return view.size != null && !Number.isNaN(view.size) ? `${view.path} (${view.size} bytes)` : view.path
    case 'files':
      return `${view.entries.length} entr${view.entries.length === 1 ? 'y' : 'ies'} in ${view.path || '/'}`
    case 'studio':
      return view.ok ? [view.status, view.id].filter(Boolean).join(' ') : view.message ?? view.status
    case 'text':
      return ''
  }
}

/** The body of a tool result, rendered by kind: page, shell run, file, listing, Studio change, or text. */
export function ToolCard({ view }: { view: ToolView }) {
  switch (view.type) {
    case 'refused':
      return (
        <p className="card card-refused" role="note">
          The computer policy refused this action ({view.reason}). Nothing ran.
        </p>
      )
    case 'failed':
      return <p className="card card-failed">{view.message}</p>
    case 'page':
      return (
        <div className="card card-page">
          <a href={view.url} target="_blank" rel="noreferrer noopener">
            {view.title || view.url}
          </a>
          <div className="muted small">{view.url}</div>
          {view.text && <pre>{view.text}</pre>}
        </div>
      )
    case 'shell':
      return (
        <div className="card card-shell">
          <pre className="command">$ {view.command}</pre>
          {view.stdout && <pre>{view.stdout}</pre>}
          {view.stderr && <pre className="stderr">{view.stderr}</pre>}
        </div>
      )
    case 'file':
      return <div className="card card-file">{view.content != null ? <pre>{view.content}</pre> : <code>{view.path}</code>}</div>
    case 'files':
      return (
        <ul className="card card-files">
          {view.entries.map((entry) => (
            <li key={entry.name}>
              <code>
                {entry.name}
                {entry.type === 'dir' ? '/' : ''}
              </code>
              {entry.size != null && entry.type !== 'dir' && <span className="muted small"> {entry.size} B</span>}
            </li>
          ))}
        </ul>
      )
    case 'studio':
      return null
    case 'text':
      return view.text ? <pre>{view.text}</pre> : null
  }
}
