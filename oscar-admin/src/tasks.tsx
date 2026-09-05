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

import { useEffect, useState } from 'react'
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
   * The chosen team's roster, so the user filter is a list of NAMES rather than an
   * id typed from memory. Scoped to the team on purpose: "user id" was a free-text
   * box whose only hint was "e.g. 48", and picking the wrong number returns an
   * empty table that looks identical to a person with no tasks.
   *
   * GET /teams/{id}/members — no admin route lists a team's members (/admin/users
   * needs an email or a search string), and this one already backs People and the
   * program console. It carries no email or username, which is exactly right here.
   *
   * Only fetched once a team is chosen. Across ALL teams the list would be ~58
   * names with no way to tell two "Sriram"s apart, and the id is shown beside every
   * name for that reason.
   */
  const [members, setMembers] = useState<MemberRow[]>([])
  useEffect(() => {
    if (!team) { setMembers([]); return }
    let live = true
    api<MemberRow[]>(`/teams/${team}/members`)
      .then(m => { if (live) setMembers(m) })
      // A roster that fails to load must not break the page: the filter falls back
      // to "any" and every other filter keeps working.
      .catch(() => { if (live) setMembers([]) })
    return () => { live = false }
  }, [team])

  const apply = () => {
    const p = new URLSearchParams()
    if (team) p.set('team_id', team)
    if (user) p.set('user_id', user)
    if (status) p.set('status', status)
    if (from) p.set('date_from', from)
    if (to) p.set('date_to', to)
    if (q.trim()) p.set('q', q.trim())
    p.set('limit', '200')
    setApplied('?' + p.toString())
  }
  const clear = () => {
    setTeam(''); setUser(''); setStatus(''); setFrom(''); setTo(''); setQ('')
    setApplied('?limit=200')
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
            {team ? 'Member' : 'User id'}
            {/* A dropdown once a team is chosen, a plain id box otherwise — with no
                team there is no roster to scope to, and 58 names across every team
                is a worse control than the box it replaced. */}
            {team ? (
              <select value={user} onChange={e => setUser(e.target.value)}
                      className={inputCls + ' mt-1 block'}>
                <option value="">anyone</option>
                {members.map(m => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.name} · {m.user_id}
                  </option>
                ))}
              </select>
            ) : (
              <input value={user} onChange={e => setUser(e.target.value)} placeholder="e.g. 48"
                     className={inputCls + ' mt-1 block w-24'} />
            )}
          </label>
          <label className="text-xs text-ink-400">
            Status
            <select value={status} onChange={e => setStatus(e.target.value)} className={inputCls + ' mt-1 block'}>
              <option value="">any</option>
              {['pending', 'in_progress', 'completed', 'cancelled', 'blocked'].map(s =>
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
          <button onClick={apply}
                  className="rounded-lg bg-brand-500/90 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500">
            <Search size={14} className="inline -mt-px mr-1" />Apply
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
          <Table head={['#', 'Title', 'Status', 'Priority', 'Due', 'Owner', 'Assignee', 'Board', '']}>
            {rows.data.tasks.map(t => (
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
