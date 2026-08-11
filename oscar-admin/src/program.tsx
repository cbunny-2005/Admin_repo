import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, ChevronLeft, Loader2, MessageSquare, Send, UserPlus, Users } from 'lucide-react'
import { api, send } from './lib/api'
import { Badge, Card, ErrorBox, Field, Spinner, cx, inputCls } from './ui'

/**
 * Alumnx AI Engineer Program — assign work to the cohort and read the replies.
 *
 * Built against the SAME endpoints the Flutter app uses, deliberately: POST /items,
 * GET /teams/{id}/tasks, and the comment thread. Nothing bespoke, so a task created
 * here is indistinguishable from one created in the app and cannot drift from it.
 *
 * Two things this exists to fix, both learned the hard way this week:
 *
 *  • Assigning the cohort by hand meant fetching the member list and pasting N ids.
 *    "Everyone" is one flag here (assign_to_all_members), which also closes the race
 *    where someone joining mid-flow is silently left off.
 *
 *  • A task's material (links, instructions) kept ending up in a comment, which only
 *    the owner and the PRIMARY assignee can read — so on a 307-person task 306 people
 *    were locked out of the one thing they needed. Hence the description is the
 *    prominent field here and the comment is explicitly labelled as limited.
 */

const TEAM_ID = Number(import.meta.env.VITE_PROGRAM_TEAM_ID ?? 65)

type Member = {
  user_id: number; name: string; role: string; online?: boolean
}
type Assignee = {
  user_id: number; name: string | null
  status: 'completed' | 'pending'; completed_at?: string | null
}
type Task = {
  id: number; title: string; description?: string | null; status: string
  due_at?: string | null; due_label?: string; is_overdue?: boolean
  assignee_count?: number; completed_count?: number; pending_count?: number
  owner_name?: string; assigned_to_name?: string
  // Per-person completion state. Capped server-side at 25, so on a very large task
  // this is the caller's own row only — assignees_truncated says which.
  assignees?: Assignee[]; assignees_truncated?: boolean
}
type Comment = {
  id: number; user_id: number; user_name?: string; role: string
  body: string; created_at?: string
}

/** `datetime-local` gives "YYYY-MM-DDTHH:MM"; the backend stores IST-naive seconds. */
const toDueAt = (v: string) => (v.length === 16 ? `${v}:00` : v)

/** Default: tomorrow 09:00 local — a due time is REQUIRED by the backend, and an
 *  empty picker is the easiest way to get a 400 back. */
