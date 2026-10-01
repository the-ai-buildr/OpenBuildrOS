'use client'

import { memo, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { BUILDER_ID, ENGINEER_ID, MANAGER_ID, type Channel, type Entity } from '@/lib/api'
import type { ChatMessage, ToolCall } from '@/lib/chat'
import { toolView } from '@/lib/toolview'

import { ToolCard, toolHeadline } from './ToolCard'

const REMARK_PLUGINS = [remarkGfm]

const KIND_LABEL: Record<Entity['kind'], string> = { agents: 'Agent', teams: 'Team', workflows: 'Workflow' }

/** Starter prompts for the admin agents; user-built components start empty. */
const STARTERS: Record<string, string[]> = {
  [BUILDER_ID]: [
    'What can you build?',
    'Build a research agent that searches the web and cites sources',
    'Build a calculator agent that explains each step',
    'Build a team of a researcher and an editor that writes cited briefs',
  ],
  [MANAGER_ID]: [
    'Is the platform healthy?',
    'How many runs and tokens over the last 7 days?',
    'Which agent is slowest, and is anything failing?',
  ],
  [ENGINEER_ID]: [
    'Give me a tour of this platform',
    'How does Platform Builder create agents?',
    'Which tools can user-built agents use?',
  ],
}

interface ChatViewProps {
  entity?: Entity
  /** Id of the selected entity, shown while its listing loads. */
  entityId: string
  /** The user's conversations with this entity, newest first. */
  channels: Channel[]
  /** The open conversation. */
  sessionId?: string
  messages: ChatMessage[]
  /** A run in this conversation is streaming. */
  busy: boolean
  /** Another conversation is streaming; sending is disabled until it finishes. */
  locked: boolean
  onSend: (text: string) => void
  onStop: () => void
  onDecide: (approve: boolean) => void
  onOpenChannel: (sessionId: string) => void
  onNewChannel: () => void
}

/** A channel with one agent, team, or workflow: its transcript, channel switcher, and composer. */
export function ChatView({
  entity,
  entityId,
  channels,
  sessionId,
  messages,
  busy,
  locked,
  onSend,
  onStop,
  onDecide,
  onOpenChannel,
  onNewChannel,
}: ChatViewProps) {
  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const last = messages.at(-1)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  const submit = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || busy || locked) return
    onSend(trimmed)
    setDraft('')
  }

  return (
    <main className="chat">
      <header className="chat-header">
        <div>
          <h1>{entity?.name ?? entityId}</h1>
          <p className="muted small">
            {entity?.is_component ? `${KIND_LABEL[entity.kind]} · built with Platform Builder` : 'Admin agent'}
            {entity?.model?.model ? ` · ${entity.model.model}` : ''}
          </p>
        </div>
        <div className="channel-bar">
          <select
            aria-label="Channel"
            value={channels.some((channel) => channel.session_id === sessionId) ? sessionId : ''}
            onChange={(event) => event.target.value && onOpenChannel(event.target.value)}
            disabled={busy}
          >
            <option value="">{channels.some((c) => c.session_id === sessionId) ? 'Channels' : 'New channel'}</option>
            {channels.map((channel) => (
              <option key={channel.session_id} value={channel.session_id}>
                {channel.session_name || channel.session_id.slice(0, 8)}
              </option>
            ))}
          </select>
          <button className="ghost" onClick={onNewChannel} disabled={busy}>
            New chat
          </button>
        </div>
      </header>

      <section className="transcript" aria-live="polite">
        {messages.length === 0 && (
          <div className="empty">
            <p>{entity?.description ?? 'Start a conversation.'}</p>
            <div className="starters">
              {(STARTERS[entityId] ?? []).map((prompt) => (
                <button key={prompt} className="chip" onClick={() => submit(prompt)} disabled={locked}>
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) => (
          <MessageView key={message.id} message={message} streaming={busy && message === last} />
        ))}
        {last?.paused && !busy && (
          <div className="approval" role="alert">
            <span>This action needs your approval before it runs.</span>
            <button className="primary" onClick={() => onDecide(true)}>
              Approve
            </button>
            <button className="ghost" onClick={() => onDecide(false)}>
              Reject
            </button>
          </div>
        )}
        <div ref={endRef} />
      </section>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          submit(draft)
        }}
      >
        <textarea
          aria-label="Message"
          placeholder={locked ? 'Another conversation is running…' : `Message ${entity?.name ?? entityId}…`}
          value={draft}
          rows={2}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit(draft)
            }
          }}
        />
        {busy ? (
          <button type="button" className="ghost" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="primary" disabled={!draft.trim() || locked}>
            Send
          </button>
        )}
      </form>
    </main>
  )
}

/** One transcript entry. Memoized: finished messages keep their identity, so only the streaming one re-renders. */
const MessageView = memo(function MessageView({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  const thinking = streaming && !message.content && message.tools.length === 0
  return (
    <article className={`message ${message.role}`} data-role={message.role}>
      {message.tools.length > 0 && (
        <ul className="tools">
          {message.tools.map((tool) => (
            <ToolChip key={tool.id} tool={tool} />
          ))}
        </ul>
      )}
      {message.role === 'user' ? (
        <p className="plain">{message.content}</p>
      ) : (
        <div className="markdown">
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{message.content}</ReactMarkdown>
        </div>
      )}
      {thinking && !message.notice && <p className="muted small">Thinking…</p>}
      {message.notice && <p className="muted small notice">{message.notice}</p>}
      {message.error && (
        <p className="error" role="alert">
          {message.error}
        </p>
      )}
    </article>
  )
})

const STATUS_LABEL: Record<ToolCall['status'], string> = {
  running: 'running',
  done: 'done',
  error: 'failed',
  refused: 'refused',
  'awaiting-approval': 'needs approval',
}

/** How each kind of activity line reads: a tool call, a delegated team member, a workflow step. */
const ACTIVITY_PREFIX: Record<NonNullable<ToolCall['kind']>, string> = { tool: '', member: '→ ', step: 'Step: ' }

function ToolChip({ tool }: { tool: ToolCall }) {
  const kind = tool.kind ?? 'tool'
  // Members and steps answer in prose; tool results get a card for their kind.
  const view = kind === 'tool' && tool.result ? toolView(tool.name, tool.args, tool.result) : undefined
  const headline = view ? toolHeadline(view) : ''
  return (
    <li>
      <details className={`tool tool-${tool.status} activity-${kind}`} open={tool.status === 'refused' || undefined}>
        <summary>
          {ACTIVITY_PREFIX[kind]}
          <code>{tool.name}</code> <span className="small">{STATUS_LABEL[tool.status]}</span>
          {headline && tool.status !== 'refused' && <span className="muted small headline"> · {headline}</span>}
        </summary>
        {tool.args && <pre>{JSON.stringify(tool.args, null, 2)}</pre>}
        {view ? <ToolCard view={view} /> : tool.result && <pre>{tool.result}</pre>}
      </details>
    </li>
  )
}
