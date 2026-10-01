/**
 * Chat state for one conversation with an agent, team, or workflow, driven by AgentOS
 * stream events.
 *
 * Everything here is pure so it can be unit-tested without a browser.
 */

import { normalizeEvent } from './events'
import type { AgentEvent } from './sse'

/**
 * One line of activity in a reply: a tool call, a team member working on a delegated
 * task, or a workflow step.
 */
export interface ToolCall {
  id: string
  name: string
  kind?: 'tool' | 'member' | 'step'
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
  /** Transient status, e.g. while reconnecting a dropped stream. */
  notice?: string
  paused?: PausedRun
  /** AgentOS run id, known once the run starts; used to cancel it. */
  runId?: string
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

function upsertActivity(tools: ToolCall[], id: string, patch: Partial<ToolCall> & Pick<ToolCall, 'kind'>): ToolCall[] {
  const existing = tools.find((tool) => tool.id === id)
  if (existing) return tools.map((tool) => (tool.id === id ? { ...tool, ...patch } : tool))
  return [...tools, { id, name: patch.name ?? id, status: 'running', ...patch }]
}

/**
 * A member's own run inside a team or workflow stream: shown as one activity line
 * (who is working, then their answer), never mixed into the reply text.
 */
function applyMemberEvent(message: ChatMessage, name: string, event: AgentEvent): ChatMessage {
  const id = String(event.run_id)
  const who = String(event.agent_name ?? event.agent_id ?? event.team_name ?? event.team_id ?? 'member')
  switch (name) {
    case 'RunStarted':
      return { ...message, tools: upsertActivity(message.tools, id, { kind: 'member', name: who, status: 'running' }) }
    case 'RunCompleted':
      return { ...message, tools: upsertActivity(message.tools, id, { kind: 'member', status: 'done', result: toText(event.content) }) }
    case 'RunError':
      return { ...message, tools: upsertActivity(message.tools, id, { kind: 'member', status: 'error', result: toText(event.content) }) }
    default:
      return message
  }
}

/**
 * Fold one AgentOS event into the assistant message it belongs to.
 *
 * Works for agent, team, and workflow streams (see `normalizeEvent`). Events from a
 * different run than the message's own are a team member or workflow step at work.
 *
 * @param message - The assistant message being streamed.
 * @param event - The next event from a run, `/continue`, or `/resume` stream.
 * @returns A new message; the input is never mutated.
 */
export function applyEvent(message: ChatMessage, event: AgentEvent): ChatMessage {
  const name = normalizeEvent(event.event)
  const runId = typeof event.run_id === 'string' ? event.run_id : undefined
  if (!message.runId && runId) message = { ...message, runId }
  if (runId && runId !== message.runId) return applyMemberEvent(message, name, event)
  switch (name) {
    case 'RunContent': {
      const delta = typeof event.content === 'string' ? event.content : ''
      return delta ? { ...message, content: message.content + delta } : message
    }
    case 'ToolCallStarted':
      return { ...message, tools: upsertTool(message.tools, event.tool as EventTool, { status: 'running' }) }
    case 'ToolCallCompleted':
    case 'ToolCallError': {
      const raw = event.tool as EventTool
      const failed = name === 'ToolCallError' || Boolean(raw?.tool_call_error)
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
      return { ...message, error: toText(event.content ?? event.error) || 'The run failed.', done: true }
    case 'RunCancelled':
      return { ...message, notice: 'Stopped.', done: true }
    case 'StepStarted':
    case 'StepCompleted':
    case 'StepError': {
      const step = String(event.step_name ?? event.step_id ?? 'step')
      const status = name === 'StepStarted' ? 'running' : name === 'StepError' ? 'error' : 'done'
      const result = name === 'StepStarted' ? undefined : toText(event.content ?? event.error)
      return { ...message, tools: upsertActivity(message.tools, `step:${step}`, { kind: 'step', name: step, status, result }) }
    }
    default:
      return message
  }
}

/** Fold a batch of events, in order, into `message`. */
export function applyEvents(message: ChatMessage, events: AgentEvent[]): ChatMessage {
  // Fresh events mean the stream is live again: clear any reconnecting notice.
  const live = message.notice && !message.done ? { ...message, notice: undefined } : message
  return events.reduce(applyEvent, live)
}

/** The user's answer to a paused run: every gated tool confirmed or rejected together. */
export function resolvePaused(paused: PausedRun, approve: boolean): Record<string, unknown>[] {
  return paused.tools.map((tool) => ({ ...tool, confirmed: approve }))
}

/** A stored run as returned by `GET /sessions/{id}/runs`. */
export interface StoredRun {
  run_id: string
  parent_run_id?: string
  run_input?: unknown
  content?: unknown
  status?: string
  tools?: EventTool[] | null
}

/**
 * Rebuild a channel's transcript from its stored runs.
 *
 * Member runs inside a team (those with a parent) are folded away; each top-level run
 * becomes the user's message and the reply, with its tool calls.
 */
export function runsToMessages(runs: StoredRun[]): ChatMessage[] {
  return runs
    .filter((run) => !run.parent_run_id)
    .flatMap((run) => {
      const tools = (run.tools ?? []).map<ToolCall>((tool) => ({
        id: tool.tool_call_id ?? tool.tool_name ?? 'tool',
        name: tool.tool_name ?? 'tool',
        args: tool.tool_args,
        result: toText(tool.result),
        status: tool.tool_call_error ? 'error' : 'done',
      }))
      const live = run.status === 'RUNNING' || run.status === 'PENDING'
      const reply: ChatMessage = {
        // A live run is replayed from its first event when reattached, so start it empty.
        ...newMessage('assistant', live ? '' : toText(run.content)),
        tools: live ? [] : tools,
        runId: run.run_id,
        done: !live,
        error: run.status === 'ERROR' ? 'The run failed.' : undefined,
      }
      return [newMessage('user', toText(run.run_input)), reply]
    })
}

/** Input of the "Create" form: one agent, a team of existing agents, or a workflow of them. */
export interface BuildSpec {
  kind: 'agent' | 'team' | 'workflow'
  name: string
  purpose: string
  /** Agent: registry tools to give it. */
  tools?: string[]
  /** Team: member agent ids. Workflow: step agent ids, in order. */
  members?: string[]
  style?: string
}

/**
 * Turn the "Create" form into a request for Platform Builder.
 *
 * The Builder still discovers exact registry names and publishes the result; the
 * prompt only states intent so it can build without a follow-up interview.
 */
export function buildCreatePrompt(spec: BuildSpec): string {
  const members = spec.members ?? []
  const tools = spec.tools ?? []
  const lines = [`Build and publish a new ${spec.kind} named "${spec.name.trim()}".`, `Purpose: ${spec.purpose.trim()}`]
  if (spec.kind === 'agent') {
    lines.push(tools.length ? `Give it these registry tools: ${tools.join(', ')}.` : 'It needs no tools beyond the model itself.')
  } else if (spec.kind === 'team') {
    lines.push(`Members (exact agent ids): ${members.join(', ')}. The team leader delegates to them and combines the results.`)
  } else {
    lines.push(`Steps in order (exact agent ids, one step each): ${members.join(', ')}.`)
  }
  if (spec.style?.trim()) lines.push(`Tone and output style: ${spec.style.trim()}`)
  lines.push('Requirements are complete: do not ask follow-up questions; publish version 1 now.')
  return lines.join('\n')
}
