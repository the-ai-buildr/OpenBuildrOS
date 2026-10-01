'use client'

/**
 * The OpenBuildrOS workspace: agent sidebar, chat, and the "Create agent" dialog.
 *
 * Conversations are kept per agent in localStorage (messages plus the AgentOS
 * session id), so a reload resumes where the user left off.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  BUILDER_ID,
  checkHealth,
  continueRun,
  listAgents,
  runAgent,
  type AgentSummary,
  type EventsHandler,
} from '@/lib/api'
import { applyEvents, newMessage, resolvePaused, type ChatMessage } from '@/lib/chat'

import { ChatView } from './ChatView'
import { CreateAgentDialog } from './CreateAgentDialog'
import { Sidebar } from './Sidebar'

/** One agent's conversation. */
export interface Conversation {
  sessionId: string
  messages: ChatMessage[]
}

const STORAGE_KEY = 'openbuildr.conversations.v1'
const HEALTH_POLL_MS = 30_000
const NO_MESSAGES: ChatMessage[] = []

function loadConversations(): Record<string, Conversation> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, Conversation>
  } catch {
    return {}
  }
}

export function Workspace() {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [selectedId, setSelectedId] = useState<string>(BUILDER_ID)
  const [conversations, setConversations] = useState<Record<string, Conversation>>({})
  const [busyAgent, setBusyAgent] = useState<string | null>(null)
  const [healthy, setHealthy] = useState<boolean | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const refreshAgents = useCallback(async () => {
    try {
      setAgents(await listAgents())
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    // Hydrate from localStorage after mount: the server render has no storage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConversations(loadConversations())
    void refreshAgents()
    const poll = () => {
      if (document.visibilityState === 'visible') void checkHealth().then(setHealthy)
    }
    poll()
    const timer = setInterval(poll, HEALTH_POLL_MS)
    document.addEventListener('visibilitychange', poll)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [refreshAgents])

  // Persist between runs only: writing the whole history on every streamed batch is wasted work.
  useEffect(() => {
    if (busyAgent !== null) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations))
    } catch {
      // Storage full or blocked: the chat still works for this page view.
    }
  }, [conversations, busyAgent])

  /** Replace the last (assistant) message of an agent's conversation. */
  const patchLast = useCallback((agentId: string, update: (message: ChatMessage) => ChatMessage) => {
    setConversations((all) => {
      const current = all[agentId]
      if (!current?.messages.length) return all
      const messages = [...current.messages]
      messages[messages.length - 1] = update(messages[messages.length - 1])
      return { ...all, [agentId]: { ...current, messages } }
    })
  }, [])

  /** Run `stream` for `agentId`, folding each batch of events into the last message. */
  const drive = useCallback(
    async (agentId: string, stream: (onEvents: EventsHandler, signal: AbortSignal) => Promise<void>) => {
      const controller = new AbortController()
      abortRef.current = controller
      setBusyAgent(agentId)
      try {
        await stream((events) => patchLast(agentId, (message) => applyEvents(message, events)), controller.signal)
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          const text = error instanceof Error ? error.message : String(error)
          patchLast(agentId, (message) => ({ ...message, error: text }))
        }
      } finally {
        patchLast(agentId, (message) => ({ ...message, done: true }))
        setBusyAgent(null)
        abortRef.current = null
        // The Builder may have created, edited, or archived agents.
        if (agentId === BUILDER_ID) void refreshAgents()
      }
    },
    [patchLast, refreshAgents],
  )

  const send = (agentId: string, text: string) => {
    const base = conversations[agentId] ?? { sessionId: crypto.randomUUID(), messages: [] }
    setConversations((all) => ({
      ...all,
      [agentId]: { ...base, messages: [...base.messages, newMessage('user', text), newMessage('assistant')] },
    }))
    void drive(agentId, (onEvents, signal) => runAgent(agentId, text, base.sessionId, onEvents, signal))
  }

  const conversation = conversations[selectedId]
  const messages = conversation?.messages ?? NO_MESSAGES

  const decide = (approve: boolean) => {
    const paused = messages.at(-1)?.paused
    if (!conversation || !paused) return
    const agentId = selectedId
    patchLast(agentId, (message) => ({ ...message, paused: undefined, done: false }))
    const tools = resolvePaused(paused, approve)
    void drive(agentId, (onEvents, signal) =>
      continueRun(agentId, paused.runId, conversation.sessionId, tools, onEvents, signal),
    )
  }

  const userAgents = agents.filter((agent) => agent.is_component)

  return (
    <div className="shell">
      <Sidebar
        adminAgents={agents.filter((agent) => !agent.is_component)}
        userAgents={userAgents}
        selectedId={selectedId}
        healthy={healthy}
        loadError={loadError}
        onSelect={setSelectedId}
        onCreate={() => setCreating(true)}
      />
      <ChatView
        agentId={selectedId}
        agent={agents.find((agent) => agent.id === selectedId)}
        messages={messages}
        busy={busyAgent === selectedId}
        locked={busyAgent !== null && busyAgent !== selectedId}
        onSend={(text) => send(selectedId, text)}
        onStop={() => abortRef.current?.abort()}
        onDecide={decide}
        onReset={() =>
          setConversations((all) => {
            const rest = { ...all }
            delete rest[selectedId]
            return rest
          })
        }
      />
      {creating && (
        <CreateAgentDialog
          onClose={() => setCreating(false)}
          onSubmit={(prompt) => {
            setCreating(false)
            setSelectedId(BUILDER_ID)
            send(BUILDER_ID, prompt)
          }}
        />
      )}
    </div>
  )
}