function defaultDue(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function Program() {
  const [members, setMembers] = useState<Member[] | null>(null)
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Task | null>(null)

  const lead = useMemo(
    () => members?.find(m => m.role === 'team_lead') ?? null, [members])

  const load = useCallback(async () => {
    setError(null)
    try {
      const [ms, ts] = await Promise.all([
        api<Member[]>(`/teams/${TEAM_ID}/members`),
        api<{ tasks: Task[] }>(`/teams/${TEAM_ID}/tasks?project=true`),
      ])
      setMembers(ms)
      // Cancelled tasks are NOT dropped by the API — GET /teams/{id}/tasks?project=true
      // returns every status, so three cancelled tasks sat in this list looking active
      // (no strikethrough, no badge) and someone tried to cancel them again to no effect.
      // A cancelled task is not part of the programme any more; hide it here rather than
      // deleting rows, so the comment threads survive.
      setTasks((ts.tasks ?? []).filter(t => t.status !== 'cancelled'))
    } catch (e) { setError((e as Error).message) }
  }, [])

  useEffect(() => { void load() }, [load])

  if (error) return <ErrorBox error={error} onRetry={load} />
  if (!members || !tasks) return <Spinner label="Loading the programme…" />
  if (!lead) return <ErrorBox error={`Team ${TEAM_ID} has no active team_lead — a task needs an owner.`} />

  if (open) {
    return (
      <Thread task={open} leadId={lead.user_id} members={members}
              onChanged={t => { setOpen({ ...open, ...t }); void load() }}
              onBack={() => { setOpen(null); void load() }} />
    )
  }

  return (
    <div className="space-y-6">
      <Compose members={members} leadId={lead.user_id} onDone={load} />
      <TaskList tasks={tasks} leadId={lead.user_id} onOpen={setOpen} onChanged={load} />
    </div>
  )
}

// ── Compose ─────────────────────────────────────────────────────────────────

function Compose({ members, leadId, onDone }: {
  members: Member[]; leadId: number; onDone: () => void
}) {
  const assignable = members.filter(m => m.user_id !== leadId)
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [comment, setComment] = useState('')
  const [due, setDue] = useState(defaultDue())
  const [priority, setPriority] = useState('medium')
  const [all, setAll] = useState(true)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)

  const toggle = (id: number) => setPicked(s => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n
  })

  const count = all ? assignable.length : picked.size
  const canSend = title.trim() && due && count > 0 && !busy

  /**
   * ONE TASK PER PERSON, created iteratively.
   *
   * The backend also supports a single shared row with per-person assignee rows
   * (assigned_to_user_ids / assign_to_all_members), and that is still what the Flutter
   * app produces. This panel deliberately does NOT use it: on a shared row, closing the
   * ITEM locks every remaining assignee out of ticking their own share, because
   * complete_item early-returns once item.status == 'completed'. One row per person
   * cannot hit that — each task has exactly one owner of its own state.
   *
   * The count you want (4/25) is reconstructed in the list by grouping on title + due
   * date, so nothing is lost by fanning out. No backend change: this is N calls to the
   * same POST /items the app already uses.
   *
   * Sequential on purpose. 25 concurrent POSTs against a single-worker uvicorn is a good
   * way to make the whole backend feel broken for everyone actually using the app, and
   * each call writes a row plus fires a notification.
   */
  async function submit() {
    setBusy(true); setErr(null); setMsg(null)
    const targets = all ? assignable.map(m => m.user_id) : [...picked]
    const made: number[] = []
    const failed: { id: number; why: string }[] = []
    try {
      for (const uid of targets) {
        const body: Record<string, unknown> = {
          user_id: leadId,
          title: title.trim(),
          due_at: toDueAt(due),
          priority,
          description: desc.trim() || undefined,
          is_project: true,
          assigned_to_user_id: uid,
        }
        try {
          const res = await send<{ task: Task }>('/items', 'POST', body)
          const task = res?.task
          if (!task) throw new Error('no task returned')
          made.push(task.id)
          if (comment.trim()) {
            // Per task, because each person now has their own thread. This is the real
            // cost of fanning out — the Trainer Central link has to be posted N times
            // rather than once on a shared row.
            await send(`/users/${leadId}/tasks/${task.id}/comments`, 'POST',
                       { body: comment.trim() })
          }
        } catch (e) {
          // One failure must not lose the other 24. Report which, do not silently skip.
          failed.push({ id: uid, why: (e as Error).message })
        }
        setProgress(made.length + failed.length)
      }

      if (!made.length) throw new Error(failed[0]?.why ?? 'nothing was created')
      setMsg(`Created ${made.length} task${made.length === 1 ? '' : 's'}` +
             (failed.length ? ` — ${failed.length} FAILED (${failed.map(f => f.id).join(', ')})`
                            : ' — one per person.'))
      setTitle(''); setDesc(''); setComment(''); setPicked(new Set())
      onDone()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false); setProgress(0) }
  }

  return (
    <Card className="space-y-5 p-6 rise">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Send className="size-4 text-brand-400" /> New task for the programme
      </div>

      <Field label="Title">
        <input className={inputCls} value={title} onChange={e => setTitle(e.target.value)}
               placeholder="On boarding call" />
      </Field>

      <Field label="Description — everyone assigned can read this">
        <textarea className={cx(inputCls, 'h-32 resize-y')} value={desc}
                  onChange={e => setDesc(e.target.value)}
                  placeholder="Meeting links, instructions, what to do…" />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Due — required">
          <input type="datetime-local" className={inputCls} value={due}
                 onChange={e => setDue(e.target.value)} />
        </Field>
        <Field label="Priority">
          <select className={inputCls} value={priority} onChange={e => setPriority(e.target.value)}>
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="low">low</option>
          </select>
        </Field>
      </div>

      {/* Assignees */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-600">
            Assign to
          </span>
          <span className="text-xs text-ink-600">{count} selected</span>
        </div>
        <label className="flex cursor-pointer items-center gap-2 rounded-xl bg-white/5 px-3 py-2.5 text-sm">
          <input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} />
          <Users className="size-4 text-brand-400" />
          <span className="font-semibold">Everyone in the programme</span>
          <span className="text-ink-600">({assignable.length} members)</span>
        </label>
        {!all && (
          <div className="mt-2 grid max-h-56 gap-1 overflow-auto rounded-xl bg-white/5 p-2 sm:grid-cols-2">
            {assignable.map(m => (
              <label key={m.user_id}
                     className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-white/5">
                <input type="checkbox" checked={picked.has(m.user_id)}
                       onChange={() => toggle(m.user_id)} />
                <span className="truncate">{m.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <Field label="First comment — optional">
        <textarea className={cx(inputCls, 'h-20 resize-y')} value={comment}
                  onChange={e => setComment(e.target.value)}
                  placeholder="Posted as the lead, right after the task is created" />
      </Field>
      {/* Every assignee can read the thread as of the comment-access fix. The
          description is still the better place for the material itself — a comment is
          a reply, not the brief. */}
      <p className="-mt-3 text-xs text-ink-600">
        Everyone assigned can read the comments. Only the owner and the primary
        assignee are notified of new ones.
      </p>

      {err && <ErrorBox error={err} />}
      {msg && <div className="text-sm text-emerald-400">{msg}</div>}

      <button onClick={submit} disabled={!canSend}
              className={cx('flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition',
                canSend ? 'bg-brand-500 text-white hover:bg-brand-600'
                        : 'bg-white/5 text-ink-600')}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        {busy ? `Creating ${progress}/${count}…` : `Create & assign to ${count}`}
      </button>
    </Card>
  )
}

// ── Task list ───────────────────────────────────────────────────────────────

/**
 * One row per PERSON is what gets created, so 25 people means 25 tasks. Showing 25
 * near-identical rows would be unreadable, so identical work is grouped back together
 * here — same title, same due time — and the count is derived from the group.
 *
 * Grouping on (title, due_at) rather than an id: there is no batch id on the row, and
 * adding one would be a schema change. The trade-off is honest and worth stating — two
 * genuinely separate tasks that share a title AND a due minute would merge in this view.
 * In practice that only happens when you assign the same thing twice by mistake, which
 * is a thing you want to see merged anyway.
 *
 * A shared-row task from the Flutter app still renders correctly: it arrives as a single
 * row carrying assignee_count/completed_count, so its group is one row and the count
 * comes from the server instead of the group size.
 */
type Group = {
  key: string; title: string; due: string; ids: number[]
  total: number; done: number; overdue: boolean
  hasDescription: boolean; sample: Task
}

function groupTasks(tasks: Task[]): Group[] {
  const by = new Map<string, Task[]>()
  for (const t of tasks) {
    const key = `${t.title.trim().toLowerCase()}|${t.due_at ?? ''}`
    const arr = by.get(key)
    arr ? arr.push(t) : by.set(key, [t])
  }
  return [...by.entries()].map(([key, ts]) => {
    const server = ts.length === 1 && (ts[0].assignee_count ?? 0) > 1
    return {
      key,
      title: ts[0].title,
      due: ts[0].due_label ?? ts[0].due_at ?? 'no due date',
      ids: ts.map(t => t.id),
      // A shared row reports its own counts; a fanned-out group counts its members.
      total: server ? (ts[0].assignee_count ?? 1) : ts.length,
      done: server
        ? (ts[0].completed_count ?? 0)
        : ts.filter(t => t.status === 'completed').length,
      overdue: ts.some(t => t.is_overdue),
      hasDescription: !!ts[0].description,
      sample: ts[0],
    }
  })
}

function TaskList({ tasks, leadId, onOpen, onChanged }: {
  tasks: Task[]; leadId: number; onOpen: (t: Task) => void; onChanged: () => void
}) {
  const groups = useMemo(() => groupTasks(tasks), [tasks])
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  /**
   * Mark every task in the group complete — the bulk action for a fanned-out batch.
   *
   * Sequential, and it skips the ones already done rather than re-sending: complete_item
   * is idempotent, but each call still costs a round trip and can fire a notification.
   */
  async function completeGroup(g: Group) {
    setBusyKey(g.key); setErr(null)
    const pending = tasks.filter(t => g.ids.includes(t.id) && t.status !== 'completed')
    let failed = 0
    for (const t of pending) {
      // user_id is a QUERY param on this route, not a body field. Sending it in the
      // body returns 422 — which is exactly what the first version of this did.
      try {
        await send(`/items/${t.id}/complete?user_id=${leadId}`, 'PATCH')
      } catch { failed++ }
    }
    setBusyKey(null)
    if (failed) setErr(`${failed} of ${pending.length} could not be completed.`)
    onChanged()
  }

  if (!tasks.length) {
    return <Card className="p-6 text-sm text-ink-600">No tasks yet for this programme.</Card>
  }
  return (
    <Card className="p-6">
      <div className="flex items-baseline gap-2">
        <div className="text-sm font-semibold">Tasks ({groups.length})</div>
        {groups.length !== tasks.length && (
          <span className="text-xs text-ink-600">
            {tasks.length} rows, one per person
          </span>
        )}
      </div>
      {err && <div className="mt-3"><ErrorBox error={err} /></div>}
      <div className="mt-4 space-y-2">
        {groups.map(g => {
          const allDone = g.done >= g.total
          return (
            <div key={g.key} className="rounded-xl bg-white/5">
              <div className="flex items-center gap-3 px-4 py-3">
                <button onClick={() => setExpanded(expanded === g.key ? null : g.key)}
                        className="min-w-0 flex-1 text-left">
                  <div className="truncate text-sm font-semibold">{g.title}</div>
                  <div className="mt-0.5 truncate text-xs text-ink-600">
                    {g.ids.length > 1 ? `${g.ids.length} tasks` : `#${g.ids[0]}`} · {g.due}
                    {g.hasDescription ? ' · has description' : ''}
                    {g.ids.length > 1 && (expanded === g.key ? ' · hide people' : ' · show people')}
                  </div>
                </button>
                {g.overdue && !allDone && <Badge tone="danger">overdue</Badge>}
                <span className={cx('shrink-0 text-xs tabular-nums',
                                    allDone ? 'text-emerald-300' : 'text-ink-600')}>
                  {g.done}/{g.total} done
                </span>
                {!allDone && (
                  <button onClick={() => void completeGroup(g)} disabled={busyKey === g.key}
                          title={`Mark all ${g.total - g.done} remaining complete`}
                          className="flex shrink-0 items-center gap-1.5 rounded-lg border
                                     border-ink-600 px-2 py-1 text-xs font-medium transition
                                     hover:bg-ink-700 disabled:opacity-40">
                    {busyKey === g.key
                      ? <Loader2 className="size-3.5 animate-spin" />
                      : <CheckCircle2 className="size-3.5" />}
                    Complete all
                  </button>
                )}
              </div>

              {/* One row per person, so a comment can be addressed to ONE of them.
                  This is the point of fanning out: a comment on a single-assignee task
                  is readable by that person, the owner and team leads — verified against
                  _task_for_user — and by NOBODY else on the cohort. On a shared row the
                  same comment goes to all 25. */}
              {expanded === g.key && g.ids.length > 1 && (
                <div className="space-y-1 border-t border-white/5 px-4 py-3">
                  <div className="pb-1 text-[11px] text-ink-600">
                    Open one person to comment privately — only they and the lead can read it.
                  </div>
                  {tasks
                    .filter(t => g.ids.includes(t.id))
                    .sort((a, b) => (a.assigned_to_name ?? '').localeCompare(b.assigned_to_name ?? ''))
                    .map(t => (
                      <button key={t.id} onClick={() => onOpen(t)}
                              className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5
                                         text-left text-xs hover:bg-white/10">
                        {t.status === 'completed'
                          ? <CheckCircle2 className="size-3.5 shrink-0 text-emerald-300" />
                          : <span className="size-3.5 shrink-0 rounded-full border border-ink-600" />}
                        <span className="min-w-0 flex-1 truncate">
                          {t.assigned_to_name ?? `user ${t.id}`}
                        </span>
                        <span className="shrink-0 text-ink-600">#{t.id}</span>
                        <MessageSquare className="size-3.5 shrink-0 text-ink-600" />
                      </button>
                    ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ── Thread ──────────────────────────────────────────────────────────────────

function Thread({ task, leadId, members, onBack, onChanged }: {
  task: Task; leadId: number; members: Member[]
  onBack: () => void; onChanged: (t: Task) => void
}) {
  const [comments, setComments] = useState<Comment[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      // Read AS THE LEAD: the thread is gated on owner/primary-assignee, so any
      // other id would 404 on a task the lead owns.
      const r = await api<{ comments: Comment[] }>(`/users/${leadId}/tasks/${task.id}/comments`)
      setComments(r.comments ?? [])
    } catch (e) { setError((e as Error).message) }
  }, [leadId, task.id])

  useEffect(() => { void load() }, [load])

  async function post() {
    if (!body.trim()) return
    setBusy(true)
    try {
      await send(`/users/${leadId}/tasks/${task.id}/comments`, 'POST', { body: body.trim() })
      setBody('')
      await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const total = task.assignee_count ?? 1
  const done = task.completed_count ?? 0
  const roster = task.assignees ?? []
  const assignedIds = new Set(roster.map(a => a.user_id))
  // Team members not on this task yet. The lead is excluded: they are assigning, not
  // doing, and adding them would hold the task open until they "completed" it too.
  const missing = members.filter(m => m.user_id !== leadId && !assignedIds.has(m.user_id))

  /** Add everyone on the team who is not already on the task. Uses the same
   *  server-side expansion as creation, so it cannot miss a late joiner. */
  async function addEveryone() {
    setAdding(true)
    try {
      const r = await send<{ task: Task }>(`/items/${task.id}`, 'PATCH',
                                          { user_id: leadId, assign_to_all_members: true })
      if (r?.task) onChanged(r.task)
    } catch (e) { setError((e as Error).message) } finally { setAdding(false) }
  }

  return (
    <div className="space-y-6">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-ink-600 hover:text-ink-300">
        <ChevronLeft className="size-4" /> Back
      </button>

      <Card className="space-y-3 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold">{task.title}</div>
            <div className="mt-1 text-xs text-ink-600">
              #{task.id} · {task.due_label ?? task.due_at} · {task.status}
            </div>
          </div>
          {total > 1 && (
            <div className="flex items-center gap-1.5 rounded-xl bg-white/5 px-3 py-2 text-sm">
              <CheckCircle2 className="size-4 text-emerald-400" />
              <span className="tabular-nums">{done}/{total}</span>
            </div>
          )}
        </div>
        {/* Assignees FIRST — who is on this and who has finished is the question this
            page exists to answer; the description is reference material below it. */}
        {roster.length > 0 && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-600">
                Assigned to {task.assignees_truncated
                  ? `(${total} people — list capped by the server)` : `(${total})`}
              </span>
              {missing.length > 0 && (
                <button onClick={addEveryone} disabled={adding}
                        className="flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1
                                   text-xs font-semibold hover:bg-white/10 disabled:opacity-50">
                  {adding ? <Loader2 className="size-3.5 animate-spin" />
                          : <UserPlus className="size-3.5" />}
                  Add {missing.length} missing
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[...roster]
                // Done first, so progress reads at a glance.
                .sort((a, b) => (a.status === b.status ? 0 : a.status === 'completed' ? -1 : 1))
                .map(a => (
                  <span key={a.user_id}
                        title={a.completed_at ? `completed ${a.completed_at}` : 'not done yet'}
                        className={cx('flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs',
                          a.status === 'completed'
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : 'bg-white/5 text-ink-400')}>
                    {a.status === 'completed' && <CheckCircle2 className="size-3" />}
                    {a.name ?? `user ${a.user_id}`}
                  </span>
                ))}
            </div>
            {missing.length > 0 && (
              <p className="mt-2 text-xs text-amber-500/90">
                {missing.length} team member{missing.length > 1 ? 's are' : ' is'} NOT on this
                task: {missing.map(m => m.name).join(', ')}
              </p>
            )}
          </div>
        )}

        {task.description && (
          <pre className="whitespace-pre-wrap rounded-xl bg-black/30 p-3 text-sm text-ink-300">
{task.description}
          </pre>
        )}
      </Card>

      {error && <ErrorBox error={error} onRetry={load} />}

      <Card className="p-6">
        <div className="text-sm font-semibold">Replies</div>
        {comments === null ? <Spinner /> : comments.length === 0 ? (
          <p className="mt-3 text-sm text-ink-600">No replies yet.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {comments.map(c => (
              <div key={c.id} className="rounded-xl bg-white/5 px-4 py-3">
                <div className="mb-1 flex items-baseline gap-2 text-xs text-ink-600">
                  <span className="font-semibold text-ink-300">{c.user_name ?? `user ${c.user_id}`}</span>
                  <span>{c.created_at}</span>
                </div>
                <div className="whitespace-pre-wrap text-sm">{c.body}</div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-5 flex gap-2">
          <input className={inputCls} value={body} placeholder="Reply as the lead…"
                 onChange={e => setBody(e.target.value)}
                 onKeyDown={e => { if (e.key === 'Enter') void post() }} />
          <button onClick={post} disabled={busy || !body.trim()}
                  className={cx('rounded-xl px-4 py-2.5 text-sm font-semibold',
                    body.trim() ? 'bg-brand-500 text-white hover:bg-brand-600' : 'bg-white/5 text-ink-600')}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : 'Send'}
          </button>
        </div>
      </Card>
    </div>
  )
}
