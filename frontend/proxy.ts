/**
 * Optional HTTP Basic auth in front of the whole UI (pages and `/api/os`).
 *
 * Enabled when `UI_PASSWORD` is set; the user name is `UI_USERNAME` (default `admin`).
 * `/healthz` stays open for container health checks.
 */

import { NextResponse, type NextRequest } from 'next/server'

import { isAuthorizedBasic, uiUserId } from '@/lib/proxy-rules'

export function proxy(request: NextRequest) {
  const password = process.env.UI_PASSWORD
  if (!password) return NextResponse.next()
  if (isAuthorizedBasic(request.headers.get('authorization'), uiUserId(), password)) return NextResponse.next()
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="OpenBuildrOS", charset="UTF-8"' },
  })
}

export const config = {
  matcher: ['/((?!healthz|_next/static|_next/image|favicon.ico|icon.svg).*)'],
}
