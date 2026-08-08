import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, ChevronLeft, Loader2, MessageSquare, Send, Users } from 'lucide-react'
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
type Task = {
  id: number; title: string; description?: string | null; status: string
  due_at?: string | null; due_label?: string; is_overdue?: boolean
  assignee_count?: number; completed_count?: number; pending_count?: number
  owner_name?: string; assigned_to_name?: string
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
      setTasks(ts.tasks ?? [])
    } catch (e) { setError((e as Error).message) }
  }, [])

  useEffect(() => { void load() }, [load])

  if (error) return <ErrorBox error={error} onRetry={load} />
  if (!members || !tasks) return <Spinner label="Loading the programme…" />
  if (!lead) return <ErrorBox error={`Team ${TEAM_ID} has no active team_lead — a task needs an owner.`} />

  if (open) {
    return <Thread task={open} leadId={lead.user_id} onBack={() => { setOpen(null); void load() }} />
  }

  return (
    <div className="space-y-6">
      <Compose members={members} leadId={lead.user_id} onDone={load} />
      <TaskList tasks={tasks} onOpen={setOpen} />
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

  const toggle = (id: number) => setPicked(s => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n
  })

  const count = all ? assignable.length : picked.size
  const canSend = title.trim() && due && count > 0 && !busy

  async function submit() {
    setBusy(true); setErr(null); setMsg(null)
    try {
      const body: Record<string, unknown> = {
        user_id: leadId,
        title: title.trim(),
        due_at: toDueAt(due),
        priority,
        description: desc.trim() || undefined,
        is_project: true,
      }
      // "All" is a server-side expansion, not a list built here — so anyone who
      // joins between loading this page and pressing send is still included.
      if (all) body.assign_to_all_members = true
      else body.assigned_to_user_ids = [...picked]

      const res = await send<{ task: Task }>('/items', 'POST', body)
      const task = res?.task
      if (!task) throw new Error('no task returned')

      if (comment.trim()) {
        await send(`/users/${leadId}/tasks/${task.id}/comments`, 'POST',
                   { body: comment.trim() })
      }
      setMsg(`Task #${task.id} created for ${task.assignee_count ?? count} people.`)
      setTitle(''); setDesc(''); setComment(''); setPicked(new Set())
      onDone()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
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
      {/* Said here rather than in a doc, because putting the Meet link in a comment
          and locking most of the cohort out of it has already happened twice. */}
      <p className="-mt-3 text-xs text-amber-500/90">
        Comments are readable by the owner and the primary assignee only. Anything
        everyone must see belongs in the description.
      </p>

      {err && <ErrorBox error={err} />}
      {msg && <div className="text-sm text-emerald-400">{msg}</div>}

      <button onClick={submit} disabled={!canSend}
              className={cx('flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition',
                canSend ? 'bg-brand-500 text-white hover:bg-brand-600'
                        : 'bg-white/5 text-ink-600')}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        {busy ? 'Creating…' : `Create & assign to ${count}`}
      </button>
    </Card>
  )
}

// ── Task list ───────────────────────────────────────────────────────────────

function TaskList({ tasks, onOpen }: { tasks: Task[]; onOpen: (t: Task) => void }) {
  if (!tasks.length) {
    return <Card className="p-6 text-sm text-ink-600">No tasks yet for this programme.</Card>
  }
  return (
    <Card className="p-6">
      <div className="text-sm font-semibold">Tasks ({tasks.length})</div>
      <div className="mt-4 space-y-2">
        {tasks.map(t => {
          const total = t.assignee_count ?? 1
          const done = t.completed_count ?? (t.status === 'completed' ? 1 : 0)
          return (
            <button key={t.id} onClick={() => onOpen(t)}
                    className="flex w-full items-center gap-3 rounded-xl bg-white/5 px-4 py-3 text-left hover:bg-white/10">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{t.title}</div>
                <div className="mt-0.5 truncate text-xs text-ink-600">
                  #{t.id} · {t.due_label ?? t.due_at ?? 'no due date'}
                  {t.description ? ' · has description' : ''}
                </div>
              </div>
              {t.is_overdue && <Badge tone="danger">overdue</Badge>}
              {total > 1 && (
                <span className="shrink-0 text-xs tabular-nums text-ink-600">
                  {done}/{total} done
                </span>
              )}
              <MessageSquare className="size-4 shrink-0 text-ink-600" />
            </button>
          )
        })}
      </div>
    </Card>
  )
}

// ── Thread ──────────────────────────────────────────────────────────────────

function Thread({ task, leadId, onBack }: {
  task: Task; leadId: number; onBack: () => void
}) {
  const [comments, setComments] = useState<Comment[] | null>(null)
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
