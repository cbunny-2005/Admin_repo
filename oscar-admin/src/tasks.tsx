/**
 * Task tracking — every task, filterable, with a full audit trail per task.
 *
 * /admin/overview reports a task COUNT and nothing else, so it was possible to
 * see that 1,300 tasks existed without being able to look at one. The questions
 * this page exists to answer are the ones a count cannot: what is this person
 * working on, did that assignment actually land, why is this team's board empty,
 * and did a reminder really fire.
 *
 * Read-only. Nothing on this page writes.
 */

import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Search, X } from 'lucide-react'
import { useApi } from './useApi'
import { api } from './lib/api'
import type { AdminTaskDetail, AdminTaskRow, AdminTeamRow, MemberRow } from './lib/api'
import { Badge, Card, Empty, ErrorBox, Spinner, Stat, Table, Td, inputCls } from './ui'

/** IST-naive wall clock — render the digits as stored, never through the
 *  browser's local zone. `due_at` is the time the user chose; passing it through
 *  Date() would re-interpret it in whatever zone the viewer happens to be in. */
const wall = (s: string | null) => (s ? s.replace('T', ' ').slice(0, 16) : null)

// Badge resolves its colour from BADGE_TONES by key, so the status word IS the
// key — the entries were added to ui.tsx rather than mapped to a second vocabulary
// here, which would have meant two names for one state.

