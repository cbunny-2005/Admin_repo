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
import { Bell, Building2, Loader2, Search } from 'lucide-react'
import { api, send } from './lib/api'
import type { BusinessProfile, McpRow, MemberRow, NotificationRow, PushResult, TeamRow } from './lib/api'
import { Badge, Card, Empty, ErrorBox, Field, Spinner, Table, Td, cx, inputCls } from './ui'

type Person = MemberRow & { team_id: number; team_name: string }

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

  // One pass over every team. Sequential on purpose: this is a free-tier backend and
  // 60 parallel requests is how you get rate-limited on the first page load.
  const load = useCallback(async () => {
    setError(null); setPeople(null); setProgress(0)
    try {
      const ts = await api<TeamRow[]>('/teams')
      setTeams(ts)
      const all: Person[] = []
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i]
        try {
          const ms = await api<MemberRow[]>(`/teams/${t.id}/members`)
          for (const m of ms) all.push({ ...m, team_id: t.id, team_name: t.name })
        } catch {
          // A single unreadable team must not cost us the other 47.
        }
        setProgress(Math.round(((i + 1) / ts.length) * 100))
      }
      // Someone in two teams appears twice; keep the row that shows them active.
      const byUser = new Map<number, Person>()
      for (const p of all) {
        const prev = byUser.get(p.user_id)
        if (!prev || (!prev.is_active && p.is_active)) byUser.set(p.user_id, p)
      }
      setPeople([...byUser.values()].sort((a, b) => a.name.localeCompare(b.name)))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const shown = useMemo(() => {
    if (!people) return []
    const needle = q.trim().toLowerCase()
    return people.filter(p =>
      (teamFilter === 'all' || p.team_id === teamFilter) &&
      (!needle || p.name.toLowerCase().includes(needle) || String(p.user_id) === needle),
    )
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
          <Field label="Search by name or user id">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-600" />
              <input value={q} onChange={e => setQ(e.target.value)} className={inputCls + ' pl-8'}
                     placeholder="e.g. Swathi, or 33" spellCheck={false} />
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
        <div className="ml-auto text-xs text-ink-400">
          {shown.length} of {people.length}
        </div>
      </Card>

      {/* The API exposes no username/email and no device tokens. Saying so here stops
          the next person assuming the panel is just failing to show them. */}
      <p className="text-[11px] leading-relaxed text-ink-500">
        Search matches <strong className="text-ink-400">name</strong> only — the backend exposes no
        username or email. <strong className="text-ink-400">Last seen</strong> is when their app
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
    </div>
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
         onClick={onClose}>
      {/* Card takes no handlers, so the click-through guard lives on a wrapper. */}
      <div className="w-full max-w-lg" onClick={e => e.stopPropagation()}>
      <Card className="p-6 rise">
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
      </Card>
      </div>
    </div>
  )
}
