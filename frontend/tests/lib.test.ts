import { describe, expect, it } from 'vitest'

import { applyEvent, applyEvents, buildCreatePrompt, newMessage, resolvePaused, runsToMessages } from '../lib/chat'
import { normalizeEvent } from '../lib/events'
import { isAllowed, isAuthorizedBasic, isUserScoped, safeEqual } from '../lib/proxy-rules'
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

  it('records the run id and marks a cancelled run as stopped', () => {
    let message = applyEvent(newMessage('assistant'), { event: 'RunStarted', run_id: 'r9' })
    expect(message.runId).toBe('r9')
    message = applyEvent(message, { event: 'RunCancelled', run_id: 'r9' })
    expect(message.notice).toBe('Stopped.')
    expect(message.error).toBeUndefined()
  })

  it('clears a reconnecting notice when events flow again', () => {
    const reconnecting = { ...newMessage('assistant'), notice: 'Reconnecting (1/5)…' }
    expect(applyEvents(reconnecting, [{ event: 'RunContent', content: 'x' }]).notice).toBeUndefined()
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

describe('team and workflow streams', () => {
  it('normalizes team and workflow event names', () => {
    expect(normalizeEvent('TeamRunContent')).toBe('RunContent')
    expect(normalizeEvent('TeamToolCallStarted')).toBe('ToolCallStarted')
    expect(normalizeEvent('WorkflowCompleted')).toBe('RunCompleted')
    expect(normalizeEvent('StepStarted')).toBe('StepStarted')
  })

  it('shows a delegated member as activity, not as reply text', () => {
    let message = applyEvent(newMessage('assistant'), { event: 'TeamRunStarted', run_id: 'team-run' })
    message = applyEvent(message, { event: 'RunStarted', run_id: 'm1', agent_name: 'Writer' })
    message = applyEvent(message, { event: 'RunContent', run_id: 'm1', content: 'member text' })
    message = applyEvent(message, { event: 'RunCompleted', run_id: 'm1', content: 'draft' })
    message = applyEvent(message, { event: 'TeamRunContent', run_id: 'team-run', content: 'final' })
    message = applyEvent(message, { event: 'TeamRunCompleted', run_id: 'team-run' })
    expect(message.content).toBe('final')
    expect(message.tools).toEqual([{ id: 'm1', kind: 'member', name: 'Writer', status: 'done', result: 'draft' }])
    expect(message.done).toBe(true)
  })

  it('tracks workflow steps and takes the final content from WorkflowCompleted', () => {
    let message = applyEvent(newMessage('assistant'), { event: 'WorkflowStarted', run_id: 'wf' })
    message = applyEvent(message, { event: 'StepStarted', run_id: 'wf', step_name: 'research' })
    message = applyEvent(message, { event: 'StepCompleted', run_id: 'wf', step_name: 'research', content: 'notes' })
    message = applyEvent(message, { event: 'WorkflowCompleted', run_id: 'wf', content: 'brief' })
    expect(message.tools[0]).toMatchObject({ kind: 'step', name: 'research', status: 'done', result: 'notes' })
    expect(message.content).toBe('brief')
  })
})

describe('runsToMessages', () => {
  it('rebuilds a transcript from stored runs, folding member runs away', () => {
    const messages = runsToMessages([
      { run_id: 'r1', run_input: 'hi', content: 'hello', status: 'COMPLETED', tools: [{ tool_name: 'calc', result: 2 }] },
      { run_id: 'm1', parent_run_id: 'r1', run_input: 'sub', content: 'member', status: 'COMPLETED' },
      { run_id: 'r2', run_input: 'again', content: 'partial', status: 'RUNNING' },
    ])
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'hello'],
      ['user', 'again'],
      ['assistant', ''],
    ])
    expect(messages[1].tools[0]).toMatchObject({ name: 'calc', result: '2', status: 'done' })
    expect(messages[3]).toMatchObject({ runId: 'r2', done: false })
  })
})

describe('buildCreatePrompt', () => {
  it('states name, purpose, tools, and style', () => {
    const spec = { kind: 'agent' as const, name: ' Scout ', purpose: 'Find news', tools: ['websearch'], style: 'terse' }
    const prompt = buildCreatePrompt(spec)
    expect(prompt).toContain('new agent named "Scout"')
    expect(prompt).toContain('Purpose: Find news')
    expect(prompt).toContain('registry tools: websearch.')
    expect(prompt).toContain('Tone and output style: terse')
    expect(prompt).toContain('publish version 1 now')
  })

  it('says when no tools are needed', () => {
    expect(buildCreatePrompt({ kind: 'agent', name: 'A', purpose: 'B', tools: [] })).toContain('needs no tools')
  })

  it('names team members and workflow steps by id, in order', () => {
    const team = buildCreatePrompt({ kind: 'team', name: 'Desk', purpose: 'p', members: ['writer', 'critic'] })
    expect(team).toContain('new team named "Desk"')
    expect(team).toContain('Members (exact agent ids): writer, critic.')
    const flow = buildCreatePrompt({ kind: 'workflow', name: 'Pipe', purpose: 'p', members: ['a', 'b'] })
    expect(flow).toContain('Steps in order (exact agent ids, one step each): a, b.')
  })
})

describe('proxy rules', () => {
  it('allows only the UI endpoints', () => {
    expect(isAllowed('GET', 'agents')).toBe(true)
    expect(isAllowed('GET', 'palette')).toBe(true)
    expect(isAllowed('GET', 'registry')).toBe(false)
    expect(isAllowed('POST', 'agents/platform-builder/runs')).toBe(true)
    expect(isAllowed('POST', 'agents/x/runs/abc-123/continue')).toBe(true)
    expect(isAllowed('POST', 'agents/x/runs/abc-123/resume')).toBe(true)
    expect(isAllowed('POST', 'agents/x/runs/abc-123/cancel')).toBe(true)
    expect(isAllowed('POST', 'agents/x/runs/abc-123/fork')).toBe(false)
    expect(isAllowed('DELETE', 'agents')).toBe(false)
    expect(isAllowed('GET', 'teams')).toBe(true)
    expect(isAllowed('POST', 'workflows/w/runs')).toBe(true)
    expect(isAllowed('POST', 'teams/t/runs/r/cancel')).toBe(true)
    expect(isAllowed('GET', 'sessions')).toBe(true)
    expect(isAllowed('GET', 'sessions/s1/runs')).toBe(true)
    expect(isAllowed('DELETE', 'sessions/s1')).toBe(false)
    expect(isAllowed('POST', 'schedules/x/trigger')).toBe(true)
    expect(isAllowed('POST', 'schedules')).toBe(false)
    expect(isUserScoped('sessions/s1/runs')).toBe(true)
    expect(isUserScoped('agents')).toBe(false)
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
