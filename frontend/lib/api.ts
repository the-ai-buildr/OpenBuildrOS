/**
 * Browser-side client for the AgentOS API.
 *
 * Every call goes through the same-origin `/api/os/*` proxy route, which adds the
 * server-held `OS_SECURITY_KEY` and the signed-in user's id; neither is decided
 * in the browser.
 */

import { readEventStream, type AgentEvent } from './sse'

const BASE = '/api/os'

export const BUILDER_ID = 'platform-builder'
export const MANAGER_ID = 'platform-manager'
export const ENGINEER_ID = 'platform-engineer'

/** The subset of AgentOS's agent listing the UI uses. */
export interface AgentSummary {
  id: string
  name: string
  description?: string
  /** True for agents built at runtime with Studio; false for the code-defined admin agents. */
  is_component?: boolean
  model?: { model?: string; provider?: string }
}

/** A tool the Builder can wire into new agents. */
export interface PaletteTool {
  name: string
  description?: string
}

/** Receives each batch of events from a streaming run. */
export type EventsHandler = (events: AgentEvent[]) => void

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`)
  return (await response.json()) as T
}

/** List every agent: the admin agents plus everything published through Studio. */
export function listAgents(): Promise<AgentSummary[]> {
  return json<AgentSummary[]>('/agents')
}

/** List the tools the Builder may give a new agent (declared in the backend registry). */
export function listPalette(): Promise<PaletteTool[]> {
  return json<PaletteTool[]>('/palette')
}

/** True when the backend answers its health probe. */
export async function checkHealth(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/health`, { cache: 'no-store' })).ok
  } catch {
    return false
  }
}

/**
 * POST a streaming form to `/agents/{agentId}/runs{suffix}` and feed its events to `onEvents`.
 *
 * @param fields - Endpoint-specific form fields; `session_id` and `stream` are added here.
 * @param signal - Aborts the request (and with it the run) when fired.
 */
async function streamRun(
  agentId: string,
  suffix: string,
  sessionId: string,
  fields: Record<string, string>,
  onEvents: EventsHandler,
  signal?: AbortSignal,
): Promise<void> {
  const form = new FormData()
  for (const [key, value] of Object.entries({ ...fields, session_id: sessionId, stream: 'true' })) form.set(key, value)
  const response = await fetch(`${BASE}/agents/${encodeURIComponent(agentId)}/runs${suffix}`, {
    method: 'POST',
    body: form,
    signal,
  })
  if (!response.ok) throw new Error(`Run failed: ${response.status} ${await response.text()}`)
  await readEventStream(response, onEvents)
}

/** Start a streaming run of `agentId` with the user's `message` in conversation `sessionId`. */
export function runAgent(
  agentId: string,
  message: string,
  sessionId: string,
  onEvents: EventsHandler,
  signal?: AbortSignal,
): Promise<void> {
  return streamRun(agentId, '', sessionId, { message }, onEvents, signal)
}

/**
 * Resume a paused run after the user approved or rejected its gated tools.
 *
 * @param tools - The paused tool executions with `confirmed` set (see `resolvePaused`).
 */
export function continueRun(
  agentId: string,
  runId: string,
  sessionId: string,
  tools: Record<string, unknown>[],
  onEvents: EventsHandler,
  signal?: AbortSignal,
): Promise<void> {
  const suffix = `/${encodeURIComponent(runId)}/continue`
  return streamRun(agentId, suffix, sessionId, { tools: JSON.stringify(tools) }, onEvents, signal)
}
