'use client'

import type { AgentSummary } from '@/lib/api'

interface SidebarProps {
  adminAgents: AgentSummary[]
  userAgents: AgentSummary[]
  selectedId: string
  /** null while the first health check is in flight. */
  healthy: boolean | null
  loadError: string | null
  onSelect: (agentId: string) => void
  onCreate: () => void
}

/** Agent navigation: admin agents first, then everything built with Platform Builder. */
export function Sidebar({ adminAgents, userAgents, selectedId, healthy, loadError, onSelect, onCreate }: SidebarProps) {
  const status = healthy === null ? 'checking' : healthy ? 'online' : 'offline'
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          ◆
        </span>
        <span>
          open<strong>Buildr</strong>OS
        </span>
      </div>

      <button className="primary create" onClick={onCreate}>
        + Create agent
      </button>

      <AgentGroup title="Admin agents" agents={adminAgents} selectedId={selectedId} onSelect={onSelect} />
      <AgentGroup
        title="Your agents"
        agents={userAgents}
        selectedId={selectedId}
        onSelect={onSelect}
        empty="Nothing built yet. Use Create agent or ask Platform Builder."
      />

      {loadError && (
        <p className="sidebar-error" role="alert">
          Could not load agents: {loadError}
        </p>
      )}
      <div className={`status status-${status}`} data-testid="backend-status">
        <span className="dot" aria-hidden /> AgentOS {status}
      </div>
    </aside>
  )
}

interface AgentGroupProps {
  title: string
  agents: AgentSummary[]
  selectedId: string
  onSelect: (agentId: string) => void
  empty?: string
}

function AgentGroup({ title, agents, selectedId, onSelect, empty }: AgentGroupProps) {
  return (
    <nav className="agent-group" aria-label={title}>
      <h2>{title}</h2>
      {agents.length === 0 && empty && <p className="muted small">{empty}</p>}
      <ul>
        {agents.map((agent) => (
          <li key={agent.id}>
            <button
              className={`agent-item ${agent.id === selectedId ? 'active' : ''}`}
              onClick={() => onSelect(agent.id)}
              title={agent.description}
              data-agent-id={agent.id}
            >
              <span className="agent-name">{agent.name}</span>
              {agent.description && <span className="agent-desc">{agent.description}</span>}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
