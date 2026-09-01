import { useState } from 'react'
import { ChevronRight, X } from 'lucide-react'
import { useApi } from './useApi'
import { imgUrl } from './lib/api'
import type { McpRow, Overview as O, SessionRow, TranscriptAtt, TranscriptMsg } from './lib/api'
import { Badge, Card, Empty, ErrorBox, Spinner, Stat, Table, Td } from './ui'

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
        <Stat label="Active sessions" value={data.active_sessions} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Tasks" value={data.tasks} tone="brand" />
        <Stat label="Meetings" value={data.meetings} />
      </div>
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
