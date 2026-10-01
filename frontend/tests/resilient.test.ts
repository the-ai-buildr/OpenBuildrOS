import { describe, expect, it, vi } from 'vitest'

import {
  HttpError,
  StreamLostError,
  backoffDelay,
  isRetryable,
  streamWithResume,
  type EventsHandler,
} from '../lib/resilient'
import type { AgentEvent } from '../lib/sse'

const ev = (event: string, event_index: number, extra: Record<string, unknown> = {}): AgentEvent => ({
  event,
  event_index,
  run_id: 'run-1',
  ...extra,
})

const noSleep = () => Promise.resolve()

function collect() {
  const seen: AgentEvent[] = []
  return { seen, onEvents: (events: AgentEvent[]) => seen.push(...events) }
}

describe('streamWithResume', () => {
  it('resumes after a dropped stream from the last index, without duplicates', async () => {
    const { seen, onEvents } = collect()
    const resume = vi.fn(async (_runId: string, _last: number, handler: EventsHandler) => {
      // The server replays from last_event_index; an overlapping event must be dropped.
      handler([ev('RunContent', 1, { content: 'b' }), ev('RunContent', 2, { content: 'c' }), ev('RunCompleted', 3)])
    })
    const onReconnect = vi.fn()
    await streamWithResume({
      start: async (handler) => {
        handler([ev('RunStarted', 0), ev('RunContent', 1, { content: 'a' })])
        throw new TypeError('network error')
      },
      resume,
      onEvents,
      onReconnect,
      signal: new AbortController().signal,
      sleep: noSleep,
    })
    expect(resume).toHaveBeenCalledWith('run-1', 1, expect.any(Function), expect.any(AbortSignal))
    expect(seen.map((e) => e.event_index)).toEqual([0, 1, 2, 3])
    expect(onReconnect).toHaveBeenCalledWith(1, 5)
  })

  it('treats a stream that ends without a terminal event as a drop', async () => {
    const { seen, onEvents } = collect()
    await streamWithResume({
      start: async (handler) => handler([ev('RunStarted', 0)]),
      resume: async (_id, _last, handler) => handler([ev('RunCompleted', 1)]),
      onEvents,
      signal: new AbortController().signal,
      sleep: noSleep,
    })
    expect(seen.at(-1)?.event).toBe('RunCompleted')
  })

  it('does not reconnect after a terminal event or a pause', async () => {
    const resume = vi.fn()
    await streamWithResume({
      start: async (handler) => handler([ev('RunStarted', 0), ev('RunPaused', 1)]),
      resume,
      onEvents: () => undefined,
      signal: new AbortController().signal,
    })
    expect(resume).not.toHaveBeenCalled()
  })

  it('gives up after maxAttempts reconnects without progress', async () => {
    const resume = vi.fn(async () => {
      throw new TypeError('still down')
    })
    const run = streamWithResume({
      start: async (handler) => {
        handler([ev('RunStarted', 0)])
        throw new TypeError('down')
      },
      resume,
      onEvents: () => undefined,
      signal: new AbortController().signal,
      maxAttempts: 3,
      sleep: noSleep,
    })
    await expect(run).rejects.toBeInstanceOf(StreamLostError)
    expect(resume).toHaveBeenCalledTimes(3)
  })

  it('fails fast on 4xx and on failures before the run id is known', async () => {
    const base = { resume: vi.fn(), onEvents: () => undefined, signal: new AbortController().signal, sleep: noSleep }
    await expect(
      streamWithResume({ ...base, start: async () => Promise.reject(new HttpError(401, 'unauthorized')) }),
    ).rejects.toThrow('unauthorized')
    await expect(
      streamWithResume({ ...base, start: async () => Promise.reject(new TypeError('offline')) }),
    ).rejects.toThrow('offline')
    expect(base.resume).not.toHaveBeenCalled()
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    const resume = vi.fn()
    const run = streamWithResume({
      start: async (handler) => {
        handler([ev('RunStarted', 0)])
        controller.abort()
        throw new DOMException('Aborted', 'AbortError')
      },
      resume,
      onEvents: () => undefined,
      signal: controller.signal,
      sleep: noSleep,
    })
    await expect(run).rejects.toThrow('Aborted')
    expect(resume).not.toHaveBeenCalled()
  })
})

describe('backoff and retry classification', () => {
  it('doubles, caps, and jitters the delay', () => {
    expect(backoffDelay(0, 500, 8000, () => 1)).toBe(500)
    expect(backoffDelay(3, 500, 8000, () => 1)).toBe(4000)
    expect(backoffDelay(10, 500, 8000, () => 1)).toBe(8000)
    expect(backoffDelay(3, 500, 8000, () => 0)).toBe(2000)
  })

  it('retries network errors and 5xx only', () => {
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true)
    expect(isRetryable(new HttpError(502, 'bad gateway'))).toBe(true)
    expect(isRetryable(new HttpError(404, 'gone'))).toBe(false)
    expect(isRetryable(new DOMException('Aborted', 'AbortError'))).toBe(false)
  })
})
