'use client'

import { entityKey, type Entity } from '@/lib/api'

interface SidebarProps {
  entities: Entity[]
  selectedKey: string
  /** null while the first health check is in flight. */
  healthy: boolean | null
  loadError: string | null
  onSelect: (key: string) => void
  onCreate: () => void
  onRoutines: () => void
}

/** Navigation: the admin agents, then everything built with Platform Builder, grouped by kind. */
export function Sidebar({ entities, selectedKey, healthy, loadError, onSelect, onCreate, onRoutines }: SidebarProps) {
  const status = healthy === null ? 'checking' : healthy ? 'online' : 'offline'
  const built = (kind: Entity['kind']) => entities.filter((entity) => entity.kind === kind && entity.is_component)
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
        + Create
      </button>

      <Group
        title="Admin agents"
        entities={entities.filter((entity) => entity.kind === 'agents' && !entity.is_component)}
        selectedKey={selectedKey}
        onSelect={onSelect}
      />
      <Group
        title="Agents"
        entities={built('agents')}
        selectedKey={selectedKey}
        onSelect={onSelect}
        empty="Nothing built yet. Use Create or ask Platform Builder."
      />
      <Group title="Teams" entities={built('teams')} selectedKey={selectedKey} onSelect={onSelect} />
      <Group title="Workflows" entities={built('workflows')} selectedKey={selectedKey} onSelect={onSelect} />

      {loadError && (
        <p className="sidebar-error" role="alert">
          {loadError}
        </p>
      )}
      <div className="sidebar-footer">
        <button className="ghost small" onClick={onRoutines}>
          Routines
        </button>
        <div className={`status status-${status}`} data-testid="backend-status">
          <span className="dot" aria-hidden /> AgentOS {status}
        </div>
      </div>
    </aside>
  )
}

interface GroupProps {
  title: string
  entities: Entity[]
  selectedKey: string
  onSelect: (key: string) => void
  empty?: string
}

function Group({ title, entities, selectedKey, onSelect, empty }: GroupProps) {
  if (!entities.length && !empty) return null
  return (
    <nav className="agent-group" aria-label={title}>
      <h2>{title}</h2>
      {entities.length === 0 && <p className="muted small">{empty}</p>}
      <ul>
        {entities.map((entity) => (
          <li key={entityKey(entity)}>
            <button
              className={`agent-item ${entityKey(entity) === selectedKey ? 'active' : ''}`}
              onClick={() => onSelect(entityKey(entity))}
              title={entity.description}
              data-entity={entityKey(entity)}
            >
              <span className="agent-name">{entity.name}</span>
              {entity.description && <span className="agent-desc">{entity.description}</span>}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
