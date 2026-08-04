import { useState } from 'react'
import { Camera, ChevronRight, Search, X } from 'lucide-react'
import { useApi } from './useApi'
import { imgUrl } from './lib/api'
import type { McpRow, Overview as O, PhotoRow, SessionRow, TranscriptAtt, TranscriptMsg, WaRow } from './lib/api'
import { Badge, Card, Empty, ErrorBox, Spinner, Stat, Table, Td, inputCls } from './ui'

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0)

// ── Overview ────────────────────────────────────────────────────────────────

export function Overview() {
  const { data, error, loading, reload } = useApi<O>('/admin/overview')
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (!data) return null
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Users" value={data.users} sub={`${data.active_users} active`} />
        <Stat label="Teams" value={data.teams} sub={`${data.org_mcps} with an MCP`} />
        <Stat label="Chat sessions" value={data.sessions} sub={`${data.messages} messages`} />
        <Stat label="Photos" value={data.photos} tone="brand" sub={`${data.photos_with_contact} with a contact`} />
      </div>

      {/* The funnel the photo→contact feature is judged by. A photo stuck at
          "awaiting details" is the state Oscar is supposed to ask about, so a big
          number here is a signal about the agent, not just a statistic. */}
      <Card className="p-6 rise">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Camera className="size-4 text-brand-400" /> Photo → contact funnel
        </div>
        <div className="mt-5 space-y-4">
          {[
            { k: 'Uploaded', v: data.photos, c: 'bg-brand-500' },
            { k: 'Has details (business / context)', v: data.photos_with_details, c: 'bg-sky-500' },
            { k: 'Has a stored contact', v: data.photos_with_contact, c: 'bg-emerald-500' },
          ].map(r => (
            <div key={r.k}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
                <span className="text-ink-300">{r.k}</span>
                <span className="tabular-nums text-ink-400">
                  <span className="font-semibold text-ink-100">{r.v}</span>
                  <span className="ml-2 text-xs">{pct(r.v, data.photos)}%</span>
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-ink-800">
                <div className={`h-full rounded-full ${r.c} transition-[width] duration-700`}
                     style={{ width: `${pct(r.v, data.photos)}%` }} />
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap gap-2 border-t border-ink-700/60 pt-4">
          <Badge tone="awaiting_details">{data.awaiting_details} awaiting details</Badge>
          <Badge tone="awaiting_contact">{data.awaiting_contact} awaiting contact</Badge>
          {Object.entries(data.contacts_by_source).map(([k, v]) => (
            <Badge key={k} tone={k}>{v} × {k}</Badge>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Tasks" value={data.tasks} />
        <Stat label="Meetings" value={data.meetings} />
        <Stat label="WhatsApp directory" value={data.whatsapp_contacts} />
        <Stat label="Active sessions" value={data.active_sessions} />
      </div>
    </div>
  )
}

// ── Photos & contacts ───────────────────────────────────────────────────────

export function Photos() {
  const [state, setState] = useState('')
  const [uid, setUid] = useState('')
  const q = new URLSearchParams({ limit: '100' })
  if (state) q.set('state', state)
  if (uid) q.set('user_id', uid)
  const { data, error, loading, reload } = useApi<{ count: number; rows: PhotoRow[] }>(
    `/admin/photo-contacts?${q}`, [state, uid])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex gap-1 rounded-xl border border-ink-700 bg-ink-900/60 p-1">
          {[['', 'All'], ['awaiting_details', 'Awaiting details'],
            ['awaiting_contact', 'Awaiting contact'], ['complete', 'Complete']].map(([v, l]) => (
            <button key={v} onClick={() => setState(v)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                state === v ? 'bg-brand-500/15 text-brand-400' : 'text-ink-400 hover:text-ink-100'}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-600" />
          <input value={uid} onChange={e => setUid(e.target.value.replace(/\D/g, ''))}
                 placeholder="user id" className={inputCls + ' w-32 pl-8'} />
        </div>
        {data && <span className="ml-auto text-xs text-ink-400">{data.count} rows</span>}
      </div>

      {loading && <Spinner />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && (
        <Card className="overflow-hidden rise">
          <Table head={['Photo', 'User', 'Session', 'Business / context', 'Contact', 'Source', 'State']}>
            {data.rows.map(r => (
              <tr key={r.photo_id} className="hover:bg-ink-800/40 transition">
                <Td>
                  {/* Thumbnails are best-effort server-side: a failed generation
                      leaves thumb_key NULL and the route falls back to the original.
                      onError keeps a genuinely broken image from breaking the row. */}
                  <img src={imgUrl(r.thumbnail_url)} alt=""
                       className="size-11 rounded-lg object-cover ring-1 ring-ink-700"
                       onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />
                </Td>
                <Td><div className="text-sm">{r.user_name ?? <Empty />}</div>
                    <div className="font-mono text-[11px] text-ink-400">#{r.user_id}</div></Td>
                <Td><div className="max-w-40 truncate text-xs text-ink-300">{r.session_title ?? <Empty />}</div>
                    <div className="font-mono text-[11px] text-ink-400">#{r.session_id ?? '—'}</div></Td>
                <Td>
                  <div className="text-sm">{r.business_name ?? <Empty />}</div>
                  <div className="max-w-64 truncate text-[11px] text-ink-400">{r.context ?? ''}</div>
                </Td>
                <Td>
                  <div className="text-sm">{r.contact_name ?? <Empty />}</div>
                  <div className="font-mono text-[11px] text-ink-400">{r.contact_phone ?? ''}</div>
                </Td>
                <Td>{r.contact_source ? <Badge tone={r.contact_source}>{r.contact_source}</Badge>
                    : <span className="text-[11px] text-ink-600">unknown</span>}</Td>
                <Td><Badge tone={r.state}>{r.state.replace('_', ' ')}</Badge></Td>
              </tr>
            ))}
          </Table>
          {data.rows.length === 0 && (
            <div className="py-14 text-center text-sm text-ink-400">Nothing matches that filter.</div>
          )}
        </Card>
      )}
    </div>
  )
}

// ── Sessions + transcript drawer ────────────────────────────────────────────

export function Sessions() {
  const [open, setOpen] = useState<number | null>(null)
  const { data, error, loading, reload } = useApi<{ rows: SessionRow[] }>('/admin/sessions?limit=80')

  return (
    <div className="space-y-4">
      {loading && <Spinner />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && (
        <Card className="overflow-hidden rise">
          <Table head={['#', 'User', 'Title', 'Msgs', 'Photos', 'Last activity', '']}>
            {data.rows.map(r => (
              <tr key={r.id} onClick={() => setOpen(r.id)}
                  className="cursor-pointer hover:bg-ink-800/40 transition">
                <Td className="font-mono text-xs text-ink-400">{r.id}</Td>
                <Td><div className="text-sm">{r.user_name ?? <Empty />}</div>
                    <div className="font-mono text-[11px] text-ink-400">#{r.user_id}</div></Td>
                <Td><div className="max-w-72 truncate text-sm">{r.title ?? <Empty />}</div></Td>
                <Td className="tabular-nums text-sm">{r.msgs}</Td>
                <Td>{r.photos > 0
                  ? <Badge tone="ocr">{r.photos}</Badge>
                  : <span className="text-ink-600">0</span>}</Td>
                {/* The backend emits an explicit offset, so this is unambiguous —
                    these timestamps come from the app process's clock and older
                    rows genuinely mix UTC and IST. */}
                <Td className="text-xs text-ink-400">{r.last_message_at?.replace('T', ' ').slice(0, 19) ?? <Empty />}</Td>
                <Td><ChevronRight className="size-4 text-ink-600" /></Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      {open !== null && <Transcript sessionId={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function Transcript({ sessionId, onClose }: { sessionId: number; onClose: () => void }) {
  const { data, error, loading } = useApi<{
    messages: TranscriptMsg[]; attachments: TranscriptAtt[]
  }>(`/admin/sessions/${sessionId}/transcript`)

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="h-full w-full max-w-2xl overflow-y-auto border-l border-ink-700 bg-ink-900 p-6"
           onClick={e => e.stopPropagation()}>
        <div className="mb-5 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">Session #{sessionId}</div>
            <div className="text-xs text-ink-400">{data?.messages.length ?? 0} messages · {data?.attachments.length ?? 0} photos</div>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-ink-400 hover:bg-ink-800 hover:text-ink-100">
            <X className="size-4" />
          </button>
        </div>

        {loading && <Spinner />}
        {error && <ErrorBox error={error} />}

        {data?.attachments.length ? (
          <div className="mb-6 flex flex-wrap gap-3">
            {data.attachments.map(a => {
              let c: { name?: string; phone?: string; source?: string } = {}
              try { c = a.contact_data ? JSON.parse(a.contact_data) : {} } catch { /* keep {} */ }
              return (
                <a key={a.id} href={imgUrl(a.image_url)} target="_blank" rel="noreferrer"
                   className="group w-40 rounded-xl border border-ink-700 bg-ink-850 p-2 transition hover:border-brand-500/40">
                  <img src={imgUrl(a.thumbnail_url)} alt=""
                       className="h-24 w-full rounded-lg object-cover"
                       onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />
                  <div className="mt-2 truncate text-[11px] text-ink-300">{a.business_name ?? `photo ${a.id}`}</div>
                  {c.phone && (
                    <div className="mt-1 font-mono text-[10px] text-emerald-300">{c.name} · {c.phone}</div>
                  )}
                </a>
              )
            })}
          </div>
        ) : null}

        <div className="space-y-3">
          {data?.messages.map(m => (
            <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                m.role === 'user'
                  ? 'bg-brand-600/85 text-white'
                  : 'border border-ink-700 bg-ink-850 text-ink-100'}`}>
                <div className="whitespace-pre-wrap break-words">{m.content}</div>
                <div className={`mt-1 font-mono text-[10px] ${m.role === 'user' ? 'text-white/50' : 'text-ink-600'}`}>
                  #{m.id}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── WhatsApp directory ──────────────────────────────────────────────────────

export function Whatsapp() {
  const { data, error, loading, reload } = useApi<{
    count: number; rows: WaRow[]; by_label: Record<string, number>
  }>('/admin/whatsapp-contacts?limit=500')

  return (
    <div className="space-y-4">
      {loading && <Spinner />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && (
        <>
          {/* Labels matter more than they look: _labels_match matches on substring
              AND per-token prefix in both directions, so two labels sharing a
              leading word make one "send to X" reach both groups — unrecallably. */}
          <Card className="p-5 rise">
            <div className="text-[11px] font-medium uppercase tracking-[.14em] text-ink-400">
              Labels — what a broadcast reaches
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {Object.entries(data.by_label).map(([l, n]) => (
                <Badge key={l}>{l} · {n}</Badge>
              ))}
            </div>
            {Object.keys(data.by_label).filter(l => l !== '(none)').length > 1 && (
              <div className="mt-3 text-xs text-amber-300/90">
                More than one label in use — check none share a leading word, or a single
                send can reach both groups.
              </div>
            )}
          </Card>

          <Card className="overflow-hidden rise">
            <Table head={['#', 'Name', 'Phone', 'Label', 'Team', 'Owner']}>
              {data.rows.map(r => (
                <tr key={r.id} className="hover:bg-ink-800/40 transition">
                  <Td className="font-mono text-xs text-ink-400">{r.id}</Td>
                  <Td className="text-sm">{r.display_name}</Td>
                  <Td className="font-mono text-xs">{r.phone_number}</Td>
                  <Td>{r.label ? <Badge>{r.label}</Badge> : <Empty />}</Td>
                  <Td className="text-xs text-ink-300">{r.team_name ?? <Empty />}</Td>
                  <Td className="text-xs text-ink-400">{r.owner_name ?? `#${r.owner_user_id}`}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </div>
  )
}

// ── MCP config ──────────────────────────────────────────────────────────────

export function Mcp() {
  const [all, setAll] = useState(false)
  const { data, error, loading, reload } = useApi<{
    rows: McpRow[]; mcp_as_tool_team_ids: string | null; whatsapp_allowed_team_ids: string
  }>('/admin/mcp-config')

  const rows = data ? (all ? data.rows : data.rows.filter(r => r.source !== 'none' || r.tool_mode)) : []

  return (
    <div className="space-y-4">
      {loading && <Spinner />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="p-5 rise">
              <div className="text-[11px] font-medium uppercase tracking-[.14em] text-ink-400">
                MCP_AS_TOOL_TEAM_IDS
              </div>
              <div className="mt-2 font-mono text-lg">
                {data.mcp_as_tool_team_ids ?? <span className="text-ink-600">unset — routing mode</span>}
              </div>
              <div className="mt-1 text-xs text-ink-400">
                Listed teams get the MCP as a tool alongside all of Oscar's own tools.
                Unset means the MCP replaces Oscar for that turn.
              </div>
            </Card>
            <Card className="p-5 rise">
              <div className="text-[11px] font-medium uppercase tracking-[.14em] text-ink-400">
                WHATSAPP_ALLOWED_TEAM_IDS
              </div>
              <div className="mt-2 font-mono text-lg">{data.whatsapp_allowed_team_ids}</div>
              <div className="mt-1 text-xs text-ink-400">
                Only these teams may dispatch a poster. Everyone else is refused at the tool.
              </div>
            </Card>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-xs text-ink-400">
              {rows.length} of {data.rows.length} teams
            </div>
            <button onClick={() => setAll(a => !a)}
              className="rounded-lg border border-ink-600 bg-ink-800 px-3 py-1.5 text-xs
                         font-medium hover:bg-ink-700 transition">
              {all ? 'Only configured' : 'Show all teams'}
            </button>
          </div>

          <Card className="overflow-hidden rise">
            <Table head={['Team', 'Members', 'Source', 'Resolved', 'Tool mode', 'Config']}>
              {rows.map(r => (
                <tr key={r.id} className="hover:bg-ink-800/40 transition">
                  <Td><div className="text-sm">{r.name}</div>
                      <div className="font-mono text-[11px] text-ink-400">#{r.id}</div></Td>
                  <Td className="tabular-nums text-sm">{r.members}</Td>
                  <Td><Badge tone={r.source}>{r.source}</Badge></Td>
                  {/* `resolved` is the authoritative answer — what servers_for_team
                      actually returns, not what a config file implies. */}
                  <Td>{r.resolved.length
                    ? <span className="font-mono text-xs text-emerald-300">{r.resolved.join(', ')}</span>
                    : <Empty />}</Td>
                  <Td>{r.tool_mode ? <Badge tone="on">on</Badge> : <span className="text-ink-600 text-xs">off</span>}</Td>
                  <Td>
                    {r.db_rows.map(d => (
                      <div key={d.name} className="max-w-72 truncate font-mono text-[11px] text-ink-400">
                        {d.name} → {d.url}{!d.is_active && ' (inactive)'}
                      </div>
                    ))}
                    {r.env_value && (
                      <div className="max-w-72 truncate font-mono text-[11px] text-amber-300/80">
                        env: {r.env_value}
                      </div>
                    )}
                    {!r.db_rows.length && !r.env_value && <Empty />}
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </div>
  )
}
