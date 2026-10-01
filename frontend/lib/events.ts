/**
 * One vocabulary for agent, team, and workflow stream events.
 *
 * Agents emit `RunStarted` … `RunCompleted`, teams prefix the same names with
 * `Team`, and workflows use `WorkflowStarted` … `WorkflowCompleted`. Mapping all
 * three onto the agent names lets one reducer and one reconnect loop handle them.
 */

const WORKFLOW_NAMES: Record<string, string> = {
  WorkflowStarted: 'RunStarted',
  WorkflowCompleted: 'RunCompleted',
  WorkflowError: 'RunError',
  WorkflowCancelled: 'RunCancelled',
  WorkflowPaused: 'RunPaused',
}

/**
 * Map an AgentOS event name to its agent-run equivalent.
 *
 * @example normalizeEvent('TeamRunContent') === 'RunContent'
 * @example normalizeEvent('WorkflowCompleted') === 'RunCompleted'
 */
export function normalizeEvent(name: string): string {
  if (name.startsWith('Team')) return name.slice(4)
  return WORKFLOW_NAMES[name] ?? name
}

/** Normalized events after which a run's stream is complete and must not be resumed. */
export const TERMINAL_EVENTS = new Set(['RunCompleted', 'RunError', 'RunCancelled', 'RunPaused'])
