/**
 * People — search users, see who is reachable, verify push, edit an org profile.
 *
 * CONSTRAINT THAT SHAPED THIS WHOLE FILE: it uses ONLY endpoints that exist on the
 * deployed backend. That rules out several obvious things, and the workarounds are
 * not arbitrary:
 *
 *   · No user-search route exists → every team's members are fetched once and the
 *     search runs in the browser. `GET /teams/{id}/members` is the only route that
 *     enumerates people at all.
 *   · No username or email is exposed anywhere → search matches on NAME only.
 *   · No route returns device tokens → push health cannot be read passively. The
 *     ONLY probe is POST /notifications/test, which SENDS a real notification. So
 *     the bell is click-per-user and never fires on page load.
 *   · No route reactivates a token → there is deliberately no "revive" button. It
 *     would need the token string, which nothing hands out.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bell, Building2, Loader2, RotateCw, Search, ShieldCheck, Trash2, UserMinus, UserPlus } from 'lucide-react'
import { api, send } from './lib/api'
import type { BusinessProfile, McpRow, MemberRow, NotificationRow, PushResult, TeamRow } from './lib/api'
import { Badge, Card, Empty, ErrorBox, Field, Spinner, Table, Td, cx, inputCls } from './ui'

type Person = MemberRow & { team_id: number; team_name: string }

/** POST /auth/register's user object. `invite_code` is present ONLY on the team_lead
 *  branch — it is the single moment the backend ever discloses one. */
type RegisteredUser = {
  id: number; name: string; email: string; account_type: string
  team_id?: number | null; team_name?: string | null
  invite_code?: string | null; onboarding_state?: string
}

/**
 * The two gate codes POST /auth/register checks.
 *
 * Loaded from `.env.local`, which Vite reads at startup and `.gitignore` excludes via
 * `*.local`. So they are filled in automatically and never typed, while still staying
 * out of the repository — putting the credentials that let anyone create an account on
 * an unauthenticated backend into a git history is the thing worth avoiding, not the
 * typing.
 *
 * localStorage remains the fallback for a checkout with no .env.local, so the form
 * still works rather than silently failing with INVALID_*_CODE.
 */
const ENV_PLATFORM_CODE = import.meta.env.VITE_PLATFORM_INVITE_CODE as string | undefined
const ENV_SUPER_ADMIN = import.meta.env.VITE_SUPER_ADMIN_CODE as string | undefined

const LS_PLATFORM_CODE = 'oscar.admin.platformInviteCode'
const LS_SUPER_ADMIN = 'oscar.admin.superAdminCode'

/**
 * Bounded-concurrency map. There is no endpoint that lists users, so the only way to
 * enumerate people is one call per team — 59 of them.
 *
 * Measured against the live service: ~0.4s per call, so sequential is ~24s of staring
 * at a spinner, while 8 at a time finishes 8 calls in ~1.0s. An earlier version ran
 * these sequentially to be kind to "a free tier"; Developement_BRANCH is on the
 * STARTER plan, so that caution was unfounded and cost 20 seconds on every visit.
 *
 * Still bounded rather than all-59-at-once: 59 concurrent sockets against a
 * single-worker uvicorn is a good way to make the whole backend feel broken for
 * everyone actually using the app.
 */
