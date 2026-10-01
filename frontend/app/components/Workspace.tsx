'use client'

/**
 * The OpenBuildrOS workspace: the sidebar of agents, teams, and workflows; the
 * channel view; and the Create and Routines dialogs.
 *
 * Channels are AgentOS sessions, so history lives on the server and follows the
 * user across devices. Runs reconnect on their own when the connection drops
 * (lib/resilient.ts), and a run still going when a channel is opened is reattached.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  BUILDER_ID,
  attachRun,
  cancelRun,
  checkHealth,
  continueRun,
  entityKey,
  listChannels,
  listEntities,
  loadChannel,
  runEntity,
  type Channel,
  type Entity,
  type RunHandlers,
} from '@/lib/api'
import { applyEvents, newMessage, resolvePaused, type ChatMessage } from '@/lib/chat'

import { ChatView } from './ChatView'
import { CreateDialog } from './CreateDialog'
import { RoutinesDialog } from './RoutinesDialog'
import { Sidebar } from './Sidebar'

/** The open conversation with one entity. */
export interface Conversation {
  sessionId: string
  messages: ChatMessage[]
}

const BUILDER_KEY = `agents:${BUILDER_ID}`
const HEALTH_POLL_MS = 30_000
const NO_MESSAGES: ChatMessage[] = []
const NO_CHANNELS: Channel[] = []

