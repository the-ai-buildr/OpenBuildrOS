import { describe, expect, it } from 'vitest'

import { applyEvents, newMessage, runsToMessages } from '../lib/chat'
import { toolView } from '../lib/toolview'

const REFUSAL =
  'Refused by policy (deny {"pattern": "rm", "tool": "run_shell"}). Do not retry this action; tell the user it is not permitted.'

describe('toolView', () => {
  it('shows policy refusals with the rule that refused', () => {
    expect(toolView('run_shell', { command: 'rm -rf /' }, REFUSAL)).toEqual({
      type: 'refused',
      reason: 'deny {"pattern": "rm", "tool": "run_shell"}',
    })
  })

  it('shows computer errors as failures', () => {
    expect(toolView('browse', {}, 'Error: Computer unreachable')).toEqual({ type: 'failed', message: 'Computer unreachable' })
  })

  it('parses page summaries', () => {
    const result = 'URL: https://example.com/\nTitle: Example\n\nHello world\n\nLinks:\n- More: https://iana.org'
    expect(toolView('browse', { url: 'https://example.com' }, result)).toEqual({
      type: 'page',
      url: 'https://example.com/',
      title: 'Example',
      text: 'Hello world',
    })
  })

  it('parses shell runs, including timeouts', () => {
    const ran = JSON.stringify({ exit_code: 0, stdout: 'hi\n', stderr: '', timed_out: false })
    expect(toolView('run_shell', { command: 'echo hi' }, ran)).toMatchObject({ type: 'shell', command: 'echo hi', exitCode: 0, stdout: 'hi\n' })
    const slow = JSON.stringify({ exit_code: null, stdout: '', stderr: 'Timed out after 1s', timed_out: true })
    expect(toolView('run_shell', { command: 'sleep 9' }, slow)).toMatchObject({ exitCode: null, timedOut: true })
  })

  it('parses files and listings', () => {
    expect(toolView('write_file', { path: 'a.txt' }, '{"path": "a.txt", "size": 3}')).toEqual({ type: 'file', path: 'a.txt', size: 3 })
    expect(toolView('read_file', { path: 'a.txt' }, 'abc')).toEqual({ type: 'file', path: 'a.txt', content: 'abc' })
    const listing = JSON.stringify({ path: '/', entries: [{ name: 'a.txt', type: 'file', size: 3 }] })
    expect(toolView('list_files', {}, listing)).toEqual({ type: 'files', path: '/', entries: [{ name: 'a.txt', type: 'file', size: 3 }] })
  })

  it('summarises Studio results', () => {
    const ok = JSON.stringify({ ok: true, status: 'published', data: { id: 'writer-1', version: 1 } })
    expect(toolView('create_agent', {}, ok)).toEqual({ type: 'studio', ok: true, status: 'published', id: 'writer-1', message: undefined })
    const bad = JSON.stringify({ ok: false, status: 'error', error: { code: 'tool_not_allowed', message: 'No.' } })
    expect(toolView('create_team', {}, bad)).toMatchObject({ ok: false, message: 'No.' })
  })

  it('falls back to text', () => {
    expect(toolView('calculator', {}, '42')).toEqual({ type: 'text', text: '42' })
    expect(toolView('browse', {}, 'odd output')).toEqual({ type: 'text', text: 'odd output' })
  })
})

describe('tool status', () => {
  it('marks refused and failed computer actions, live and from history', () => {
    const call = (id: string, name: string, result: string) => [
      { event: 'ToolCallStarted', run_id: 'r', tool: { tool_call_id: id, tool_name: name } },
      { event: 'ToolCallCompleted', run_id: 'r', tool: { tool_call_id: id, tool_name: name, result } },
    ]
    const live = applyEvents(newMessage('assistant'), [
      ...call('1', 'run_shell', REFUSAL),
      ...call('2', 'browse', 'Error: down'),
      ...call('3', 'calculator', 'Error: not a computer tool'),
    ])
    expect(live.tools.map((tool) => tool.status)).toEqual(['refused', 'error', 'done'])

    const [, reply] = runsToMessages([
      { run_id: 'r', run_input: 'x', content: 'y', status: 'COMPLETED', tools: [{ tool_call_id: '1', tool_name: 'run_shell', result: REFUSAL }] },
    ])
    expect(reply.tools[0].status).toBe('refused')
  })
})
