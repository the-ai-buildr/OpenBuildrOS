'use client'

import { useEffect, useRef, useState } from 'react'

import { listPalette, type PaletteTool } from '@/lib/api'
import { buildCreatePrompt } from '@/lib/chat'

interface CreateAgentDialogProps {
  onClose: () => void
  /** Receives the request to send to Platform Builder. */
  onSubmit: (prompt: string) => void
}

/**
 * Form-driven agent creation: collects a spec and hands it to Platform Builder.
 *
 * A native modal `<dialog>` provides Escape-to-close, focus trapping, and an inert background.
 */
export function CreateAgentDialog({ onClose, onSubmit }: CreateAgentDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
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

  const toggle = (tool: string) =>
    setPicked((current) => (current.includes(tool) ? current.filter((t) => t !== tool) : [...current, tool]))

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
          onSubmit(buildCreatePrompt({ name, purpose, tools: picked, style }))
        }}
      >
        <h2 id="create-title">Create an agent</h2>
        <p className="muted small">Platform Builder composes it from the registry and publishes it.</p>

        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Research Assistant" required />
        </label>
        <label>
          What should it do?
          <textarea
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            rows={3}
            placeholder="Finds recent sources on a topic and writes a cited summary."
            required
          />
        </label>
        {palette.length > 0 && (
          <fieldset>
            <legend>Tools</legend>
            {palette.map((tool) => (
              <label key={tool.name} className="check" title={tool.description}>
                <input type="checkbox" checked={picked.includes(tool.name)} onChange={() => toggle(tool.name)} />
                {tool.name}
              </label>
            ))}
          </fieldset>
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
          <button type="submit" className="primary" disabled={!name.trim() || !purpose.trim()}>
            Build agent
          </button>
        </div>
      </form>
    </dialog>
  )
}
