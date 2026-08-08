import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Phone, PhoneOff, Zap } from 'lucide-react'
import { RealtimeVoice, type RtPhase } from './lib/realtime'
import { Card, ErrorBox, cx } from './ui'

/**
 * OpenAI Realtime — the comparison tab. SPIKE.
 *
 * Same orb, same latency anchor (the moment you stopped speaking) as the Sarvam
 * tab, so the two numbers can be read side by side and actually mean something.
 *
 * What to listen for, beyond the number:
 *   • it starts answering before you have finished the sentence
 *   • you can TALK OVER IT and it stops — the Sarvam pipeline cannot do this at any
 *     latency, and it is most of what "live voice" means
 *   • Telugu and code-mixed speech are noticeably weaker than Sarvam's
 */

const COPY: Record<RtPhase, string> = {
  idle: 'Tap to start talking',
  connecting: 'Connecting…',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking… (try talking over it)',
}

const INSTRUCTIONS =
  'You are Oscar, a concise work assistant: tasks, reminders, meetings, planning the ' +
  'day. Always reply in English. Speak naturally and briefly — one or two sentences.'

export function Realtime() {
  const [phase, setPhase] = useState<RtPhase>('idle')
  const [heard, setHeard] = useState('')
  const [reply, setReply] = useState('')
  const [ms, setMs] = useState<number | null>(null)
  const [log, setLog] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const engine = useRef<RealtimeVoice | null>(null)

  useEffect(() => () => engine.current?.stop(), [])

  const toggle = useCallback(async () => {
    if (engine.current?.isRunning) {
      engine.current.stop()
      engine.current = null
      return
    }
    setError(null); setHeard(''); setReply(''); setMs(null); setLines([])
    const rt = new RealtimeVoice({
      onPhase: setPhase,
      onUserText: setHeard,
      onReplyText: setReply,
      onLatency: v => { setMs(v); setLog(l => [v, ...l].slice(0, 8)) },
      onError: setError,
      onLog: l => setLines(v => [...v, `${new Date().toLocaleTimeString()}  ${l}`].slice(-60)),
    })
    engine.current = rt
    await rt.start(INSTRUCTIONS)
  }, [])

  const live = phase !== 'idle'
  const mean = log.length ? Math.round(log.reduce((a, b) => a + b, 0) / log.length) : null

  return (
    <div className="space-y-6">
      <Card className="p-8 rise">
        <div className="flex flex-col items-center gap-6">
          <button
            onClick={toggle}
            aria-label={live ? 'End call' : 'Start call'}
            className="relative grid size-48 place-items-center rounded-full outline-none"
          >
            <span className={cx(
              'absolute inset-0 rounded-full transition-opacity duration-500',
              phase === 'listening' && 'animate-ping bg-emerald-500/20',
              phase === 'thinking' && 'animate-pulse bg-amber-500/20',
              phase === 'speaking' && 'animate-pulse bg-sky-500/20',
              (phase === 'idle' || phase === 'connecting') && 'opacity-0',
            )} />
            <span className={cx(
              'grid size-40 place-items-center rounded-full transition-colors',
              phase === 'idle' && 'bg-white/5 hover:bg-white/10',
              phase === 'connecting' && 'bg-white/10',
              phase === 'listening' && 'bg-emerald-500/30',
              phase === 'thinking' && 'bg-amber-500/25',
              phase === 'speaking' && 'bg-sky-500/30',
            )}>
              {live ? <PhoneOff className="size-10 text-white/80" />
                    : <Phone className="size-10 text-white/60" />}
            </span>
          </button>

          <div className="text-center">
            <div className="text-sm font-semibold">{COPY[phase]}</div>
            <div className="mt-1 h-5 text-sm text-ink-600">
              {phase === 'idle' ? 'Speech-to-speech · no transcript step · barge-in' : ''}
            </div>
          </div>

          <div className="grid w-full max-w-md grid-cols-2 gap-3 text-center">
            <div className="rounded-xl bg-white/5 px-3 py-3">
              <div className="text-[11px] uppercase tracking-wide text-ink-600">First word</div>
              <div className={cx('mt-1 text-lg font-semibold tabular-nums',
                ms === null ? 'text-ink-600' : 'text-sky-400')}>
                {ms === null ? '—' : `${(ms / 1000).toFixed(2)}s`}
              </div>
            </div>
            <div className="rounded-xl bg-white/5 px-3 py-3">
              <div className="text-[11px] uppercase tracking-wide text-ink-600">Mean this call</div>
              <div className={cx('mt-1 text-lg font-semibold tabular-nums',
                mean === null ? 'text-ink-600' : 'text-sky-400')}>
                {mean === null ? '—' : `${(mean / 1000).toFixed(2)}s`}
              </div>
            </div>
          </div>
          <p className="text-center text-xs text-ink-600">
            Measured from the moment you stopped speaking — the same anchor as the
            Sarvam tab, so the two are comparable.
          </p>
        </div>
      </Card>

      {error && <ErrorBox error={error} />}

      {(heard || reply) && (
        <Card className="space-y-4 p-6">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-600">
              You <span className="normal-case text-ink-600">— arrives after the answer; it never waited for this</span>
            </div>
            <p className="text-sm">{heard || <span className="text-ink-600">—</span>}</p>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-600">Oscar</div>
            <p className="text-sm">{reply || <span className="text-ink-600">—</span>}</p>
          </div>
        </Card>
      )}

      {log.length > 1 && (
        <Card className="p-6">
          <div className="text-sm font-semibold">Turns this call</div>
          <div className="mt-3 flex flex-wrap gap-2 text-sm tabular-nums">
            {log.map((v, i) => (
              <span key={i} className="rounded-lg bg-white/5 px-2.5 py-1">{(v / 1000).toFixed(2)}s</span>
            ))}
          </div>
        </Card>
      )}

      {lines.length > 0 && (
        <Card className="p-6">
          <div className="text-sm font-semibold">Event log</div>
          <p className="mt-1 text-xs text-ink-600">
            This tab talks browser → OpenAI directly, so none of it reaches the server
            log. Every step and event is here instead.
          </p>
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-black/40 p-3 text-[11px] leading-relaxed text-ink-300">
{lines.join('\n')}
          </pre>
        </Card>
      )}

      <p className="flex items-start gap-2 text-xs text-ink-600">
        <Zap className="mt-px size-3.5 shrink-0 text-sky-400" />
        No tools here — this tab cannot create tasks or read your calendar. Realtime
        supports function calling, but the tools would have to be re-declared for the
        session rather than reused from make_tools. This is a latency and feel test.
      </p>
      <p className="flex items-start gap-2 text-xs text-ink-600">
        <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-500" />
        Audio goes browser → OpenAI directly, using a short-lived token minted by the
        backend. The API key never reaches this page.
      </p>
    </div>
  )
}
