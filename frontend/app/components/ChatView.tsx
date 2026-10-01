'use client'

import { memo, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { BUILDER_ID, ENGINEER_ID, MANAGER_ID, type AgentSummary } from '@/lib/api'
import type { ChatMessage, ToolCall } from '@/lib/chat'

const REMARK_PLUGINS = [remarkGfm]

/** Starter prompts for the admin agents; user-built agents start empty. */
const STARTERS: Record<string, string[]> = {
  [BUILDER_ID]: [
    'What can you build?',
    'Build a research agent that searches the web and cites sources',
    'Build a calculator agent that explains each step',
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
  agentId: string
  agent?: AgentSummary
  messages: ChatMessage[]
  /** A run for this agent is streaming. */
  busy: boolean
  /** Another agent is streaming; sending is disabled until it finishes. */
  locked: boolean
  onSend: (text: string) => void
  onStop: () => void
  onDecide: (approve: boolean) => void
  onReset: () => void
}

/** Transcript and composer for the selected agent. */
export function ChatView({ agentId, agent, messages, busy, locked, onSend, onStop, onDecide, onReset }: ChatViewProps) {
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
          <h1>{agent?.name ?? agentId}</h1>
          <p className="muted small">
            {agent?.is_component ? 'Built with Platform Builder' : 'Admin agent'}
            {agent?.model?.model ? ` · ${agent.model.model}` : ''}
          </p>
        </div>
        <button className="ghost" onClick={onReset} disabled={busy}>
          New chat
        </button>
      </header>

      <section className="transcript" aria-live="polite">
        {messages.length === 0 && (
          <div className="empty">
            <p>{agent?.description ?? 'Start a conversation.'}</p>
            <div className="starters">
              {(STARTERS[agentId] ?? []).map((prompt) => (
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
          placeholder={locked ? 'Another agent is responding…' : `Message ${agent?.name ?? 'the agent'}…`}
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
  'awaiting-approval': 'needs approval',
}

function ToolChip({ tool }: { tool: ToolCall }) {
  return (
    <li>
      <details className={`tool tool-${tool.status}`}>
        <summary>
          <code>{tool.name}</code> <span className="small">{STATUS_LABEL[tool.status]}</span>
        </summary>
        {tool.args && <pre>{JSON.stringify(tool.args, null, 2)}</pre>}
        {tool.result && <pre>{tool.result}</pre>}
      </details>
    </li>
  )
}
