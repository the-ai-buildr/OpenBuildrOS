/**
 * Generative UI for tool results: turns the text a tool returned into a typed card the
 * chat can render (a web page, a shell run, a file, a Studio change, a refusal),
 * falling back to raw text for anything it does not recognise.
 *
 * Pure, so it is unit-tested without a browser.
 */

/** Prefix the computer gateway puts on actions the policy refused (`backend/app/computer.py`). */
const REFUSED_PREFIX = 'Refused by policy'

/** Tools from the bot's computer toolkit; their failures come back as `Error: ...` text. */
const COMPUTER_TOOLS = new Set([
  'browse', 'read_page', 'click', 'type_text', 'run_shell', 'list_files', 'read_file', 'write_file',
])

export interface FileEntry {
  name: string
  type: string
  size?: number
}

/** What a tool result renders as. */
export type ToolView =
  | { type: 'refused'; reason: string }
  | { type: 'failed'; message: string }
  | { type: 'page'; url: string; title: string; text: string }
  | { type: 'shell'; command: string; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }
  | { type: 'file'; path: string; size?: number; content?: string }
  | { type: 'files'; path: string; entries: FileEntry[] }
  | { type: 'studio'; ok: boolean; status: string; id?: string; message?: string }
  | { type: 'text'; text: string }

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `URL: ...\nTitle: ...\n\n<text>\n\nLinks:...` from the computer's page summary. */
function pageView(result: string): ToolView | undefined {
  const match = /^URL: (.*)\nTitle: (.*)\n\n([\s\S]*?)(?:\n\nLinks:[\s\S]*)?$/.exec(result)
  return match ? { type: 'page', url: match[1], title: match[2], text: match[3] } : undefined
}

/**
 * Decide how to show one tool call's result.
 *
 * @param name - The tool's name.
 * @param args - The arguments the model called it with.
 * @param result - The text the tool returned (empty while it runs).
 */
export function toolView(name: string, args: Record<string, unknown> | undefined, result: string): ToolView {
  if (result.startsWith(REFUSED_PREFIX)) {
    const reason = /^Refused by policy \((.*)\)\./.exec(result)?.[1] ?? result
    return { type: 'refused', reason }
  }
  if (COMPUTER_TOOLS.has(name) && result.startsWith('Error: ')) {
    return { type: 'failed', message: result.slice('Error: '.length) }
  }
  const json = parseJson(result)
  const path = typeof args?.path === 'string' ? args.path : ''
  switch (name) {
    case 'browse':
    case 'read_page':
    case 'click':
    case 'type_text':
      return pageView(result) ?? { type: 'text', text: result }
    case 'run_shell':
      if (isObject(json) && 'exit_code' in json) {
        return {
          type: 'shell',
          command: String(args?.command ?? ''),
          exitCode: typeof json.exit_code === 'number' ? json.exit_code : null,
          stdout: String(json.stdout ?? ''),
          stderr: String(json.stderr ?? ''),
          timedOut: Boolean(json.timed_out),
        }
      }
      break
    case 'write_file':
      if (isObject(json)) return { type: 'file', path: String(json.path ?? path), size: Number(json.size) }
      break
    case 'read_file':
      return { type: 'file', path, content: result }
    case 'list_files':
      if (isObject(json) && Array.isArray(json.entries)) {
        return { type: 'files', path: String(json.path ?? path), entries: json.entries as FileEntry[] }
      }
      break
  }
  // Studio (Platform Builder) tools answer with {ok, status, data, error}.
  if (isObject(json) && typeof json.ok === 'boolean' && typeof json.status === 'string') {
    const data = isObject(json.data) ? json.data : {}
    const error = isObject(json.error) ? json.error : {}
    return {
      type: 'studio',
      ok: json.ok,
      status: json.status,
      id: typeof data.id === 'string' ? data.id : undefined,
      message: typeof error.message === 'string' ? error.message : undefined,
    }
  }
  return { type: 'text', text: result }
}
