import { describe, expect, it } from 'vitest'

import { applyEvent, applyEvents, buildCreatePrompt, newMessage, resolvePaused } from '../lib/chat'
import { isAllowed, isAuthorizedBasic, safeEqual } from '../lib/proxy-rules'
import { SSEParser, parseFrame, readEventStream, type AgentEvent } from '../lib/sse'

describe('SSEParser', () => {
  it('reassembles frames split across chunks', () => {
    const parser = new SSEParser()
    expect(parser.push('event: RunContent\ndata: {"event":"RunCon')).toEqual([])
    expect(parser.push('tent","content":"Hi"}\n\nevent: RunCompleted\ndata: {"event":"RunCompleted"}\n\n')).toEqual([
      { event: 'RunContent', content: 'Hi' },
      { event: 'RunCompleted' },
    ])
  })

  it('handles CRLF and flushes a trailing frame', () => {
    const parser = new SSEParser()
    expect(parser.push('data: {"event":"A"}\r\n\r\ndata: {"event":"B"}')).toEqual([{ event: 'A' }])
    expect(parser.flush()).toEqual([{ event: 'B' }])
  })

  it('reads a response body in per-chunk batches', async () => {
    const chunks = ['data: {"event":"A"}\n\ndata: {"event":"B"}\n\nda', 'ta: {"event":"C"}']
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
    const batches: AgentEvent[][] = []
    await readEventStream(new Response(body), (events) => batches.push(events))
    expect(batches).toEqual([[{ event: 'A' }, { event: 'B' }], [{ event: 'C' }]])
  })

  it('skips malformed, eventless and [DONE] frames', () => {
    expect(parseFrame('data: not json')).toEqual([])
    expect(parseFrame('data: {"type":"x"}')).toEqual([])
    expect(parseFrame('data: [DONE]')).toEqual([])
  })
})

describe('applyEvent', () => {
  it('streams content, tool calls, and completion', () => {
    let message = newMessage('assistant')
    message = applyEvent(message, { event: 'RunContent', content: 'Hel' })
    message = applyEvent(message, { event: 'RunContent', content: 'lo' })
    message = applyEvent(message, { event: 'ToolCallStarted', tool: { tool_call_id: 't1', tool_name: 'create_agent' } })
    message = applyEvent(message, {
      event: 'ToolCallCompleted',
      tool: { tool_call_id: 't1', tool_name: 'create_agent', result: '{"ok":true}' },
    })
    message = applyEvent(message, { event: 'RunCompleted', content: 'ignored, content already streamed' })
    expect(message.content).toBe('Hello')
    expect(message.tools).toEqual([{ id: 't1', name: 'create_agent', status: 'done', result: '{"ok":true}' }])
    expect(message.done).toBe(true)
  })

  it('folds a batch in order', () => {
    const batch = [
      { event: 'RunContent', content: 'a' },
      { event: 'RunContent', content: 'b' },
    ]
    expect(applyEvents(newMessage('assistant'), batch).content).toBe('ab')
  })

  it('uses RunCompleted content when nothing streamed', () => {
    expect(applyEvent(newMessage('assistant'), { event: 'RunCompleted', content: 'final' }).content).toBe('final')
  })

  it('marks paused tools and records the run for approval', () => {
    const tool = { tool_call_id: 'a', tool_name: 'archive_component', requires_confirmation: true }
    const message = applyEvent(newMessage('assistant'), { event: 'RunPaused', run_id: 'r1', tools: [tool] })
    expect(message.paused).toEqual({ runId: 'r1', tools: [tool] })
    expect(message.tools[0].status).toBe('awaiting-approval')
    expect(resolvePaused(message.paused!, false)).toEqual([{ ...tool, confirmed: false }])
  })

  it('surfaces run errors and failed tools', () => {
    const errored = applyEvent(newMessage('assistant'), { event: 'RunError', content: 'boom' })
    expect(errored.error).toBe('boom')
    const failed = applyEvent(newMessage('assistant'), {
      event: 'ToolCallCompleted',
      tool: { tool_call_id: 'x', tool_name: 'calc', tool_call_error: true, result: 'bad' },
    })
    expect(failed.tools[0].status).toBe('error')
  })
})

describe('buildCreatePrompt', () => {
  it('states name, purpose, tools, and style', () => {
    const prompt = buildCreatePrompt({ name: ' Scout ', purpose: 'Find news', tools: ['websearch'], style: 'terse' })
    expect(prompt).toContain('named "Scout"')
    expect(prompt).toContain('Purpose: Find news')
    expect(prompt).toContain('registry tools: websearch.')
    expect(prompt).toContain('Tone and output style: terse')
    expect(prompt).toContain('publish version 1 now')
  })

  it('says when no tools are needed', () => {
    expect(buildCreatePrompt({ name: 'A', purpose: 'B', tools: [] })).toContain('needs no tools')
  })
})

describe('proxy rules', () => {
  it('allows only the UI endpoints', () => {
    expect(isAllowed('GET', 'agents')).toBe(true)
    expect(isAllowed('GET', 'palette')).toBe(true)
    expect(isAllowed('GET', 'registry')).toBe(false)
    expect(isAllowed('POST', 'agents/platform-builder/runs')).toBe(true)
    expect(isAllowed('POST', 'agents/x/runs/abc-123/continue')).toBe(true)
    expect(isAllowed('DELETE', 'agents')).toBe(false)
    expect(isAllowed('GET', 'sessions')).toBe(false)
    expect(isAllowed('POST', 'agents/../config/runs')).toBe(false)
    expect(isAllowed('GET', 'components')).toBe(false)
  })

  it('compares secrets exactly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })

  it('checks basic auth', () => {
    const header = `Basic ${btoa('admin:pw:with:colons')}`
    expect(isAuthorizedBasic(header, 'admin', 'pw:with:colons')).toBe(true)
    expect(isAuthorizedBasic(header, 'admin', 'nope')).toBe(false)
    expect(isAuthorizedBasic('Basic !!!', 'admin', 'pw')).toBe(false)
    expect(isAuthorizedBasic(null, 'admin', 'pw')).toBe(false)
  })
})
