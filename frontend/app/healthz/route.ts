/** Liveness probe for the container: answers without touching the backend. */
export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json({ status: 'ok' })
}