const freshConversation = (): Conversation => ({ sessionId: crypto.randomUUID(), messages: [] })
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function Workspace() {
  const [entities, setEntities] = useState<Entity[]>([])
  const [selectedKey, setSelectedKey] = useState(BUILDER_KEY)
  const [channels, setChannels] = useState<Record<string, Channel[]>>({})
  const [conversations, setConversations] = useState<Record<string, Conversation>>({})
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [healthy, setHealthy] = useState<boolean | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'create' | 'routines' | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // Bumped whenever the user picks what a conversation shows, so a slower load cannot overwrite it.
  const viewVersion = useRef<Record<string, number>>({})
  const claimView = (key: string) => (viewVersion.current[key] = (viewVersion.current[key] ?? 0) + 1)

  const selected = entities.find((entity) => entityKey(entity) === selectedKey)
  const entityOf = useCallback((key: string) => {
    const [kind, ...id] = key.split(':')
    return { kind: kind as Entity['kind'], id: id.join(':') }
  }, [])

  const refreshEntities = useCallback(async () => {
    try {
      setEntities(await listEntities())
      setLoadError(null)
    } catch (error) {
      setLoadError(errorText(error))
    }
  }, [])

  const refreshChannels = useCallback(
    async (key: string) => {
      try {
        const list = await listChannels(entityOf(key))
        setChannels((all) => ({ ...all, [key]: list }))
        return list
      } catch {
        return []
      }
    },
    [entityOf],
  )

  useEffect(() => {
    void refreshEntities()
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
  }, [refreshEntities])

  /** Replace the last (assistant) message of a conversation. */
  const patchLast = useCallback((key: string, update: (message: ChatMessage) => ChatMessage) => {
    setConversations((all) => {
      const current = all[key]
      if (!current?.messages.length) return all
      const messages = [...current.messages]
      messages[messages.length - 1] = update(messages[messages.length - 1])
      return { ...all, [key]: { ...current, messages } }
    })
  }, [])

  /** Run `stream` for the conversation `key`, folding each batch of events into the last message. */
  const drive = useCallback(
    async (key: string, stream: (handlers: RunHandlers) => Promise<void>) => {
      const controller = new AbortController()
      abortRef.current = controller
      setBusyKey(key)
      try {
        await stream({
          onEvents: (events) => patchLast(key, (message) => applyEvents(message, events)),
          onReconnect: (attempt, max) =>
            patchLast(key, (message) => ({ ...message, notice: `Connection lost. Reconnecting (${attempt}/${max})…` })),
          signal: controller.signal,
        })
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === 'AbortError'
        patchLast(key, (message) =>
          aborted ? { ...message, notice: 'Stopped.' } : { ...message, error: errorText(error), notice: undefined },
        )
      } finally {
        patchLast(key, (message) => ({ ...message, done: true }))
        setBusyKey(null)
        abortRef.current = null
        void refreshChannels(key)
        // The Builder may have created, edited, or archived something.
        if (key === BUILDER_KEY) void refreshEntities()
      }
    },
    [patchLast, refreshChannels, refreshEntities],
  )

  /** Open a stored channel, reattaching to its last run if that run is still going. */
  const openChannel = useCallback(
    async (key: string, sessionId: string, version = claimView(key)) => {
      const entity = entityOf(key)
      let messages: ChatMessage[]
      try {
        messages = await loadChannel(entity.kind, sessionId)
      } catch (error) {
        setLoadError(errorText(error))
        return
      }
      if (viewVersion.current[key] !== version) return
      setConversations((all) => ({ ...all, [key]: { sessionId, messages } }))
      const last = messages.at(-1)
      if (last && !last.done && last.runId && busyKey === null) {
        const runId = last.runId
        void drive(key, (handlers) => attachRun(entity, runId, sessionId, handlers))
      }
    },
    [entityOf, drive, busyKey],
  )

  // First visit to an entity: open its latest channel, or start a fresh one.
  useEffect(() => {
    if (conversations[selectedKey]) return
    const key = selectedKey
    const version = claimView(key)
    void refreshChannels(key).then((list) => {
      if (viewVersion.current[key] !== version) return
      if (list.length) void openChannel(key, list[0].session_id, version)
      else setConversations((all) => (all[key] ? all : { ...all, [key]: freshConversation() }))
    })
  }, [selectedKey, conversations, refreshChannels, openChannel])

  const startChannel = (key: string) => {
    claimView(key)
    setConversations((all) => ({ ...all, [key]: freshConversation() }))
  }

  const send = (key: string, text: string) => {
    claimView(key)
    const base = conversations[key] ?? freshConversation()
    setConversations((all) => ({
      ...all,
      [key]: { ...base, messages: [...base.messages, newMessage('user', text), newMessage('assistant')] },
    }))
    void drive(key, (handlers) => runEntity(entityOf(key), text, base.sessionId, handlers))
  }

  const conversation = conversations[selectedKey]
  const messages = conversation?.messages ?? NO_MESSAGES

  const decide = (approve: boolean) => {
    const paused = messages.at(-1)?.paused
    if (!conversation || !paused) return
    const key = selectedKey
    patchLast(key, (message) => ({ ...message, paused: undefined, done: false }))
    const tools = resolvePaused(paused, approve)
    void drive(key, (handlers) => continueRun(entityOf(key), paused.runId, conversation.sessionId, tools, handlers))
  }

  /**
   * Stop the streaming run. It runs detached on the server, so cancel it there and let
   * its stream close with RunCancelled; abort locally only if that is not possible.
   */
  const stop = () => {
    if (!busyKey) return
    const key = busyKey
    const runId = conversations[key]?.messages.at(-1)?.runId
    if (!runId) {
      abortRef.current?.abort()
      return
    }
    patchLast(key, (message) => ({ ...message, notice: 'Stopping…' }))
    cancelRun(entityOf(key), runId).catch(() => abortRef.current?.abort())
  }

  return (
    <div className="shell">
      <Sidebar
        entities={entities}
        selectedKey={selectedKey}
        healthy={healthy}
        loadError={loadError}
        onSelect={setSelectedKey}
        onCreate={() => setDialog('create')}
        onRoutines={() => setDialog('routines')}
      />
      <ChatView
        entity={selected}
        entityId={entityOf(selectedKey).id}
        channels={channels[selectedKey] ?? NO_CHANNELS}
        sessionId={conversation?.sessionId}
        messages={messages}
        busy={busyKey === selectedKey}
        locked={busyKey !== null && busyKey !== selectedKey}
        onSend={(text) => send(selectedKey, text)}
        onStop={stop}
        onDecide={decide}
        onOpenChannel={(sessionId) => void openChannel(selectedKey, sessionId)}
        onNewChannel={() => startChannel(selectedKey)}
      />
      {dialog === 'create' && (
        <CreateDialog
          agents={entities.filter((entity) => entity.kind === 'agents' && entity.is_component)}
          onClose={() => setDialog(null)}
          onSubmit={(prompt) => {
            setDialog(null)
            setSelectedKey(BUILDER_KEY)
            send(BUILDER_KEY, prompt)
          }}
        />
      )}
      {dialog === 'routines' && <RoutinesDialog onClose={() => setDialog(null)} />}
    </div>
  )
}
