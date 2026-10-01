/**
 * Chat state for one agent conversation, driven by AgentOS stream events.
 *
 * Everything here is pure so it can be unit-tested without a browser.
 */

import type { AgentEvent } from './sse'

/** A tool call made by the agent during a run, as shown in the transcript. */
export interface ToolCall {
  id: string
  name: string
  args?: Record<string, unknown>
  result?: string
  status: 'running' | 'done' | 'error' | 'awaiting-approval'
}

/** A run paused on confirmation-gated tools, waiting for the user to approve or reject. */
export interface PausedRun {
  runId: string
  /** Raw tool executions from the `RunPaused` event; echoed back with `confirmed` set. */
  tools: Record<string, unknown>[]
}

/** One transcript entry. */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  tools: ToolCall[]
  error?: string
  paused?: PausedRun
  done?: boolean
}

/** Create an empty message for `role` with a fresh id. */
export function newMessage(role: ChatMessage['role'], content = ''): ChatMessage {
  return { id: crypto.randomUUID(), role, content, tools: [] }
}

interface EventTool {
  tool_call_id?: string
  tool_name?: string
  tool_args?: Record<string, unknown>
  result?: unknown
  tool_call_error?: boolean
}

function toText(value: unknown): string {
  if (value == null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function upsertTool(tools: ToolCall[], raw: EventTool, patch: Partial<ToolCall>): ToolCall[] {
  const id = raw.tool_call_id ?? raw.tool_name ?? 'tool'
  const existing = tools.find((tool) => tool.id === id)
  if (existing) return tools.map((tool) => (tool.id === id ? { ...tool, ...patch } : tool))
  return [...tools, { id, name: raw.tool_name ?? 'tool', args: raw.tool_args, status: 'running', ...patch }]
}

/**
 * Fold one AgentOS event into the assistant message it belongs to.
 *
 * @param message - The assistant message being streamed.
 * @param event - The next event from `/agents/{id}/runs` or `/continue`.
 * @returns A new message; the input is never mutated.
 */
export function applyEvent(message: ChatMessage, event: AgentEvent): ChatMessage {
  switch (event.event) {
    case 'RunContent': {
      const delta = typeof event.content === 'string' ? event.content : ''
      return delta ? { ...message, content: message.content + delta } : message
    }
    case 'ToolCallStarted':
      return { ...message, tools: upsertTool(message.tools, event.tool as EventTool, { status: 'running' }) }
    case 'ToolCallCompleted':
    case 'ToolCallError': {
      const raw = event.tool as EventTool
      const failed = event.event === 'ToolCallError' || Boolean(raw?.tool_call_error)
      const patch: Partial<ToolCall> = { status: failed ? 'error' : 'done', result: toText(raw?.result) }
      return { ...message, tools: upsertTool(message.tools, raw, patch) }
    }
    case 'RunPaused': {
      const tools = (event.tools as Record<string, unknown>[] | undefined) ?? []
      let next = message.tools
      for (const raw of tools) next = upsertTool(next, raw as EventTool, { status: 'awaiting-approval' })
      return { ...message, tools: next, paused: { runId: String(event.run_id), tools } }
    }
    case 'RunCompleted': {
      const final = typeof event.content === 'string' ? event.content : ''
      return { ...message, content: message.content || final, done: true }
    }
    case 'RunError':
    case 'RunCancelled':
      return { ...message, error: toText(event.content ?? event.error) || event.event, done: true }
    default:
      return message
  }
}

/** Fold a batch of events, in order, into `message`. */
export function applyEvents(message: ChatMessage, events: AgentEvent[]): ChatMessage {
  return events.reduce(applyEvent, message)
}

/** The user's answer to a paused run: every gated tool confirmed or rejected together. */
export function resolvePaused(paused: PausedRun, approve: boolean): Record<string, unknown>[] {
  return paused.tools.map((tool) => ({ ...tool, confirmed: approve }))
}

/** Input of the "Create agent" form. */
export interface AgentSpec {
  name: string
  purpose: string
  tools: string[]
  style?: string
}

/**
 * Turn the "Create agent" form into a request for Platform Builder.
 *
 * The Builder still discovers exact registry names and publishes the result; the
 * prompt only states intent so it can build without a follow-up interview.
 */
export function buildCreatePrompt(spec: AgentSpec): string {
  const lines = [
    `Build and publish a new agent named "${spec.name.trim()}".`,
    `Purpose: ${spec.purpose.trim()}`,
    spec.tools.length
      ? `Give it these registry tools: ${spec.tools.join(', ')}.`
      : 'It needs no tools beyond the model itself.',
  ]
  if (spec.style?.trim()) lines.push(`Tone and output style: ${spec.style.trim()}`)
  lines.push('Requirements are complete: do not ask follow-up questions; publish version 1 now.')
  return lines.join('\n')
}
