import { useEffect, useState } from 'react'
import {
  Camera, KeyRound, LayoutDashboard, LogOut, MessagesSquare, Mic, Phone, RefreshCw, Server, Users, Zap,
} from 'lucide-react'
import { DEFAULT_BASE, clearCreds, getBase, getSecret, setCreds } from './lib/api'
import { Card, Field, cx, inputCls } from './ui'
import { Mcp, Overview, Photos, Sessions, Whatsapp } from './views'
import { People } from './people'
import { Voice } from './voice'
import { Realtime } from './realtime'

// `writes` drives the per-page subtitle. Most of this panel reads; People can send a
// real push and edit an org profile, and a page that can touch a customer's phone
// should say so rather than inherit a blanket "nothing here writes".
const NAV = [
  { id: 'overview', label: 'Overview',  icon: LayoutDashboard, view: Overview, writes: false },
  { id: 'people',   label: 'People',    icon: Users,           view: People,   writes: true  },
  { id: 'photos',   label: 'Photos & contacts', icon: Camera,  view: Photos,   writes: false },
  { id: 'sessions', label: 'Sessions',  icon: MessagesSquare,  view: Sessions, writes: false },
  { id: 'whatsapp', label: 'WhatsApp',  icon: Phone,           view: Whatsapp, writes: false },
  { id: 'mcp',      label: 'MCP config', icon: Server,         view: Mcp,      writes: false },
  // writes: true — the voice bench posts to the live POST /chat, which lands in a
  // real person's history and pushes to their phone.
  { id: 'voice',    label: 'Voice (Sarvam)', icon: Mic,        view: Voice,    writes: true  },
  // The comparison: one speech-to-speech model instead of STT+LLM+TTS. No tools,
  // so it writes nothing.
  { id: 'realtime', label: 'Voice (OpenAI Realtime)', icon: Zap, view: Realtime, writes: false },
] as const

export default function App() {
  // The secret is the gate. It lives in localStorage rather than memory so a reload
  // doesn't log you out mid-investigation — acceptable because this panel is only
  // ever opened on a machine that already has the backend's admin secret.
  const [authed, setAuthed] = useState(!!getSecret())
  const [tab, setTab] = useState<string>('overview')
  const [nonce, setNonce] = useState(0)

  if (!authed) return <Login onDone={() => setAuthed(true)} />

  const active = NAV.find(n => n.id === tab) ?? NAV[0]
  const View = active.view

  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-ink-700/60
                        bg-ink-900/50 px-3 py-5 backdrop-blur">
        <div className="mb-7 flex items-center gap-2.5 px-2">
          <div className="grid size-8 place-items-center rounded-xl bg-gradient-to-br
                          from-brand-400 to-brand-600 text-sm font-bold text-white">O</div>
          <div>
            <div className="text-sm font-semibold leading-tight">Oscar Admin</div>
            <div className="text-[10px] text-ink-400">operations</div>
          </div>
        </div>

        <nav className="space-y-1">
          {NAV.map(n => (
            <button key={n.id} onClick={() => setTab(n.id)}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition',
                tab === n.id
                  ? 'bg-brand-500/12 text-brand-400 ring-1 ring-brand-500/20'
                  : 'text-ink-300 hover:bg-ink-800/60 hover:text-ink-100',
              )}>
              <n.icon className="size-4" /> {n.label}
            </button>
          ))}
        </nav>

        <div className="mt-auto space-y-2 px-2 pt-5">
          <div className="truncate font-mono text-[10px] text-ink-600" title={getBase()}>
            {getBase().replace(/^https?:\/\//, '')}
          </div>
          <button onClick={() => { clearCreds(); setAuthed(false) }}
            className="flex items-center gap-2 text-xs text-ink-400 transition hover:text-rose-300">
            <LogOut className="size-3.5" /> Sign out
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-8 py-7">
        <header className="mb-7 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{active.label}</h1>
            <p className="mt-0.5 text-xs text-ink-400">
              {active.writes
                ? 'Live data from the Oscar backend. This page can send a real push and edit an org profile.'
                : 'Live data from the Oscar backend. Nothing on this page writes.'}
            </p>
          </div>
          <button onClick={() => setNonce(n => n + 1)}
            className="flex items-center gap-2 rounded-xl border border-ink-600 bg-ink-800
                       px-3 py-2 text-xs font-medium transition hover:bg-ink-700">
            <RefreshCw className="size-3.5" /> Refresh
          </button>
        </header>
        {/* Remounting on refresh is the honest way to re-fetch every view without
            each one having to expose a reload handle. */}
        <div key={`${tab}-${nonce}`}><View /></div>
      </main>
    </div>
  )
}

// Optional convenience: .env.local (gitignored via *.local) can supply the secret so
// the login screen is pre-filled. Deliberately NOT auto-submitted — the screen still
// verifies against /admin/overview, which is what turns a stale secret into one clear
// message instead of five identical 401s across five views.
const ENV_ADMIN_SECRET = import.meta.env.VITE_ADMIN_SECRET as string | undefined

function Login({ onDone }: { onDone: () => void }) {
  const [base, setBase] = useState(getBase() || DEFAULT_BASE)
  const [secret, setSecret] = useState(ENV_ADMIN_SECRET || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { document.title = 'Oscar Admin' }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setErr(null)
    setCreds(base, secret)
    // Verify BEFORE letting anyone in, so a wrong secret fails here with one clear
    // message instead of five identical 401s across five views.
    try {
      const r = await fetch(base.replace(/\/+$/, '') + '/admin/overview',
        { headers: { 'X-Admin-Secret': secret } })
      if (r.status === 401) throw new Error('Secret rejected by the server.')
      if (!r.ok) throw new Error(`Server returned ${r.status}. Is ADMIN_SECRET set?`)
      onDone()
    } catch (e) {
      clearCreds()
      setErr(e instanceof TypeError
        ? `Cannot reach ${base}. Check the URL, and that ${location.origin} is in CORS_ORIGINS.`
        : (e as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <div className="grid min-h-full place-items-center px-4">
      <Card className="w-full max-w-sm p-7 rise">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-2xl bg-gradient-to-br
                          from-brand-400 to-brand-600 text-base font-bold text-white">O</div>
          <div>
            <div className="font-semibold leading-tight">Oscar Admin</div>
            <div className="text-xs text-ink-400">Read-only operations panel</div>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <Field label="Backend URL">
            <input value={base} onChange={e => setBase(e.target.value)} className={inputCls}
                   placeholder="https://…onrender.com" spellCheck={false} />
          </Field>
          <Field label="Admin secret">
            <div className="relative">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-600" />
              <input value={secret} onChange={e => setSecret(e.target.value)} type="password"
                     className={inputCls + ' pl-8'} placeholder="ADMIN_SECRET" autoFocus />
            </div>
          </Field>

          {err && (
            <div className="rounded-xl border border-rose-500/25 bg-rose-500/[.06] px-3 py-2.5
                            text-xs leading-relaxed text-rose-200">{err}</div>
          )}

          <button type="submit" disabled={busy || !secret}
            className="w-full rounded-xl bg-brand-500 py-2.5 text-sm font-semibold text-white
                       transition hover:bg-brand-600 disabled:opacity-40">
            {busy ? 'Checking…' : 'Open panel'}
          </button>
        </form>

        <p className="mt-5 text-[11px] leading-relaxed text-ink-400">
          The secret is sent as <span className="font-mono">X-Admin-Secret</span> and kept in this
          browser only. If <span className="font-mono">ADMIN_SECRET</span> is unset on the server,
          every admin route is disabled by design.
        </p>
      </Card>
    </div>
  )
}
