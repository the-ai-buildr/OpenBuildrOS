/**
 * Browser-side client for the AgentOS API.
 *
 * Every call goes through the same-origin `/api/os/*` proxy route, which adds the
 * server-held `OS_SECURITY_KEY` and the signed-in user's id; neither is decided
 * in the browser.
 */

import { HttpError, streamWithResume, type EventsHandler } from './resilient'
import { readEventStream } from './sse'

export type { EventsHandler } from './resilient'

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

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { cache: 'no-store' })
  if (!response.ok) throw new HttpError(response.status, `${path} failed: ${response.status} ${await response.text()}`)
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

/** Callbacks and cancellation for a streaming run. */
export interface RunHandlers {
  onEvents: EventsHandler
  /** A dropped connection is being retried (1-based attempt). */
  onReconnect?: (attempt: number, maxAttempts: number) => void
  signal: AbortSignal
}

/** POST a form under `/agents/{agentId}/runs` and feed the SSE response to `onEvents`. */
async function postStream(
  agentId: string,
  suffix: string,
  fields: Record<string, string>,
  onEvents: EventsHandler,
  signal: AbortSignal,
): Promise<void> {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  const response = await fetch(`${BASE}/agents/${encodeURIComponent(agentId)}/runs${suffix}`, {
    method: 'POST',
    body: form,
    signal,
  })
  if (!response.ok) throw new HttpError(response.status, `Run failed: ${response.status} ${await response.text()}`)
  await readEventStream(response, onEvents)
}

/**
 * Stream a run whose first request is `first`, reconnecting through `/resume` on drops.
 *
 * `background=true` keeps the run going on the server while the browser is disconnected.
 */
function resilientRun(
  agentId: string,
  sessionId: string,
  first: { suffix: string; fields: Record<string, string> },
  { onEvents, onReconnect, signal }: RunHandlers,
): Promise<void> {
  const common = { session_id: sessionId, stream: 'true' }
  return streamWithResume({
    start: (handler, s) =>
      postStream(agentId, first.suffix, { ...first.fields, ...common, background: 'true' }, handler, s),
    resume: (runId, lastIndex, handler, s) =>
      postStream(
        agentId,
        `/${encodeURIComponent(runId)}/resume`,
        { session_id: sessionId, last_event_index: String(lastIndex) },
        handler,
        s,
      ),
    onEvents,
    onReconnect,
    signal,
  })
}

/** Start a run of `agentId` with the user's `message` in conversation `sessionId`. */
export function runAgent(agentId: string, message: string, sessionId: string, handlers: RunHandlers): Promise<void> {
  return resilientRun(agentId, sessionId, { suffix: '', fields: { message } }, handlers)
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
  handlers: RunHandlers,
): Promise<void> {
  const first = { suffix: `/${encodeURIComponent(runId)}/continue`, fields: { tools: JSON.stringify(tools) } }
  return resilientRun(agentId, sessionId, first, handlers)
}

/** Stop a run on the server. Aborting the request alone would leave a background run going. */
export async function cancelRun(agentId: string, runId: string): Promise<void> {
  const path = `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`
  const response = await fetch(`${BASE}${path}`, { method: 'POST', body: new FormData() })
  if (!response.ok) throw new HttpError(response.status, `Cancel failed: ${response.status}`)
}
