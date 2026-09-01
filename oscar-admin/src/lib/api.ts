/**
 * Backend client. Every call carries X-Admin-Secret.
 *
 * Reads use api(); the few writes use send(). ONLY endpoints that exist on the
 * deployed backend are used here — nothing in this panel assumes unreleased code.
 */

const LS_URL = 'oscar.admin.baseUrl'
const LS_SECRET = 'oscar.admin.secret'

// Running on localhost means a developer is working against their own backend, so
// that is what the panel points at by default. It used to default to the deployed
// service in every case, which had two bad consequences: the panel showed REAL
// users' phone numbers and chat transcripts while someone was only trying to test
// the UI, and a sleeping free-tier service answered the first request with an HTML
// 502 page that surfaced as "SyntaxError: Unexpected token '<'" — an error that
// says nothing about the actual cause.
//
// VITE_ADMIN_BASE overrides both, and the base URL typed on the login screen
// (localStorage) still wins over everything — so pointing a local panel at the
// deployed backend is one field, not a rebuild.
const LOCAL_BASE = 'http://localhost:8000'
const DEPLOYED_BASE = 'https://developement-branch.onrender.com'

const _isLocalhost = typeof location !== 'undefined' &&
  /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)

export const DEFAULT_BASE =
  (import.meta.env.VITE_ADMIN_BASE as string | undefined)?.replace(/\/+$/, '') ||
  (_isLocalhost ? LOCAL_BASE : DEPLOYED_BASE)

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
 * res.json() with a diagnosis instead of a parse error.
 *
 * A sleeping Render service, a proxy, or a tunnel can answer 200 with an HTML
 * page. res.ok is true, so the old code went straight to res.json() and the user
 * saw "SyntaxError: Unexpected token '<', \"<!doctype \"... is not valid JSON" —
 * which names the symptom and hides the cause.
 */
async function parseJson<T>(res: Response, base: string): Promise<T> {
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    const looksHtml = /^\s*<(!doctype|html)/i.test(text)
    throw new ApiError(
      res.status,
      looksHtml
        ? `${base} returned an HTML page instead of JSON. The backend is ` +
          `probably asleep or restarting (a free-tier service takes ~50s to ` +
          `wake) \u2014 retry, or point the base URL at a backend that is up.`
        : `${base} returned a response that is not JSON: ` +
          `${text.slice(0, 120)}${text.length > 120 ? '\u2026' : ''}`,
    )
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
  return parseJson<T>(res, base)
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
  return parseJson<T>(res, base)
}

/** Attachment URLs come back RELATIVE, so they need the base prefixed to render. */
export const imgUrl = (path: string) => getBase() + path

/**
 * Multipart upload. Deliberately NOT send(): that sets Content-Type: application/json,
 * and setting Content-Type by hand on a FormData body strips the multipart boundary the
 * browser generates, so the server sees a malformed body. Let fetch set the header.
 */
export async function upload<T>(path: string, file: File): Promise<T> {
  const base = getBase()
  const form = new FormData()
  form.append('file', file)
  let res: Response
  try {
    res = await fetch(base + path, {
      method: 'POST',
      headers: { 'X-Admin-Secret': getSecret() },
      body: form,
    })
  } catch {
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
 * One comment attachment. `url`/`thumbnail_url` are RELATIVE access-checked routes
 * (302 → S3); `direct_url`/`thumbnail_direct_url` are permanent public S3 links, and
 * are null whenever the bucket is flipped back to private. `thumbnail_*` is a ≈256px
 * preview for an image OR a PDF's rendered first page, and null for every other
 * document. `page_count` is PDFs only.
 */
export type TaskAttachment = {
  id: number; comment_id: number | null
  file_name: string | null; mime_type: string; kind: string; is_image: boolean
  byte_size: number; page_count: number | null
  url: string; direct_url: string | null
  thumbnail_url: string | null; thumbnail_direct_url: string | null
}

/**
 * Resolve an attachment to something an <img> or <a> can use.
 *
 * The direct link is preferred when present — it skips our 302 and is cacheable
 * forever (uuid key, immutable object). When it is null the bucket is private, so we
 * fall back to the relative route, which re-mints a signed URL per request and needs
 * `user_id` because that route re-checks task access. The thumbnail route already
 * carries `?thumb=1`, hence the separator has to be computed, not hardcoded.
 */
export function attUrl(a: TaskAttachment, userId: number, thumb = false): string | null {
  if (thumb) {
    if (a.thumbnail_direct_url) return a.thumbnail_direct_url
    if (!a.thumbnail_url) return null
    return `${getBase()}${a.thumbnail_url}&user_id=${userId}`
  }
  if (a.direct_url) return a.direct_url
  return `${getBase()}${a.url}${a.url.includes('?') ? '&' : '?'}user_id=${userId}`
}

/** Mirrors the backend whitelist in task_attachment_service._TYPES, so a file the
 *  server will certainly reject never costs an upload round trip. */
export const ATTACH_EXTS = [
  'pdf', 'xlsx', 'xls', 'csv', 'docx', 'doc', 'pptx', 'ppt', 'txt',
  'png', 'jpg', 'jpeg', 'webp', 'heic',
] as const

/** Server default (MAX_TASK_ATTACHMENT_BYTES). Overriding it there without changing
 *  this only makes the client stricter, never wrong. */
export const ATTACH_MAX_BYTES = 25 * 1024 * 1024

export const prettyBytes = (n: number) =>
  n < 1024 ? `${n} B`
  : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB`
  : `${(n / (1024 * 1024)).toFixed(1)} MB`

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

// ── Task tracking ───────────────────────────────────────────────────────────

export type AdminTaskRow = {
  id: number; title: string; status: string; priority: string | null
  is_all_day: boolean; is_project: boolean
  due_at: string | null; created_at: string | null; updated_at: string | null
  completed_at: string | null; spilled_over_at: string | null
  parent_task_id: number | null
  owner_id: number; owner_name: string | null
  assignee_id: number | null; assignee_name: string | null
}

export type AdminTeamRow = {
  id: number; name: string; invite_code: string | null
  owner_id: number | null; owner_name: string | null
  members: number; tasks: number; project_tasks: number; meetings: number
}

export type AdminTaskDetail = {
  task: Record<string, unknown>
  assignees: { user_id: number; name: string | null; status: string; completed_at: string | null }[]
  comments: { id: number; user_id: number; user_name: string | null; role: string; body: string; created_at: string | null }[]
  timeline: { id: number; user_id: number | null; user_name: string | null; event_type: string; details: string | null; created_at: string | null }[]
  attachments: { id: number; comment_id: number | null; file_name: string; mime_type: string; byte_size: number; created_at: string | null }[]
  notifications: { id: number; user_id: number; type: string; message: string; is_read: number; created_at: string | null }[]
}

export type PresenceRow = {
  id: number; name: string | null; email: string | null
  account_type: string | null; last_seen: string | null
  team_id: number | null; team_name: string | null; role: string | null
  online: boolean
}
