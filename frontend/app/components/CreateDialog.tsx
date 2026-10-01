'use client'

import { useEffect, useRef, useState } from 'react'

import { listPalette, type Entity, type PaletteTool } from '@/lib/api'
import { buildCreatePrompt, type BuildSpec } from '@/lib/chat'

interface CreateDialogProps {
  /** User-built agents, the members a team or the steps a workflow can use. */
  agents: Entity[]
  onClose: () => void
  /** Receives the request to send to Platform Builder. */
  onSubmit: (prompt: string) => void
}

const KIND_COPY: Record<BuildSpec['kind'], { label: string; purpose: string; pick: string }> = {
  agent: { label: 'Agent', purpose: 'Finds recent sources on a topic and writes a cited summary.', pick: 'Tools' },
  team: { label: 'Team', purpose: 'Researches a topic, then edits the findings into a brief.', pick: 'Members' },
  workflow: { label: 'Workflow', purpose: 'Runs the same steps in order on every request.', pick: 'Steps, in order' },
}

/**
 * Form-driven creation of an agent, a team of agents, or a workflow of agents. It
 * collects a spec and hands it to Platform Builder, which composes and publishes it.
 *
 * A native modal `<dialog>` provides Escape-to-close, focus trapping, and an inert background.
 */
export function CreateDialog({ agents, onClose, onSubmit }: CreateDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [kind, setKind] = useState<BuildSpec['kind']>('agent')
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [style, setStyle] = useState('')
  const [palette, setPalette] = useState<PaletteTool[]>([])
  const [picked, setPicked] = useState<string[]>([])

  useEffect(() => {
    dialogRef.current?.showModal()
    listPalette()
      .then(setPalette)
      .catch(() => setPalette([]))
  }, [])

  // Tools and members are different lists: switching kind clears the selection.
  const switchKind = (next: BuildSpec['kind']) => {
    setKind(next)
    setPicked([])
  }
  const toggle = (value: string) =>
    setPicked((current) => (current.includes(value) ? current.filter((v) => v !== value) : [...current, value]))

  const options =
    kind === 'agent'
      ? palette.map((tool) => ({ value: tool.name, label: tool.name, title: tool.description }))
      : agents.map((agent) => ({ value: agent.id, label: agent.name, title: agent.description }))
  const needsMembers = kind !== 'agent'
  const ready = name.trim() && purpose.trim() && (!needsMembers || picked.length > 0)
  const copy = KIND_COPY[kind]

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby="create-title"
      onClose={onClose}
      // A click on the dialog element itself (not its form) is a click on the backdrop.
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const spec: BuildSpec = { kind, name, purpose, style }
          if (kind === 'agent') spec.tools = picked
          else spec.members = picked
          onSubmit(buildCreatePrompt(spec))
        }}
      >
        <h2 id="create-title">Create</h2>
        <div className="segmented" role="tablist" aria-label="What to create">
          {(Object.keys(KIND_COPY) as BuildSpec['kind'][]).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={kind === option}
              className={kind === option ? 'active' : ''}
              onClick={() => switchKind(option)}
            >
              {KIND_COPY[option].label}
            </button>
          ))}
        </div>
        <p className="muted small">Platform Builder composes it from the registry and publishes it.</p>

        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`My ${copy.label}`} required />
        </label>
        <label>
          What should it do?
          <textarea
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            rows={3}
            placeholder={copy.purpose}
            required
          />
        </label>
        {options.length > 0 ? (
          <fieldset>
            <legend>{copy.pick}</legend>
            {options.map((option) => (
              <label key={option.value} className="check" title={option.title}>
                <input
                  type="checkbox"
                  checked={picked.includes(option.value)}
                  onChange={() => toggle(option.value)}
                />
                {option.label}
                {kind === 'workflow' && picked.includes(option.value) && (
                  <span className="muted small">#{picked.indexOf(option.value) + 1}</span>
                )}
              </label>
            ))}
          </fieldset>
        ) : (
          needsMembers && <p className="muted small">Create some agents first; teams and workflows are made of them.</p>
        )}
        <label>
          <span>
            Tone or output style <span className="muted">(optional)</span>
          </span>
          <input value={style} onChange={(e) => setStyle(e.target.value)} placeholder="Concise bullet points" />
        </label>

        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!ready}>
            Build {copy.label.toLowerCase()}
          </button>
        </div>
      </form>
    </dialog>
  )
}
