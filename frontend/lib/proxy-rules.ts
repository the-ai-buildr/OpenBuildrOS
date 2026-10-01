/**
 * Request rules shared by the UI proxy route and the Basic-auth gate.
 *
 * The proxy attaches the admin `OS_SECURITY_KEY`, so it forwards only what the UI
 * needs instead of the whole AgentOS API.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

const SEGMENT = '[A-Za-z0-9._~-]+'

const ALLOWED: ReadonlyArray<readonly [method: string, pattern: RegExp]> = [
  ['GET', /^health$/],
  ['GET', /^agents$/],
  ['GET', /^palette$/],
  ['POST', new RegExp(`^agents/${SEGMENT}/runs$`)],
  ['POST', new RegExp(`^agents/${SEGMENT}/runs/${SEGMENT}/(continue|resume|cancel)$`)],
]

/**
 * Decide whether a proxied request may pass.
 *
 * @param method - HTTP method of the incoming request.
 * @param path - Path below `/api/os/`, without a leading slash or query string.
 * @returns True when the pair is on the allowlist.
 */
export function isAllowed(method: string, path: string): boolean {
  return ALLOWED.some(([allowedMethod, pattern]) => allowedMethod === method && pattern.test(path))
}

/** The user id runs are recorded under: the Basic-auth user, or `admin` when auth is off. */
export function uiUserId(): string {
  return process.env.UI_USERNAME || 'admin'
}

/** Compare two secrets in constant time (hashing first equalizes their lengths). */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(a), digest(b))
}

/**
 * Check an HTTP Basic `Authorization` header against the configured credentials.
 *
 * @param header - The raw header value, or null when absent.
 * @param username - Expected user name.
 * @param password - Expected password.
 */
export function isAuthorizedBasic(header: string | null, username: string, password: string): boolean {
  if (!header?.startsWith('Basic ')) return false
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  const split = decoded.indexOf(':')
  if (split < 0) return false
  // Evaluate both comparisons so timing does not reveal which one failed.
  const userOk = safeEqual(decoded.slice(0, split), username)
  const passOk = safeEqual(decoded.slice(split + 1), password)
  return userOk && passOk
}