async function pool<T, R>(
  items: T[], limit: number,
  fn: (item: T) => Promise<R>,
  onProgress?: (done: number) => void,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  let done = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
      onProgress?.(++done)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Module-level so switching tabs and coming back is instant instead of another full
 * sweep. Short TTL because membership changes are rare but not never, and the view's
 * own Reload button bypasses it entirely.
 */
let CACHE: { at: number; people: Person[]; teams: TeamRow[] } | null = null
const CACHE_TTL_MS = 120_000

/** "online" · "3h ago" · "—". last_seen is a disconnect time, so recency is what matters. */
function ago(iso: string | null): string {
  if (!iso) return ''
  const then = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z').getTime()
  const mins = Math.floor((Date.now() - then) / 60000)
  if (!Number.isFinite(mins) || mins < 0) return ''
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / 1440)}d ago`
}

/** What a bell click found out. `null` result = 404 = no active device tokens. */
type Probe =
  | { state: 'busy' }
  | { state: 'unreachable' }
  | { state: 'sent'; ok: number; failed: number }
  | { state: 'error'; msg: string }

export function People() {
  const [teams, setTeams] = useState<TeamRow[] | null>(null)
  const [people, setPeople] = useState<Person[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)

  const [q, setQ] = useState('')
  const [teamFilter, setTeamFilter] = useState<number | 'all'>('all')
  const [probes, setProbes] = useState<Record<number, Probe>>({})
  const [profileFor, setProfileFor] = useState<TeamRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [removing, setRemoving] = useState(false)

  const load = useCallback(async (force = false) => {
    if (!force && CACHE && Date.now() - CACHE.at < CACHE_TTL_MS) {
      setTeams(CACHE.teams); setPeople(CACHE.people); setProgress(100)
      return
    }
    setError(null); setPeople(null); setProgress(0)
    try {
      const ts = await api<TeamRow[]>('/teams')
      setTeams(ts)

      const perTeam = await pool(
        ts, 8,
        async t => {
          try {
            const ms = await api<MemberRow[]>(`/teams/${t.id}/members`)
            return ms.map(m => ({ ...m, team_id: t.id, team_name: t.name }))
          } catch {
            return [] as Person[]   // one unreadable team must not cost us the other 58
          }
        },
        done => setProgress(Math.round((done / ts.length) * 100)),
      )

      // Someone in two teams appears twice; keep the row that shows them active.
      const byUser = new Map<number, Person>()
      for (const p of perTeam.flat()) {
        const prev = byUser.get(p.user_id)
        if (!prev || (!prev.is_active && p.is_active)) byUser.set(p.user_id, p)
      }
      const list = [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name))
      CACHE = { at: Date.now(), people: list, teams: ts }
      setPeople(list)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const shown = useMemo(() => {
    if (!people) return []
    const needle = q.trim().toLowerCase()
    // Ids match EXACTLY, text matches as a substring. A substring id match would make
    // "3" return users 3, 13, 30, 33 and every team containing a 3 — useless when the
    // whole point of typing an id is to land on one row.
    const match = (p: Person) =>
      !needle ||
      p.name.toLowerCase().includes(needle) ||
      p.team_name.toLowerCase().includes(needle) ||
      String(p.user_id) === needle ||
      String(p.team_id) === needle
    return people.filter(p => (teamFilter === 'all' || p.team_id === teamFilter) && match(p))
  }, [people, q, teamFilter])

  async function probe(p: Person) {
    if (!confirm(
      `Send a real test notification to ${p.name} (user ${p.user_id})?\n\n` +
      `This is the only way the backend will tell us whether their device is ` +
      `reachable — it WILL appear on their phone.`,
    )) return
    setProbes(s => ({ ...s, [p.user_id]: { state: 'busy' } }))
    try {
      const r = await send<PushResult>('/notifications/test', 'POST', {
        user_id: p.user_id,
        title: 'Oscar test',
        body: 'Test notification from the Oscar admin panel.',
      }, { notFoundAsNull: true })
      setProbes(s => ({
        ...s,
        [p.user_id]: r === null
          ? { state: 'unreachable' }
          : { state: 'sent', ok: r.success_count, failed: r.failure_count },
      }))
    } catch (e) {
      setProbes(s => ({ ...s, [p.user_id]: { state: 'error', msg: (e as Error).message } }))
    }
  }

  if (error) return <ErrorBox error={error} onRetry={() => void load()} />
  if (!people) return <Spinner label={`Loading people… ${progress}%`} />

  return (
    <div className="space-y-5">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-56 flex-1">
          <Field label="Search by user name, user id, team name or team id">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-600" />
              <input value={q} onChange={e => setQ(e.target.value)} className={inputCls + ' pl-8'}
                     placeholder="name, user id, team…" spellCheck={false} />
            </div>
          </Field>
        </div>
        <div className="min-w-48">
          <Field label="Team">
            <select value={String(teamFilter)} className={inputCls}
                    onChange={e => setTeamFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
              <option value="all">All teams</option>
              {(teams ?? []).map(t => <option key={t.id} value={t.id}>{t.id} · {t.name}</option>)}
            </select>
          </Field>
        </div>
        {teamFilter !== 'all' && (
          <button onClick={() => setProfileFor(teams?.find(t => t.id === teamFilter) ?? null)}
                  className="flex items-center gap-2 rounded-xl border border-ink-600 bg-ink-800
                             px-3 py-2 text-xs font-medium transition hover:bg-ink-700">
            <Building2 className="size-3.5" /> Edit org profile
          </button>
        )}
        <button onClick={() => setCreating(true)}
                className="flex items-center gap-2 rounded-xl bg-brand-500 px-3 py-2
                           text-xs font-semibold text-white transition hover:bg-brand-600">
          <UserPlus className="size-3.5" /> Create login
        </button>
        <button onClick={() => setRemoving(true)}
                className="flex items-center gap-2 rounded-xl border border-rose-500/40
                           bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-300
                           transition hover:bg-rose-500/20">
          <UserMinus className="size-3.5" /> Remove user
        </button>
        <button onClick={() => void load(true)}
                title="Re-fetch every team, ignoring the 2-minute cache"
                className="flex items-center gap-2 rounded-xl border border-ink-600 bg-ink-800
                           px-3 py-2 text-xs font-medium transition hover:bg-ink-700">
          <RotateCw className="size-3.5" /> Reload
        </button>
        <div className="ml-auto text-xs text-ink-400">
          {shown.length} of {people.length}
        </div>
      </Card>

      {/* The API exposes no username/email and no device tokens. Saying so here stops
          the next person assuming the panel is just failing to show them. */}
      <p className="text-[11px] leading-relaxed text-ink-500">
        Search matches <strong className="text-ink-400">user name, user id, team name and team
        id</strong> — ids exactly, text as a substring. No username or email: the backend exposes
        neither. <strong className="text-ink-400">Last seen</strong> is when their app
        connection last dropped, not a login (nothing records logins). The
        <strong className="text-ink-400"> bell sends a real push</strong>: it is the only way to
        learn whether a device is reachable, because no endpoint returns device tokens.
      </p>

      <Card>
        <Table head={['User', 'Team', 'Role', 'Presence', 'Unread', 'Push check', '']}>
          {shown.map(p => (
            <Row key={p.user_id} p={p} probe={probes[p.user_id]} onProbe={() => void probe(p)} />
          ))}
        </Table>
        {!shown.length && (
          <div className="py-14 text-center text-sm text-ink-500">No one matches that.</div>
        )}
      </Card>

      {profileFor && <OrgProfileEditor team={profileFor} onClose={() => setProfileFor(null)} />}
      {creating && (
        <CreateLogin teams={teams ?? []}
                     onClose={() => setCreating(false)}
                     onCreated={() => void load(true)} />
      )}
      {removing && (
        <RemoveUser onClose={() => setRemoving(false)}
                    onChanged={() => void load(true)} />
      )}
    </div>
  )
}

/** Stands in for a gate-code field that came from .env.local. Shown rather than
 *  omitted entirely so it is obvious the code IS being sent — a silently-missing
 *  field looks like the form forgot it, and the resulting INVALID_*_CODE would send
 *  someone hunting in the wrong place. */
function GateLoaded({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-ink-700 bg-ink-850/60
                    px-3 py-2.5 text-[11px] text-ink-400">
      <ShieldCheck className="size-3.5 shrink-0 text-emerald-400" />
      <span><strong className="text-ink-300">{label}</strong> loaded from
        <span className="font-mono"> .env.local</span> — sent automatically</span>
    </div>
  )
}

/** Shell for the two modals — Card takes no handlers, so the click-through guard
 *  lives on a wrapper. */
function Modal({ children, onClose, wide }: {
  children: React.ReactNode; onClose: () => void; wide?: boolean
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
         onClick={onClose}>
      <div className={wide ? 'w-full max-w-xl' : 'w-full max-w-lg'}
           onClick={e => e.stopPropagation()}>
        <Card className="p-6 rise">{children}</Card>
      </div>
    </div>
  )
}

/**
 * Create a login — POST /auth/register on the deployed backend.
 *
 * The gate codes are NOT hardcoded in this repo. They are entered once and kept in
 * localStorage beside the admin secret: committing PLATFORM_INVITE_CODE and
 * SUPER_ADMIN_PASS would put the two credentials that let anyone create an account
 * on this unauthenticated backend into a git history.
 *
 * 🔴 team_lead is the ONLY path that ever reveals an invite code. The backend returns
 * `invite_code` in that one response and NO endpoint reads it back afterwards — see
 * the note rendered below. So the code is shown once, loudly, with a copy button.
 */
function CreateLogin({ teams, onClose, onCreated }: {
  teams: TeamRow[]; onClose: () => void; onCreated: () => void
}) {
  const [kind, setKind] = useState<'team_member' | 'team_lead' | 'personal'>('team_member')
  const [f, setF] = useState({
    name: '', email: '', password: '',
    workspace_invite_code: '', org_name: '',
  })
  const [gate, setGate] = useState({
    platform: ENV_PLATFORM_CODE || localStorage.getItem(LS_PLATFORM_CODE) || '',
    admin: ENV_SUPER_ADMIN || localStorage.getItem(LS_SUPER_ADMIN) || '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<RegisteredUser | null>(null)
  const [copied, setCopied] = useState(false)

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.value })

  async function submit() {
    setBusy(true); setErr(null)
    const body: Record<string, string> = {
      account_type: kind, name: f.name.trim(),
      email: f.email.trim(), password: f.password,
    }
    if (kind === 'personal') body.platform_invite_code = gate.platform
    if (kind === 'team_member') body.workspace_invite_code = f.workspace_invite_code.trim()
    if (kind === 'team_lead') {
      body.org_name = f.org_name.trim()
      body.super_admin_code = gate.admin
    }
    try {
      const r = await send<{ success: boolean; user: RegisteredUser }>(
        '/auth/register', 'POST', body)
      // Remember the gate codes only once a real registration succeeded — caching a
      // typo would make every later attempt fail for a reason nobody can see.
      if (kind === 'personal') localStorage.setItem(LS_PLATFORM_CODE, gate.platform)
      if (kind === 'team_lead') localStorage.setItem(LS_SUPER_ADMIN, gate.admin)
      setDone(r!.user)
      onCreated()
    } catch (e) {
      setErr((e as Error).message)
    } finally { setBusy(false) }
  }

  if (done) {
    return (
      <Modal onClose={onClose}>
        <div className="mb-4 text-sm font-semibold text-emerald-300">Account created</div>
        <dl className="space-y-1.5 text-sm">
          {([['Name', done.name], ['Email', done.email], ['User id', String(done.id)],
             ['Account type', done.account_type],
             ['Team', done.team_name ? `${done.team_name} (${done.team_id})` : '—']] as const)
            .map(([k, v]) => (
              <div key={k} className="flex gap-3">
                <dt className="w-28 shrink-0 text-ink-400">{k}</dt>
                <dd className="font-medium">{v}</dd>
              </div>
            ))}
        </dl>

        {done.invite_code && (
          <div className="mt-5 rounded-xl border border-amber-500/30 bg-amber-500/[.07] p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[.12em] text-amber-300">
              Workspace invite code — copy it now
            </div>
            <div className="mt-2 flex items-center gap-3">
              <code className="rounded-lg bg-ink-850 px-3 py-2 font-mono text-base tracking-wider">
                {done.invite_code}
              </code>
              <button onClick={() => {
                void navigator.clipboard.writeText(done.invite_code!)
                setCopied(true)
              }} className="rounded-lg border border-ink-600 px-2.5 py-1.5 text-[11px]
                            transition hover:bg-ink-700">
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="mt-2.5 text-[11px] leading-relaxed text-amber-200/80">
              This is the only time it is shown. The backend returns an invite code when a
              workspace is created and <strong>no endpoint reads it back</strong>, so if you
              lose it there is no way to recover it from the admin panel — members would
              have to be added another way.
            </p>
          </div>
        )}

        <button onClick={onClose}
          className="mt-6 rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold text-white
                     transition hover:bg-brand-600">Done</button>
      </Modal>
    )
  }

  const ready = f.name.trim() && f.email.trim() && f.password
    && (kind !== 'personal' || gate.platform)
    && (kind !== 'team_member' || f.workspace_invite_code.trim())
    && (kind !== 'team_lead' || (f.org_name.trim() && gate.admin))

  return (
    <Modal onClose={onClose} wide>
      <div className="mb-5">
        <div className="text-sm font-semibold">Create a login</div>
        <div className="text-[11px] text-ink-500">POST /auth/register on the live backend</div>
      </div>

      <div className="mb-5 flex gap-2">
        {(['team_member', 'team_lead', 'personal'] as const).map(k => (
          <button key={k} onClick={() => { setKind(k); setErr(null) }}
            className={cx('rounded-xl px-3 py-2 text-xs font-medium transition',
              kind === k ? 'bg-brand-500/15 text-brand-400 ring-1 ring-brand-500/30'
                         : 'border border-ink-600 text-ink-300 hover:bg-ink-800')}>
            {k.replace('_', ' ')}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        <Field label="Full name">
          <input className={inputCls} value={f.name} onChange={set('name')} />
        </Field>
        <Field label="Email">
          <input className={inputCls} value={f.email} onChange={set('email')}
                 type="email" spellCheck={false} autoComplete="off" />
        </Field>
        <Field label="Password">
          <input className={inputCls} value={f.password} onChange={set('password')}
                 type="text" spellCheck={false} autoComplete="off" />
        </Field>

        {kind === 'team_member' && (
          <>
            <Field label="Workspace invite code">
              <input className={inputCls} value={f.workspace_invite_code}
                     onChange={set('workspace_invite_code')}
                     placeholder="e.g. OSC-G289ZU" spellCheck={false} />
            </Field>
            <p className="text-[11px] leading-relaxed text-ink-500">
              You have to type this — the deployed API exposes invite codes only in the
              response when a workspace is first created, and there is no endpoint that
              lists them for the {teams.length} existing teams.
            </p>
          </>
        )}

        {kind === 'team_lead' && (
          <>
            <Field label="Organisation name (creates a new workspace)">
              <input className={inputCls} value={f.org_name} onChange={set('org_name')} />
            </Field>
            {ENV_SUPER_ADMIN
              ? <GateLoaded label="Super admin code" />
              : (
                <Field label="Super admin code">
                  <input className={inputCls} value={gate.admin} type="password"
                         onChange={e => setGate({ ...gate, admin: e.target.value })}
                         placeholder="SUPER_ADMIN_PASS" autoComplete="off" />
                </Field>
              )}
          </>
        )}

        {kind === 'personal' && (
          ENV_PLATFORM_CODE
            ? <GateLoaded label="Platform invite code" />
            : (
              <Field label="Platform invite code">
                <input className={inputCls} value={gate.platform} type="password"
                       onChange={e => setGate({ ...gate, platform: e.target.value })}
                       placeholder="PLATFORM_INVITE_CODE" autoComplete="off" />
              </Field>
            )
        )}

        {err && <ErrorBox error={err} />}

        <div className="flex items-center gap-3 pt-1">
          <button onClick={() => void submit()} disabled={busy || !ready}
            className="rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold text-white
                       transition hover:bg-brand-600 disabled:opacity-40">
            {busy ? 'Creating…' : 'Create account'}
          </button>
          <button onClick={onClose}
            className="rounded-xl border border-ink-600 px-4 py-2 text-sm transition hover:bg-ink-800">
            Cancel
          </button>
        </div>

        <p className="text-[11px] leading-relaxed text-ink-500">
          This writes a real account to the live database. The gate codes are kept in this
          browser only — they are never committed to the repo.
        </p>
      </div>
    </Modal>
  )
}

/** GET /admin/users?email= — the only route that turns an address into a user_id. */
type FoundUser = {
  id: number; name: string; username: string; email: string | null
  account_type: string; is_active: number
  teams: { team_id: number; team_name: string; role: string; is_active: number }[]
  owns_teams: { id: number; name: string }[]
}

/**
 * Remove a user, found by EMAIL.
 *
 * Email rather than name because names are not unique — there are two distinct users
 * called "Sriram" (5 and 416), and the People search matches on name alone, so it cannot
 * tell them apart. GET /admin/users?email= exists precisely to close that gap.
 *
 * Two different removals, deliberately separated:
 *   · Remove from a team — PATCH, reversible, keeps the login and all their history.
 *   · Delete the account  — DELETE, irreversible, and the only way to free the email so
 *     the same address can be re-created (email and username are UNIQUE).
 *
 * The delete needs the word DELETE typed. This is the panel's only destructive action and
 * the backend gives no undo, so a mis-click must not be enough.
 */
function RemoveUser({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [email, setEmail] = useState('')
  const [found, setFound] = useState<FoundUser[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirm, setConfirm] = useState('')
  const [done, setDone] = useState<string | null>(null)

  const lookup = async () => {
    const e = email.trim()
    if (!e) return
    setBusy(true); setErr(null); setFound(null); setDone(null); setConfirm('')
    try {
      // Fall back to a substring search when the exact address finds nobody — a
      // mistyped domain is the common case and "not found" is a dead end otherwise.
      const byEmail = await api<{ users: FoundUser[] }>(
        `/admin/users?email=${encodeURIComponent(e)}`)
      const users = byEmail.users.length
        ? byEmail.users
        : (await api<{ users: FoundUser[] }>(`/admin/users?q=${encodeURIComponent(e)}`)).users
      setFound(users)
    } catch (x) { setErr((x as Error).message) } finally { setBusy(false) }
  }

  const leaveTeam = async (u: FoundUser, teamId: number, teamName: string) => {
    setBusy(true); setErr(null)
    try {
      await send(`/admin/users/${u.id}/teams/${teamId}`, 'PATCH', { is_active: 0 })
      setDone(`${u.name} removed from ${teamName}. Their login still works — they must ` +
              `log out and back in before the app stops showing that team.`)
      setFound(null); onChanged()
    } catch (x) { setErr((x as Error).message) } finally { setBusy(false) }
  }

  const deleteAccount = async (u: FoundUser) => {
    setBusy(true); setErr(null)
    try {
      await send(`/admin/users/${u.id}`, 'DELETE')
      setDone(`${u.name} deleted. ${u.email} is free again, so the same address can be ` +
              `used in Create login.`)
      setFound(null); onChanged()
    } catch (x) { setErr((x as Error).message) } finally { setBusy(false) }
  }

  return (
    <Modal onClose={onClose} wide>
      <div className="space-y-4">
        <div>
          <div className="text-base font-semibold">Remove a user</div>
          <div className="mt-1 text-xs text-ink-500">
            Look them up by email — names are not unique.
          </div>
        </div>

        <div className="flex gap-2">
          <input className={inputCls} value={email} type="email" spellCheck={false}
                 autoComplete="off" placeholder="someone@example.com"
                 onChange={e => setEmail(e.target.value)}
                 onKeyDown={e => { if (e.key === 'Enter') void lookup() }} />
          <button onClick={() => void lookup()} disabled={busy || !email.trim()}
                  className="flex shrink-0 items-center gap-2 rounded-xl bg-brand-500 px-4
                             text-xs font-semibold text-white transition hover:bg-brand-600
                             disabled:opacity-40">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
            Find
          </button>
        </div>

        {err && <ErrorBox error={err} />}
        {done && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3
                          text-xs leading-relaxed text-emerald-200">{done}</div>
        )}
        {found?.length === 0 && (
          <div className="text-sm text-ink-500">Nobody matches that.</div>
        )}

        {found?.map(u => (
          <div key={u.id} className="space-y-3 rounded-xl border border-ink-600 bg-ink-800 p-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm font-semibold">{u.name}</span>
              <span className="text-xs text-ink-400">{u.email}</span>
              <Badge>user {u.id}</Badge>
              <Badge>{u.account_type}</Badge>
            </div>

            {u.owns_teams.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2
                              text-[11px] leading-relaxed text-amber-200">
                Owns {u.owns_teams.map(t => `${t.name} (${t.id})`).join(', ')}. Deleting this
                account transfers the team to its oldest other member, or dissolves it if
                there is nobody left.
              </div>
            )}

            <div className="space-y-1.5">
              {u.teams.length === 0 && (
                <div className="text-xs text-ink-500">In no teams.</div>
              )}
              {u.teams.map(t => (
                <div key={t.team_id} className="flex items-center gap-2 text-xs">
                  <span className="text-ink-300">{t.team_name}</span>
                  <Badge>{t.team_id}</Badge>
                  <span className="text-ink-500">{t.role}</span>
                  {t.is_active
                    ? <button onClick={() => void leaveTeam(u, t.team_id, t.team_name)}
                              disabled={busy}
                              className="ml-auto rounded-lg border border-ink-600 px-2 py-1
                                         font-medium transition hover:bg-ink-700
                                         disabled:opacity-40">
                        Remove from this team
                      </button>
                    : <span className="ml-auto text-ink-500">already removed</span>}
                </div>
              ))}
            </div>

            <div className="space-y-2 border-t border-ink-700 pt-3">
              <div className="text-[11px] leading-relaxed text-rose-300">
                Deleting is permanent — the account, its memberships and, by cascade, their
                tasks, meetings, chat history and memories. There is no undo. Do this only
                to free the email address for a fresh Create login.
              </div>
              <div className="flex gap-2">
                <input className={inputCls} value={confirm} spellCheck={false}
                       placeholder="type DELETE to confirm"
                       onChange={e => setConfirm(e.target.value)} />
                <button onClick={() => void deleteAccount(u)}
                        disabled={busy || confirm !== 'DELETE'}
                        className="flex shrink-0 items-center gap-2 rounded-xl bg-rose-600
                                   px-4 text-xs font-semibold text-white transition
                                   hover:bg-rose-500 disabled:opacity-40">
                  <Trash2 className="size-3.5" /> Delete account
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}

function Row({ p, probe, onProbe }: { p: Person; probe?: Probe; onProbe: () => void }) {
  // Unread count is lazy — 80 users × one call each on mount would hammer a free tier.
  const [unread, setUnread] = useState<number | null>(null)
  const [loadingUnread, setLoadingUnread] = useState(false)

  async function loadUnread() {
    setLoadingUnread(true)
    try {
      const rows = await api<NotificationRow[]>(`/notifications/${p.user_id}?unread_only=true`)
      setUnread(rows.length)
    } catch {
      setUnread(-1)
    } finally { setLoadingUnread(false) }
  }

  return (
    <tr className={cx('transition hover:bg-ink-800/40', !p.is_active && 'opacity-50')}>
      <Td>
        <div className="font-medium">{p.name}</div>
        <div className="font-mono text-[11px] text-ink-500">id {p.user_id}</div>
      </Td>
      <Td className="text-xs text-ink-300">{p.team_name}<span className="text-ink-600"> · {p.team_id}</span></Td>
      <Td>
        <Badge tone={p.role === 'team_lead' ? 'on' : undefined}>{p.role}</Badge>
        {!p.is_active && <div className="mt-1"><Badge>inactive</Badge></div>}
      </Td>
      <Td>
        {p.online
          ? <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
              <span className="size-1.5 rounded-full bg-emerald-400" /> online
            </span>
          : p.last_seen
            ? <span className="text-xs text-ink-400">{ago(p.last_seen)}</span>
            : <Empty />}
      </Td>
      <Td>
        {unread === null
          ? <button onClick={() => void loadUnread()} disabled={loadingUnread}
              className="rounded-lg border border-ink-600 px-2 py-1 text-[11px] text-ink-400
                         transition hover:bg-ink-700 disabled:opacity-40">
              {loadingUnread ? '…' : 'check'}
            </button>
          : unread < 0
            ? <span className="text-[11px] text-rose-300">failed</span>
            : <span className="tabular-nums text-sm">{unread}</span>}
      </Td>
      <Td>
        {!probe && <span className="text-[11px] text-ink-600">not checked</span>}
        {probe?.state === 'busy' && <Loader2 className="size-3.5 animate-spin text-ink-400" />}
        {probe?.state === 'unreachable' && (
          <span className="text-[11px] font-medium text-rose-300" title="404 — no active device tokens">
            no active device
          </span>
        )}
        {probe?.state === 'sent' && (
          <span className={cx('text-[11px] font-medium',
            probe.ok ? 'text-emerald-300' : 'text-amber-300')}>
            {probe.ok} delivered{probe.failed ? `, ${probe.failed} failed` : ''}
          </span>
        )}
        {probe?.state === 'error' && (
          <span className="text-[11px] text-rose-300" title={probe.msg}>error</span>
        )}
      </Td>
      <Td>
        <button onClick={onProbe} disabled={probe?.state === 'busy'}
          title="Send a real test notification to this user"
          className="flex items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-800
                     px-2.5 py-1.5 text-[11px] font-medium transition hover:bg-ink-700
                     disabled:opacity-40">
          <Bell className="size-3" /> Test
        </button>
      </Td>
    </tr>
  )
}

/**
 * Org profile editor — PUT /admin/org-profile/{team_id}, the one real write the
 * deployed backend offers.
 *
 * Reading it back is indirect: there is no GET for the profile, so the current copy
 * comes from GET /assistant/business, which is what users actually see. That endpoint
 * resolves DB profile → org MCP → generic default, so for a team WITH an MCP it shows
 * MCP text. Saving would then create a DB row that permanently overrides that MCP —
 * which is why teams with a resolved MCP get a blocking warning below rather than a
 * quiet save.
 */
function OrgProfileEditor({ team, onClose }: { team: TeamRow; onClose: () => void }) {
  const [form, setForm] = useState<{ business: string; short: string; details: string } | null>(null)
  const [hasMcp, setHasMcp] = useState<boolean | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let dead = false
    ;(async () => {
      try {
        // Any member of the team resolves the same org profile.
        const members = await api<MemberRow[]>(`/teams/${team.id}/members`)
        const uid = members.find(m => m.is_active)?.user_id ?? members[0]?.user_id
        // /admin/mcp-config answers {count, rows}, NOT a bare array — matching the
        // Mcp view. Getting this wrong throws inside the load and shows an error
        // instead of the form.
        const [biz, mcp] = await Promise.all([
          uid ? api<BusinessProfile>(`/assistant/business?user_id=${uid}`) : Promise.resolve(null),
          api<{ rows: McpRow[] }>('/admin/mcp-config').catch(() => ({ rows: [] as McpRow[] })),
        ])
        if (dead) return
        setHasMcp(((mcp.rows ?? []).find(m => m.id === team.id)?.resolved.length ?? 0) > 0)
        setForm({
          business: biz?.business ?? '',
          short: biz?.note ?? '',
          details: biz?.details ?? '',
        })
      } catch (e) {
        if (!dead) setErr((e as Error).message)
      }
    })()
    return () => { dead = true }
  }, [team.id])

  async function save() {
    if (!form) return
    setSaving(true); setErr(null)
    try {
      await send(`/admin/org-profile/${team.id}`, 'PUT', {
        business: form.business, short: form.short, details: form.details,
      })
      setSaved(true)
    } catch (e) {
      setErr((e as Error).message)
    } finally { setSaving(false) }
  }

  return (
    <Modal onClose={onClose}>
      <>
        <div className="mb-5">
          <div className="text-sm font-semibold">Org profile · {team.name}</div>
          <div className="text-[11px] text-ink-500">team {team.id} — shown in the app's business info box</div>
        </div>

        {hasMcp && (
          <div className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/[.06] px-3 py-2.5
                          text-[11px] leading-relaxed text-amber-200">
            This team has a working MCP, so the text above comes from <em>their own</em> data source.
            Saving here writes a database profile that <strong>permanently overrides</strong> it —
            the MCP copy will stop being used. Only save if that is what you want.
          </div>
        )}

        {err && <ErrorBox error={err} />}
        {!form
          ? <Spinner label="Loading current profile…" />
          : (
            <div className="space-y-4">
              <Field label="Business name">
                <input className={inputCls} value={form.business}
                       onChange={e => { setSaved(false); setForm({ ...form, business: e.target.value }) }} />
              </Field>
              <Field label="Short note">
                <input className={inputCls} value={form.short}
                       onChange={e => { setSaved(false); setForm({ ...form, short: e.target.value }) }} />
              </Field>
              <Field label="Details">
                <textarea className={inputCls + ' min-h-28 resize-y'} value={form.details}
                          onChange={e => { setSaved(false); setForm({ ...form, details: e.target.value }) }} />
              </Field>
              <div className="flex items-center gap-3 pt-1">
                <button onClick={() => void save()} disabled={saving}
                  className="rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold text-white
                             transition hover:bg-brand-600 disabled:opacity-40">
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button onClick={onClose}
                  className="rounded-xl border border-ink-600 px-4 py-2 text-sm transition hover:bg-ink-800">
                  Close
                </button>
                {saved && <span className="text-xs text-emerald-300">Saved.</span>}
              </div>
            </div>
          )}
      </>
    </Modal>
  )
}
