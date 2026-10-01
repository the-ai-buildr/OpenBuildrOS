/**
 * Same-origin proxy to AgentOS.
 *
 * Forwards allowlisted requests to `BACKEND_URL` with the server-only
 * `OS_SECURITY_KEY` as a bearer token, and streams responses (SSE included)
 * straight back to the browser. Run requests get their `user_id` set here from
 * the authenticated UI user, so the browser cannot claim another identity.
 */

import { isAllowed, uiUserId } from '@/lib/proxy-rules'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const BACKEND_URL = (process.env.BACKEND_URL ?? 'http://localhost:8000').replace(/\/$/, '')

type Context = { params: Promise<{ path: string[] }> }

async function forward(request: Request, context: Context): Promise<Response> {
  const path = (await context.params).path.map(encodeURIComponent).join('/')
  if (!isAllowed(request.method, path)) {
    return Response.json({ detail: 'Not available through the UI proxy.' }, { status: 404 })
  }

  const headers = new Headers()
  if (process.env.OS_SECURITY_KEY) headers.set('authorization', `Bearer ${process.env.OS_SECURITY_KEY}`)

  let body: FormData | undefined
  if (request.method === 'POST') {
    try {
      body = await request.formData()
    } catch {
      return Response.json({ detail: 'Expected a form body.' }, { status: 400 })
    }
    body.set('user_id', uiUserId())
  }

  const search = new URL(request.url).search
  let upstream: Response
  try {
    // fetch sets the multipart content-type (with its boundary) for FormData bodies.
    upstream = await fetch(`${BACKEND_URL}/${path}${search}`, {
      method: request.method,
      headers,
      body,
      signal: request.signal,
      cache: 'no-store',
    })
  } catch {
    return Response.json({ detail: 'AgentOS backend is unreachable.' }, { status: 502 })
  }

  const responseHeaders = new Headers({ 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' })
  const upstreamType = upstream.headers.get('content-type')
  if (upstreamType) responseHeaders.set('content-type', upstreamType)
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
}

export { forward as GET, forward as POST }
