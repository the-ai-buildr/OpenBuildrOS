/**
 * Minimal Server-Sent Events reader for AgentOS run streams.
 *
 * AgentOS emits frames of the form `event: RunContent\ndata: {...}\n\n`. Only the
 * `data:` JSON matters to the UI (it repeats the event name in its `event` field).
 */

/** One decoded AgentOS stream event. `event` is the AgentOS event name, e.g. `RunContent`. */
export interface AgentEvent {
  event: string
  [key: string]: unknown
}

/**
 * Incrementally split an SSE byte stream into complete frames.
 *
 * Network chunks can end mid-frame, so the parser buffers the trailing partial
 * frame until the next chunk completes it.
 */
export class SSEParser {
  private buffer = ''

  /**
   * Feed a decoded text chunk and get back every event completed by it.
   *
   * @param chunk - Text from the response body (may contain zero or many frames).
   * @returns Parsed events in arrival order; malformed frames are skipped.
   */
  push(chunk: string): AgentEvent[] {
    this.buffer += chunk.replace(/\r\n/g, '\n')
    const frames = this.buffer.split('\n\n')
    this.buffer = frames.pop() ?? ''
    return frames.flatMap(parseFrame)
  }

  /** Parse whatever is left once the stream has ended. */
  flush(): AgentEvent[] {
    const rest = this.buffer
    this.buffer = ''
    return parseFrame(rest)
  }
}

/**
 * Parse one SSE frame into zero or one event.
 *
 * @param frame - Lines of a single frame without the blank-line terminator.
 * @returns `[event]` when the frame carries JSON data with an `event` field, else `[]`.
 */
export function parseFrame(frame: string): AgentEvent[] {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data || data === '[DONE]') return []
  try {
    const parsed = JSON.parse(data) as Partial<AgentEvent>
    return typeof parsed.event === 'string' ? [parsed as AgentEvent] : []
  } catch {
    return []
  }
}

/**
 * Read a streaming fetch response to completion.
 *
 * Events are delivered in batches, one per network chunk, so a consumer can apply
 * a burst of tokens with a single state update instead of one per token.
 *
 * @param response - A `fetch` response whose body is an AgentOS SSE stream.
 * @param onEvents - Called with each non-empty batch, in order.
 */
export async function readEventStream(response: Response, onEvents: (events: AgentEvent[]) => void): Promise<void> {
  if (!response.body) throw new Error('The response has no body to stream.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parser = new SSEParser()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    const events = parser.push(decoder.decode(value, { stream: true }))
    if (events.length) onEvents(events)
  }
  const rest = [...parser.push(decoder.decode()), ...parser.flush()]
  if (rest.length) onEvents(rest)
}
