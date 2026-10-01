/**
 * Browser-side client for the AgentOS API.
 *
 * Every call goes through the same-origin `/api/os/*` proxy route, which adds the
 * server-held `OS_SECURITY_KEY` and the signed-in user's id; neither is decided
 * in the browser.
 */

import { runsToMessages, type ChatMessage, type StoredRun } from './chat'
import { HttpError, streamWithResume, type EventsHandler } from './resilient'
import { readEventStream } from './sse'

export type { EventsHandler } from './resilient'

const BASE = '/api/os'

export const BUILDER_ID = 'platform-builder'
export const MANAGER_ID = 'platform-manager'
export const ENGINEER_ID = 'platform-engineer'

/** The three kinds of runnable component, named as their AgentOS route prefix. */
export type Kind = 'agents' | 'teams' | 'workflows'
export const KINDS: Kind[] = ['agents', 'teams', 'workflows']

/** The session type AgentOS files each kind's conversations under. */
const SESSION_TYPE: Record<Kind, string> = { agents: 'agent', teams: 'team', workflows: 'workflow' }

/** An agent, team, or workflow as listed by AgentOS. */
export interface Entity {
  kind: Kind
  id: string
  name: string
  description?: string
  /** True for components built at runtime with Studio; false for the code-defined admin agents. */
  is_component?: boolean
  model?: { model?: string; provider?: string }
}

/** Stable key for an entity across kinds, e.g. `teams:research-desk`. */
export const entityKey = (entity: Pick<Entity, 'kind' | 'id'>) => `${entity.kind}:${entity.id}`

/** A tool the Builder can wire into new agents. */
export interface PaletteTool {
  name: string
  description?: string
}

/** One conversation ("channel") with an entity: an AgentOS session. */
export interface Channel {
  session_id: string
  session_name?: string
  updated_at?: string
}

/** A Studio schedule ("routine") as listed by AgentOS. */
export interface Routine {
  id: string
  name: string
  cron_expr: string
  timezone: string
  enabled: boolean
  next_run_at?: number | null
  target_type?: string | null
  target_id?: string | null
  disabled_reason?: string | null
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { cache: 'no-store', ...init })
  if (!response.ok) throw new HttpError(response.status, `${path} failed: ${response.status} ${await response.text()}`)
  return (await response.json()) as T
}

/** List every agent, team, and workflow: the admin agents plus everything built with Studio. */
export async function listEntities(): Promise<Entity[]> {
  const lists = await Promise.all(
    KINDS.map(async (kind) => (await json<Omit<Entity, 'kind'>[]>(`/${kind}`)).map((item) => ({ ...item, kind }))),
  )
  return lists.flat()
}

/** List the tools the Builder may give a new agent (declared in the backend registry). */
export function listPalette(): Promise<PaletteTool[]> {
  return json<PaletteTool[]>('/palette')
}

/** The signed-in user's conversations with an entity, most recently active first. */
export async function listChannels(entity: Pick<Entity, 'kind' | 'id'>): Promise<Channel[]> {
  const query = new URLSearchParams({
    type: SESSION_TYPE[entity.kind],
    component_id: entity.id,
    limit: '50',
    sort_by: 'updated_at',
    sort_order: 'desc',
  })
  const page = await json<{ data: Channel[] }>(`/sessions?${query}`)
  return page.data
}

/** A channel's transcript, rebuilt from its stored runs. */
export async function loadChannel(kind: Kind, sessionId: string): Promise<ChatMessage[]> {
  const query = new URLSearchParams({ type: SESSION_TYPE[kind] })
  return runsToMessages(await json<StoredRun[]>(`/sessions/${encodeURIComponent(sessionId)}/runs?${query}`))
}

/** All schedules. */
export async function listRoutines(): Promise<Routine[]> {
  return (await json<{ data: Routine[] }>('/schedules?limit=100')).data
}

/** Enable, disable, or fire a schedule now. */
export async function routineAction(id: string, action: 'enable' | 'disable' | 'trigger'): Promise<void> {
  await json(`/schedules/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: new FormData() })
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

const runsPath = (entity: Pick<Entity, 'kind' | 'id'>) =>
  `/${entity.kind}/${encodeURIComponent(entity.id)}/runs`

/** POST a form and feed the SSE response to `onEvents`. */
async function postStream(
  path: string,
  fields: Record<string, string>,
  onEvents: EventsHandler,
  signal: AbortSignal,
): Promise<void> {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  const response = await fetch(`${BASE}${path}`, { method: 'POST', body: form, signal })
  if (!response.ok) throw new HttpError(response.status, `Run failed: ${response.status} ${await response.text()}`)
  await readEventStream(response, onEvents)
}

/**
 * Stream a run whose first request is `first`, reconnecting through `/resume` on drops.
 *
 * `background=true` keeps the run going on the server while the browser is disconnected.
 */
function resilientRun(
  entity: Pick<Entity, 'kind' | 'id'>,
  sessionId: string,
  first: { suffix: string; fields: Record<string, string> },
  { onEvents, onReconnect, signal }: RunHandlers,
): Promise<void> {
  const base = runsPath(entity)
  const common = { session_id: sessionId, stream: 'true' }
  return streamWithResume({
    start: (handler, s) =>
      postStream(`${base}${first.suffix}`, { ...first.fields, ...common, background: 'true' }, handler, s),
    resume: (runId, lastIndex, handler, s) =>
      postStream(
        `${base}/${encodeURIComponent(runId)}/resume`,
        { session_id: sessionId, last_event_index: String(lastIndex) },
        handler,
        s,
      ),
    onEvents,
    onReconnect,
    signal,
  })
}

/** Start a run of `entity` with the user's `message` in channel `sessionId`. */
export function runEntity(
  entity: Pick<Entity, 'kind' | 'id'>,
  message: string,
  sessionId: string,
  handlers: RunHandlers,
): Promise<void> {
  return resilientRun(entity, sessionId, { suffix: '', fields: { message } }, handlers)
}

/**
 * Resume a paused run after the user approved or rejected its gated tools.
 *
 * @param tools - The paused tool executions with `confirmed` set (see `resolvePaused`).
 */
export function continueRun(
  entity: Pick<Entity, 'kind' | 'id'>,
  runId: string,
  sessionId: string,
  tools: Record<string, unknown>[],
  handlers: RunHandlers,
): Promise<void> {
  const first = { suffix: `/${encodeURIComponent(runId)}/continue`, fields: { tools: JSON.stringify(tools) } }
  return resilientRun(entity, sessionId, first, handlers)
}

/** Reattach to a run that is still going (after a reload), replaying it from the start. */
export function attachRun(
  entity: Pick<Entity, 'kind' | 'id'>,
  runId: string,
  sessionId: string,
  { onEvents, onReconnect, signal }: RunHandlers,
): Promise<void> {
  const path = `${runsPath(entity)}/${encodeURIComponent(runId)}/resume`
  return streamWithResume({
    // No last_event_index: replay every buffered (or stored) event.
    start: (handler, s) => postStream(path, { session_id: sessionId }, handler, s),
    resume: (_runId, lastIndex, handler, s) =>
      postStream(path, { session_id: sessionId, last_event_index: String(lastIndex) }, handler, s),
    onEvents,
    onReconnect,
    signal,
  })
}

/** Stop a run on the server. Aborting the request alone would leave a background run going. */
export async function cancelRun(entity: Pick<Entity, 'kind' | 'id'>, runId: string): Promise<void> {
  await json(`${runsPath(entity)}/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: new FormData() })
}