export function Tasks() {
  const [team, setTeam] = useState('')
  const [user, setUser] = useState('')
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [q, setQ] = useState('')
  // Applied separately from the inputs so typing does not fire a request per
  // keystroke against a table this size.
  const [applied, setApplied] = useState('?limit=200')
  const [openId, setOpenId] = useState<number | null>(null)

  const teams = useApi<{ count: number; teams: AdminTeamRow[] }>('/admin/teams')
  const rows = useApi<{ count: number; truncated: boolean; tasks: AdminTaskRow[] }>(
    '/admin/tasks' + applied)

  /**
   * The roster behind the Member filter, so it is a list of NAMES rather than an id
   * typed from memory. "User id" was a free-text box whose only guidance was the
   * placeholder "e.g. 48" — nothing on the page said which ids existed, and a wrong
   * number returns an empty table that looks identical to a person with no tasks.
   *
   * ALWAYS POPULATED, not only once a team is chosen. Gating it on a team meant the
   * control looked unchanged until you happened to pick one, so the feature was
   * invisible — the filter now works from the moment the page loads, and choosing a
   * team narrows it.
   *
   * GET /teams/{id}/members — no admin route lists a team's members (/admin/users
   * needs an email or a search string), and this one already backs People and the
   * program console. It carries no email or username, which is right for a filter.
   *
   * With no team chosen every team is fetched and merged, deduped by user_id because
   * the same person can appear in more than one roster. The team name rides along so
   * the option can say which workspace someone is in — two distinct users are called
   * "Sriram", so the id and the team are what tell them apart.
   */
  const [members, setMembers] = useState<(MemberRow & { team_name?: string })[]>([])
  useEffect(() => {
    let live = true
    const wanted: { id: number; name: string }[] = team
      ? [{ id: Number(team), name: '' }]
      : (teams.data?.teams ?? []).map(t => ({ id: t.id, name: t.name }))
    if (!wanted.length) { setMembers([]); return }

    Promise.all(wanted.map(t =>
      api<MemberRow[]>(`/teams/${t.id}/members`)
        // One unreachable team must not empty the whole list.
        .catch(() => [] as MemberRow[])
        .then(ms => ms.map(m => ({ ...m, team_name: t.name })))))
      .then(lists => {
        if (!live) return
        const byId = new Map<number, MemberRow & { team_name?: string }>()
        for (const m of lists.flat()) if (!byId.has(m.user_id)) byId.set(m.user_id, m)
        setMembers([...byId.values()].sort((a, b) => a.name.localeCompare(b.name)))
      })
      .catch(() => { if (live) setMembers([]) })
    return () => { live = false }
  }, [team, teams.data])

  /** The query the CURRENT inputs describe. Built in one place so the auto-apply
   *  below and the Apply button can never disagree about what a filter means. */
  const queryFor = (search: string) => {
    const p = new URLSearchParams()
    if (team) p.set('team_id', team)
    if (user) p.set('user_id', user)
    if (status) p.set('status', status)
    if (from) p.set('date_from', from)
    if (to) p.set('date_to', to)
    if (search.trim()) p.set('q', search.trim())
    p.set('limit', '200')
    return '?' + p.toString()
  }

  const apply = () => setApplied(queryFor(q))

  /**
   * Picking a team, a member, a status or a date applies IMMEDIATELY — those are
   * discrete choices, so one click is one intent and making someone then find
   * Apply is a second step with nothing to decide in between.
   *
   * 🔴 The text search is deliberately NOT in this dependency list. It changes on
   * every keystroke, and firing a request per character against a table this size
   * is what the Apply button existed to prevent — so typing still waits for Apply
   * or Enter. `q` is read through a ref rather than closed over, because including
   * it in the deps is exactly the thing being avoided.
   */
  const qRef = useRef(q)
  qRef.current = q
  const firstRun = useRef(true)
  useEffect(() => {
    // Skip the mount: the page already loads with '?limit=200' and re-requesting
    // the same thing on arrival is a wasted round trip against 1,300 rows.
    if (firstRun.current) { firstRun.current = false; return }
    setApplied(queryFor(qRef.current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team, user, status, from, to])
  const clear = () => {
    setTeam(''); setUser(''); setStatus(''); setFrom(''); setTo(''); setQ('')
    // Set explicitly rather than left to the auto-apply effect: React batches these
    // into one render so the effect would fire once and reach the same query, but
    // only because `q` is cleared in the same batch. Stating it here means Clear
    // does not depend on that reasoning holding.
    setApplied('?limit=200')
  }

  /**
   * Client-side sort over the rows already fetched. /admin/tasks has no sort
   * parameter, and the page caps at 200 rows anyway — sorting server-side would
   * mean re-fetching to reorder something already on screen.
   *
   * ⚠️ It therefore orders THE PAGE, not the table: with `truncated` set you are
   * sorting the first 200 rows the backend chose, not the 1,300 that match. The
   * banner above already says so, which is why this is honest rather than
   * misleading — but narrow the filters before reading a sorted list as a ranking.
   */
  const [sort, setSort] = useState<string | null>(null)
  const [dir, setDir] = useState<'asc' | 'desc'>('asc')
  const onSort = (key: string) => {
    if (sort === key) { setDir(d => (d === 'asc' ? 'desc' : 'asc')); return }
    setSort(key); setDir('asc')
  }

  // 🔴 Status sorts by LIFECYCLE, not alphabetically. A-Z puts cancelled first and
  // pending last, which is precisely backwards from how anyone reads a task board:
  // the live work belongs at the top and the closed work at the bottom.
  const STATUS_ORDER: Record<string, number> = {
    pending: 0, in_progress: 1, blocked: 2, completed: 3, cancelled: 4,
  }
  // Same reasoning: critical outranks normal, and a null priority reads as normal.
  const PRIORITY_ORDER: Record<string, number> = { critical: 0, normal: 1 }

  const sortRows = (list: AdminTaskRow[]) => {
    if (!sort) return list
    const rank = (t: AdminTaskRow): string | number => {
      switch (sort) {
        case 'status': return STATUS_ORDER[t.status] ?? 99
        case 'priority': return PRIORITY_ORDER[t.priority ?? 'normal'] ?? 99
        // Nulls last in BOTH directions — a task with no due date is not "earliest",
        // it is unscheduled, and letting it lead an ascending sort buries the rows
        // the sort was asked for.
        case 'due_at': return t.due_at ?? '\uffff'
        case 'id': return t.id
        case 'title': return t.title.toLowerCase()
        case 'owner': return (t.owner_name ?? '').toLowerCase()
        case 'assignee': return (t.assignee_name ?? '\uffff').toLowerCase()
        default: return 0
      }
    }
    // A copy: sort() mutates, and this array belongs to the fetch hook's state.
    return [...list].sort((a, b) => {
      const x = rank(a), y = rank(b)
      const c = x < y ? -1 : x > y ? 1 : 0
      return dir === 'asc' ? c : -c
    })
  }

  return (
    <div className="space-y-4">
      {/* Teams first: an empty project_tasks count is the condition that got the
          app rejected from review once, so it belongs where it is seen, not
          behind a per-team lookup. */}
      {teams.data && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {teams.data.teams.map(t => (
            <button key={t.id} onClick={() => { setTeam(String(t.id)); setApplied(`?team_id=${t.id}&limit=200`) }}
                    className="text-left">
              <Stat label={`${t.name} · ${t.members} members`}
                    value={t.tasks}
                    tone={t.project_tasks === 0 ? 'warn' : 'default'}
                    sub={`${t.project_tasks} on the team board · ${t.meetings} meetings`} />
            </button>
          ))}
        </div>
      )}

      <Card className="p-4 rise">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-ink-400">
            Team
            {/* Changing the team CLEARS the user: a member of the old team is not
                in the new one, so the pair would return an empty table that reads as
                "no tasks" rather than "impossible filter". */}
            <select value={team} onChange={e => { setTeam(e.target.value); setUser('') }}
                    className={inputCls + ' mt-1 block'}>
              <option value="">any</option>
              {teams.data?.teams.map(t => <option key={t.id} value={t.id}>{t.id} · {t.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-ink-400">
            Member
            {/* Always a select. The id is shown beside every name because two
                distinct users are called "Sriram", and the team because the same
                name can sit in two workspaces. */}
            <select value={user} onChange={e => setUser(e.target.value)}
                    className={inputCls + ' mt-1 block max-w-[260px]'}>
              {/* The empty option doubles as the hint. With no team chosen this is
                  everyone across all workspaces, so it says to narrow by team first
                  — the guidance sits IN the control being used, rather than as a
                  note beside it that is read after the mistake. */}
              <option value="">
                {team ? 'anyone on this team' : 'anyone — pick a team to narrow'}
              </option>
              {members.map(m => (
                <option key={m.user_id} value={m.user_id}>
                  {m.name} · {m.user_id}{m.team_name ? ` · ${m.team_name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-400">
            Status
            <select value={status} onChange={e => setStatus(e.target.value)} className={inputCls + ' mt-1 block'}>
              <option value="">any</option>
              {/* THREE, not the column's five. `status` accepts
                  pending/in_progress/completed/cancelled/blocked, but nothing in
                  this product ever writes in_progress or blocked — measured on the
                  whole table: 0 rows each. Offering them means two options that
                  always return an empty table, which reads as a broken filter
                  rather than as a true "none exist".

                  🔴 The dropdown is the only thing narrowed. `sortRows` still ranks
                  all five, and the backend is untouched, so a row written by some
                  other client still sorts and displays correctly — it just cannot
                  be picked here until it exists. Re-add the word when it does. */}
              {['pending', 'completed', 'cancelled'].map(s =>
                <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-xs text-ink-400">
            Due from
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                   className={inputCls + ' mt-1 block'} />
          </label>
          <label className="text-xs text-ink-400">
            Due to
            <input type="date" value={to} onChange={e => setTo(e.target.value)}
                   className={inputCls + ' mt-1 block'} />
          </label>
          <label className="text-xs text-ink-400 flex-1 min-w-[180px]">
            Title or description
            <input value={q} onChange={e => setQ(e.target.value)}
                   onKeyDown={e => e.key === 'Enter' && apply()}
                   placeholder="search…" className={inputCls + ' mt-1 block w-full'} />
          </label>
          {/* "Search", not "Apply": the dropdowns and dates now apply themselves, so
              the only thing left for a button is the text box beside it — and a
              button still labelled Apply would imply the filters were waiting on it. */}
          <button onClick={apply}
                  className="rounded-lg bg-brand-500/90 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500">
            <Search size={14} className="inline -mt-px mr-1" />Search
          </button>
          <button onClick={clear} className="rounded-lg border border-ink-700 px-3 py-2 text-sm text-ink-300 hover:bg-ink-800/60">
            <X size={14} className="inline -mt-px mr-1" />Clear
          </button>
        </div>
      </Card>

      {rows.loading && <Spinner />}
      {rows.error && <ErrorBox error={rows.error} onRetry={rows.reload} />}
      {rows.data && (
        <Card className="overflow-hidden rise">
          {rows.data.truncated && (
            <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-300">
              Showing the first {rows.data.count} — narrow the filters to see the rest.
            </div>
          )}
          <Table sort={sort} dir={dir} onSort={onSort}
                 head={[
                   { label: '#', sort: 'id' },
                   { label: 'Title', sort: 'title' },
                   { label: 'Status', sort: 'status' },
                   { label: 'Priority', sort: 'priority' },
                   { label: 'Due', sort: 'due_at' },
                   { label: 'Owner', sort: 'owner' },
                   { label: 'Assignee', sort: 'assignee' },
                   'Board', '']}>
            {sortRows(rows.data.tasks).map(t => (
              <tr key={t.id} className="hover:bg-ink-800/40 transition">
                <Td className="font-mono text-xs text-ink-400">{t.id}</Td>
                <Td className="text-sm max-w-[320px] truncate" >{t.title}</Td>
                <Td><Badge>{t.status}</Badge></Td>
                <Td>
                  <Badge>{t.priority ?? 'normal'}</Badge>
                </Td>
                <Td className="font-mono text-xs">
                  {/* An all-day task carries 23:59 as a placeholder for the DATE,
                      not as a deadline — showing the time would read as one. */}
                  {t.is_all_day
                    ? <span>{(t.due_at ?? '').slice(0, 10)} <span className="text-ink-500">anytime</span></span>
                    : wall(t.due_at) ?? <Empty />}
                </Td>
                <Td className="text-xs text-ink-300">{t.owner_name ?? `#${t.owner_id}`}</Td>
                <Td className="text-xs text-ink-300">
                  {t.assignee_name ?? (t.assignee_id ? `#${t.assignee_id}` : <Empty />)}
                </Td>
                <Td>{t.is_project ? <Badge>team</Badge> : <span className="text-xs text-ink-500">personal</span>}</Td>
                <Td>
                  <button onClick={() => setOpenId(t.id)} className="text-ink-400 hover:text-white">
                    <ChevronRight size={16} />
                  </button>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {openId !== null && <TaskDetail id={openId} onClose={() => setOpenId(null)} />}
    </div>
  )
}

/**
 * One task's audit trail.
 *
 * The timeline and the notification rows together answer what the task row alone
 * cannot: whether a reminder actually fired, who completed it and when. Worth
 * knowing while reading it — `meeting_update` notifications carry item_id = NULL,
 * so an empty notification list is not proof that nothing fired.
 */
function TaskDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const [d, setD] = useState<AdminTaskDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setD(null); setErr(null)
    api<AdminTaskDetail>(`/admin/tasks/${id}`)
      .then(r => { if (live) setD(r) })
      .catch(e => { if (live) setErr((e as Error).message) })
    // `live` guards the setState: closing the drawer while the request is in
    // flight would otherwise write into an unmounted component.
    return () => { live = false }
  }, [id])

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div className="h-full w-full max-w-2xl overflow-y-auto border-l border-ink-700 bg-ink-900 p-6"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div className="text-sm font-semibold">Task #{id}</div>
          <button onClick={onClose} className="text-ink-400 hover:text-white"><X size={18} /></button>
        </div>

        {!d && !err && <div className="mt-6"><Spinner /></div>}
        {err && <div className="mt-6"><ErrorBox error={err} /></div>}

        {d && (
          <div className="mt-5 space-y-6 text-sm">
            <Card className="p-4">
              <div className="text-base font-medium">{String(d.task.title ?? '')}</div>
              <div className="mt-2 grid gap-1 text-xs text-ink-300 sm:grid-cols-2">
                {(['status', 'priority', 'is_all_day', 'is_project', 'due_at',
                   'created_at', 'updated_at', 'completed_at', 'spilled_over_at',
                   'parent_task_id'] as const).map(k => (
                  <div key={k}>
                    <span className="text-ink-500">{k}: </span>
                    <span className="font-mono">{String(d.task[k] ?? '—')}</span>
                  </div>
                ))}
              </div>
            </Card>

            <Section title={`Assignees (${d.assignees.length})`}>
              {d.assignees.map(a => (
                <div key={a.user_id} className="flex justify-between py-1 text-xs">
                  <span>{a.name ?? `#${a.user_id}`}</span>
                  <span className="text-ink-400">{a.status}{a.completed_at ? ` · ${wall(a.completed_at)}` : ''}</span>
                </div>
              ))}
            </Section>

            <Section title={`Timeline (${d.timeline.length})`}>
              {d.timeline.map(e => (
                <div key={e.id} className="py-1 text-xs">
                  <span className="font-mono text-ink-500">{wall(e.created_at)}</span>{' '}
                  <Badge>{e.event_type}</Badge>{' '}
                  <span className="text-ink-300">{e.user_name ?? ''}</span>
                  {e.details && <div className="ml-1 text-ink-400">{e.details}</div>}
                </div>
              ))}
            </Section>

            <Section title={`Comments (${d.comments.length})`}>
              {d.comments.map(c => (
                <div key={c.id} className="py-1 text-xs">
                  <span className="text-ink-300">{c.user_name ?? `#${c.user_id}`}</span>{' '}
                  <span className="font-mono text-ink-500">{wall(c.created_at)}</span>
                  <div className="text-ink-200">{c.body}</div>
                </div>
              ))}
            </Section>

            <Section title={`Notifications (${d.notifications.length})`}>
              {d.notifications.map(n => (
                <div key={n.id} className="py-1 text-xs">
                  <Badge>{n.type}</Badge>{' '}
                  <span className="font-mono text-ink-500">{wall(n.created_at)}</span>
                  {' '}<span className="text-ink-500">→ user {n.user_id}</span>
                  {n.is_read ? <span className="text-ink-500"> · read</span> : null}
                  <div className="text-ink-300">{n.message}</div>
                </div>
              ))}
            </Section>

            <Section title={`Attachments (${d.attachments.length})`}>
              {d.attachments.map(a => (
                <div key={a.id} className="flex justify-between py-1 text-xs">
                  <span>{a.file_name}</span>
                  <span className="text-ink-500">{(a.byte_size / 1024).toFixed(0)} KB</span>
                </div>
              ))}
            </Section>
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const empty = !children || (Array.isArray(children) && children.length === 0)
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[.14em] text-ink-400">{title}</div>
      <div className="mt-2 divide-y divide-ink-800">
        {empty ? <div className="py-2 text-xs text-ink-600">none</div> : children}
      </div>
    </div>
  )
}
