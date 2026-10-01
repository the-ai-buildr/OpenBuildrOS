'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { listRoutines, routineAction, type Routine } from '@/lib/api'

/** The schedules ("routines") Platform Builder has set up: when they run next, and on/off/run-now controls. */
export function RoutinesDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [routines, setRoutines] = useState<Routine[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setRoutines(await listRoutines())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    dialogRef.current?.showModal()
    listRoutines()
      .then(setRoutines)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const act = async (id: string, action: 'enable' | 'disable' | 'trigger') => {
    try {
      await routineAction(id, action)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog wide"
      aria-labelledby="routines-title"
      onClose={onClose}
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="dialog-body">
        <h2 id="routines-title">Routines</h2>
        <p className="muted small">Scheduled runs. Ask Platform Builder to create, change, or delete one.</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {routines === null ? (
          <p className="muted">Loading…</p>
        ) : routines.length === 0 ? (
          <p className="muted">No routines yet. Try: “Run my research agent every weekday at 9am.”</p>
        ) : (
          <table className="routines">
            <thead>
              <tr>
                <th>Name</th>
                <th>Runs</th>
                <th>Schedule</th>
                <th>Next run</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {routines.map((routine) => (
                <tr key={routine.id}>
                  <td>{routine.name}</td>
                  <td>
                    {routine.target_type} <code>{routine.target_id}</code>
                  </td>
                  <td>
                    <code>{routine.cron_expr}</code> {routine.timezone}
                  </td>
                  <td>
                    {routine.enabled
                      ? routine.next_run_at
                        ? new Date(routine.next_run_at * 1000).toLocaleString()
                        : '—'
                      : routine.disabled_reason || 'off'}
                  </td>
                  <td className="row-actions">
                    <button className="ghost small" onClick={() => void act(routine.id, 'trigger')}>
                      Run now
                    </button>
                    <button
                      className="ghost small"
                      onClick={() => void act(routine.id, routine.enabled ? 'disable' : 'enable')}
                    >
                      {routine.enabled ? 'Turn off' : 'Turn on'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="actions">
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  )
}
