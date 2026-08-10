/**
 * Backend client. Every call carries X-Admin-Secret.
 *
 * Reads use api(); the few writes use send(). ONLY endpoints that exist on the
 * deployed backend are used here — nothing in this panel assumes unreleased code.
 */

const LS_URL = 'oscar.admin.baseUrl'
const LS_SECRET = 'oscar.admin.secret'

export const DEFAULT_BASE = 'https://developement-branch.onrender.com'

export const getBase = () => localStorage.getItem(LS_URL) || DEFAULT_BASE
export const getSecret = () => localStorage.getItem(LS_SECRET) || ''
export const setCreds = (base: string, secret: string) => {
  localStorage.setItem(LS_URL, base.replace(/\/+$/, ''))
  localStorage.setItem(LS_SECRET, secret)
}
export const clearCreds = () => {
  localStorage.removeItem(LS_SECRET)
}

export class ApiError extends Error {
  // Written out rather than a parameter property: tsconfig has erasableSyntaxOnly,
  // which rejects the shorthand.
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * The 401 vs 0 distinction matters more than it looks. A wrong secret is a real 401
 * from the server; a CORS rejection or an unreachable host surfaces as a thrown
 * TypeError with no status at all. Collapsing them into "failed" would send someone
 * hunting for a bad password when the actual cause is that the origin isn't in
 * CORS_ORIGINS, which is a completely different fix.
 */
export async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const base = getBase()
  let res: Response
  try {
    res = await fetch(base + path, {
      headers: { 'X-Admin-Secret': getSecret() },
      signal,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError(
      0,
      `Cannot reach ${base}. Either the host is down, or this page's origin ` +
        `(${location.origin}) is not in the backend's CORS_ORIGINS.`,
    )
  }
  if (res.status === 401) throw new ApiError(401, 'Admin secret rejected.')
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const j = await res.json()
      if (j?.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
    } catch { /* non-JSON error body — keep the status line */ }
    throw new ApiError(res.status, detail)
  }
  return res.json() as Promise<T>
}

/**
 * Writes. Same error contract as api(), plus the body.
 *
 * `notFoundAsNull` exists for ONE caller: POST /notifications/test answers 404
 * "No active device tokens for this user", which is not a failure — it is the
 * answer. It is the only way this backend will tell us a user is unreachable,
 * since no deployed endpoint exposes device tokens.
 */
export async function send<T>(
  path: string,
  // DELETE added for /admin/users/{id}. A DELETE with a body is legal but widely
  // mishandled by proxies, so the body is omitted entirely when there isn't one.
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
  opts: { notFoundAsNull?: boolean } = {},
): Promise<T | null> {
  const base = getBase()
  let res: Response
  try {
    res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': getSecret() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    throw new ApiError(
      0,
      `Cannot reach ${base}. Either the host is down, or this page's origin ` +
        `(${location.origin}) is not in the backend's CORS_ORIGINS.`,
    )
  }
  if (res.status === 404 && opts.notFoundAsNull) return null
  if (res.status === 401) throw new ApiError(401, 'Admin secret rejected.')
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const j = await res.json()
      if (j?.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
    } catch { /* non-JSON error body — keep the status line */ }
    throw new ApiError(res.status, detail)
  }
  return res.json() as Promise<T>
}

/** Attachment URLs come back RELATIVE, so they need the base prefixed to render. */
export const imgUrl = (path: string) => getBase() + path

// ── Shapes, matching the backend exactly ────────────────────────────────────

export type Overview = {
  users: number; active_users: number; teams: number
  sessions: number; active_sessions: number; messages: number
  photos: number; photos_with_details: number; photos_with_contact: number
  awaiting_details: number; awaiting_contact: number
  contacts_by_source: Record<string, number>
  whatsapp_contacts: number; org_mcps: number
  tasks: number; meetings: number
}

export type PhotoRow = {
  photo_id: number; thumbnail_url: string
  user_id: number; user_name: string | null
  session_id: number | null; session_title: string | null
  business_name: string | null; context: string | null
  contact_name: string | null; contact_phone: string | null
  contact_source: string | null
  state: 'awaiting_details' | 'awaiting_contact' | 'complete'
}

export type SessionRow = {
  id: number; user_id: number; user_name: string | null
  title: string | null; is_active: number
  last_message_at: string | null; msgs: number; photos: number
}

export type TranscriptMsg = {
  id: number; role: string; content: string
  reply_to_ref: string | null; created_at: string | null
}

export type TranscriptAtt = {
  id: number; message_id: number | null; user_id: number
  business_name: string | null; user_context: string | null
  contact_data: string | null
  thumbnail_url: string; image_url: string
  mime_type: string; byte_size: number
  width: number | null; height: number | null
}

export type WaRow = {
  id: number; owner_user_id: number; owner_name: string | null
  team_id: number | null; team_name: string | null
  display_name: string; phone_number: string; label: string | null
}

export type McpRow = {
  id: number; name: string; members: number
  source: 'db' | 'env' | 'none'
  db_rows: { name: string; url: string; is_active: boolean }[]
  env_value: string | null
  resolved: string[]
  tool_mode: boolean
}

export type TeamRow = { id: number; name: string }

/**
 * GET /teams/{id}/members. Note what is NOT here: no username, no email, no device
 * tokens. This is everything the deployed API will tell us about a person, which is
 * why People search matches on `name` only.
 *
 * `last_seen` is stamped when their last WebSocket DISCONNECTS — it is not a login
 * time (nothing records logins) and it is null while they are online.
 */
export type MemberRow = {
  user_id: number; name: string; role: string; is_active: number
  joined_at: string | null; online: boolean; last_seen: string | null
}

export type NotificationRow = {
  id: number; user_id: number; type: string; message: string
  is_read: number; item_id: number | null
  created_at: string | null; read_at: string | null
}

/** POST /notifications/test. A 404 instead of this shape means no active tokens. */
export type PushResult = {
  success: boolean; success_count: number; failure_count: number
  invalid_tokens: string[]
}

/** GET /assistant/business — the only deployed way to READ an org profile back. */
export type BusinessProfile = {
  business: string | null; note: string | null; details: string | null
  capabilities: string[]; getting_started: string[]
}
