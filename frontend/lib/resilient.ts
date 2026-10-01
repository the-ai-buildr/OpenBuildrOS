/**
 * Reconnecting run streams.
 *
 * Runs are started with `background=true`, so the agent keeps working on the server
 * when the browser's connection drops, and every event carries an `event_index`.
 * When a stream ends early or the network fails, `streamWithResume` reconnects to
 * `/agents/{id}/runs/{run_id}/resume` with the last index it saw, backing off
 * exponentially with jitter. Replayed events at or below that index are dropped, so
 * the transcript never repeats or skips output.
 */

import { normalizeEvent, TERMINAL_EVENTS } from './events'
import type { AgentEvent } from './sse'

/** A non-2xx HTTP answer. 4xx responses are final; 5xx and network failures are retried. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Receives each batch of events from a streaming run. */
export type EventsHandler = (events: AgentEvent[]) => void

/**
 * Delay before reconnect attempt `attempt` (0-based): exponential, capped, with jitter
 * in [50%, 100%] of the step so many clients do not retry in lockstep.
 */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 8_000, random = Math.random): number {
  const step = Math.min(maxMs, baseMs * 2 ** attempt)
  return Math.round(step * (0.5 + random() / 2))
}

/** True when a failure may be fixed by reconnecting: network errors, 5xx, or a stream cut short. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false
  if (error instanceof HttpError) return error.status >= 500
  return true
}

export interface StreamWithResumeOptions {
  /** Open the run's first stream. */
  start: (onEvents: EventsHandler, signal: AbortSignal) => Promise<void>
  /** Reopen the stream of `runId` after `lastIndex`. */
  resume: (runId: string, lastIndex: number, onEvents: EventsHandler, signal: AbortSignal) => Promise<void>
  /** Receives every event exactly once, in order. */
  onEvents: EventsHandler
  /** Called before each reconnect with the 1-based attempt number. */
  onReconnect?: (attempt: number, maxAttempts: number) => void
  signal: AbortSignal
  /** Consecutive failed reconnects allowed; progress resets the count. */
  maxAttempts?: number
  sleep?: (ms: number) => Promise<void>
  delay?: (attempt: number) => number
}

/** Error raised when a run's stream could not be recovered. */
export class StreamLostError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StreamLostError'
  }
}

/**
 * Stream a run to completion, reconnecting through drops.
 *
 * @throws The original error for aborts and non-retryable failures (4xx, or a failure
 *   before the run reported its id), or `StreamLostError` once reconnects are exhausted.
 */
export async function streamWithResume({
  start,
  resume,
  onEvents,
  onReconnect,
  signal,
  maxAttempts = 5,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delay = backoffDelay,
}: StreamWithResumeOptions): Promise<void> {
  let runId: string | undefined
  let lastIndex = -1
  let finished = false

  const accept: EventsHandler = (events) => {
    const fresh = events.filter((event) => {
      const index = typeof event.event_index === 'number' ? event.event_index : undefined
      if (index !== undefined && index <= lastIndex) return false
      if (index !== undefined) lastIndex = index
      if (typeof event.run_id === 'string') runId ??= event.run_id
      // Team and workflow streams carry their members' runs too: only the top-level run ends the stream.
      const ownRun = typeof event.run_id !== 'string' || event.run_id === runId
      if (ownRun && TERMINAL_EVENTS.has(normalizeEvent(event.event))) finished = true
      return true
    })
    if (fresh.length) onEvents(fresh)
  }

  let failures = 0
  let attempt: (s: AbortSignal) => Promise<void> = (s) => start(accept, s)
  for (;;) {
    const indexBefore = lastIndex
    let failure: unknown = new StreamLostError('The stream ended before the run finished.')
    try {
      await attempt(signal)
    } catch (error) {
      failure = error
    }
    if (finished) return
    if (signal.aborted || !isRetryable(failure) || runId === undefined) throw failure

    failures = lastIndex > indexBefore ? 1 : failures + 1
    if (failures > maxAttempts) {
      throw new StreamLostError(`Lost the connection to the run after ${maxAttempts} reconnect attempts.`, {
        cause: failure,
      })
    }
    onReconnect?.(failures, maxAttempts)
    await sleep(delay(failures - 1))
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const id = runId
    attempt = (s) => resume(id, lastIndex, accept, s)
  }
}
