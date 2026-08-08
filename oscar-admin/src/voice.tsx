import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Phone, PhoneOff } from 'lucide-react'
import { LiveVoice, type Phase, type Timings } from './lib/liveVoice'
import { Card, ErrorBox, Field, cx, inputCls } from './ui'

/**
 * Live Voice — SPIKE. Hold a conversation; no button between turns.
 *
 * This is the proof-of-work UI, not a product surface. It exists to answer one
 * question by feel as well as by number: is
 *   mic → Sarvam streaming STT → LLM → Sarvam streaming TTS → speaker
 * fast enough to pass for ChatGPT Live Voice.
 *
 * Every leg is timed from the instant the SPEAKER STOPPED TALKING, because that is
 * the only moment a user is actually waiting from. The three numbers are on screen
 * during the call rather than in a log — a latency you can watch while talking tells
 * you more than a table afterwards.
 *
 * The LLM leg is the LOCAL spike server (127.0.0.1:8099), which uses this repo's
 * stack but is NOT production /chat: nothing is persisted, no push is sent, no
 * chat history is touched.
 */

const PHASE_COPY: Record<Phase, string> = {
  idle: 'Tap to start talking',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
}

export function Voice() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [level, setLevel] = useState(0)
  const [partial, setPartial] = useState('')
  const [heard, setHeard] = useState('')
  const [reply, setReply] = useState('')
  const [t, setT] = useState<Timings>({})
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<Timings[]>([])
  // 7 by default — the account this spike is exercised with.
  const [userId, setUserId] = useState('7')

  const engine = useRef<LiveVoice | null>(null)

  useEffect(() => () => engine.current?.stop(), [])

  const toggle = useCallback(async () => {
    if (engine.current?.isRunning) {
      engine.current.stop()
      engine.current = null
      return
    }
    setError(null); setPartial(''); setHeard(''); setReply(''); setT({})
    const lv = new LiveVoice({
      onPhase: p => {
        setPhase(p)
        if (p === 'listening') setPartial('')
      },
      onLevel: setLevel,
      onPartial: setPartial,
      onFinal: txt => { setHeard(txt); setPartial(''); setReply('') },
      onReplyToken: setReply,
      onTimings: nt => {
        setT(nt)
        // Keep the completed turn once the audio number lands.
        if (nt.audioMs !== undefined) setLog(l => [nt, ...l].slice(0, 6))
      },
      onError: setError,
    }, Number(userId) || 7)
    engine.current = lv
    await lv.start()
  }, [userId])

  const live = phase !== 'idle'
  // The orb breathes with mic level while listening and pulses on its own otherwise,
  // so the page never looks frozen during the LLM wait.
  const scale = phase === 'listening' ? 1 + Math.min(level * 6, 0.45) : 1

  return (
    <div className="space-y-6">
      <Card className="p-8 rise">
        <div className="flex flex-col items-center gap-6">
          <div className="flex items-end gap-4">
            <Field label="Ask as user id">
              <input
                className={inputCls} value={userId} inputMode="numeric" disabled={live}
                onChange={e => setUserId(e.target.value.replace(/\D/g, ''))}
              />
            </Field>
          </div>
          <button
            onClick={toggle}
            aria-label={live ? 'End call' : 'Start call'}
            className="relative grid size-48 place-items-center rounded-full outline-none"
          >
            {/* Halo — a second ring that only animates while the mic is open. */}
            <span
              className={cx(
                'absolute inset-0 rounded-full transition-opacity duration-500',
                phase === 'listening' && 'animate-ping bg-brand-500/20',
                phase === 'thinking' && 'animate-pulse bg-amber-500/20',
                phase === 'speaking' && 'animate-pulse bg-emerald-500/20',
                phase === 'idle' && 'opacity-0',
              )}
            />
            <span
              style={{ transform: `scale(${scale})` }}
              className={cx(
                'grid size-40 place-items-center rounded-full transition-[transform,background-color] duration-100',
                phase === 'idle' && 'bg-white/5 hover:bg-white/10',
                phase === 'listening' && 'bg-brand-500/30',
                phase === 'thinking' && 'bg-amber-500/25',
                phase === 'speaking' && 'bg-emerald-500/30',
              )}
            >
              {live
                ? <PhoneOff className="size-10 text-white/80" />
                : <Phone className="size-10 text-white/60" />}
            </span>
          </button>

          <div className="text-center">
            <div className="text-sm font-semibold">{PHASE_COPY[phase]}</div>
            <div className="mt-1 h-5 text-sm text-ink-600">
              {partial || (phase === 'idle' ? `Local backend · POST /chat as user ${userId}` : '')}
            </div>
          </div>

          {/* Live latency, measured from the moment you stopped talking. */}
          <div className="grid w-full max-w-md grid-cols-3 gap-3 text-center">
            {([
              ['Transcript', t.sttMs, 'brand'],
              ['First token', t.llmMs, 'amber'],
              ['First word', t.audioMs, 'emerald'],
            ] as const).map(([label, ms, tone]) => (
              <div key={label} className="rounded-xl bg-white/5 px-3 py-3">
                <div className="text-[11px] uppercase tracking-wide text-ink-600">{label}</div>
                <div className={cx(
                  'mt-1 text-lg font-semibold tabular-nums',
                  ms === undefined && 'text-ink-600',
                  ms !== undefined && tone === 'brand' && 'text-brand-400',
                  ms !== undefined && tone === 'amber' && 'text-amber-400',
                  ms !== undefined && tone === 'emerald' && 'text-emerald-400',
                )}>
                  {ms === undefined ? '—' : `${(ms / 1000).toFixed(2)}s`}
                </div>
              </div>
            ))}
          </div>
          <p className="text-center text-xs text-ink-600">
            Measured from the moment you stopped speaking — the only instant you are
            actually waiting from.
          </p>
        </div>
      </Card>

      {error && <ErrorBox error={error} />}

      {(heard || reply) && (
        <Card className="space-y-4 p-6">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-600">You</div>
            <p className="text-sm">{heard || <span className="text-ink-600">—</span>}</p>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-600">Oscar</div>
            <p className="text-sm">{reply || <span className="text-ink-600">—</span>}</p>
          </div>
        </Card>
      )}

      {log.length > 0 && (
        <Card className="p-6">
          <div className="text-sm font-semibold">Turns this call</div>
          <div className="mt-4 space-y-2 text-sm tabular-nums">
            {log.map((r, i) => (
              <div key={i} className="flex items-baseline justify-between gap-3">
                <span className="text-ink-600">
                  STT {r.sttMs}ms · LLM {r.llmMs}ms · TTS {(r.audioMs ?? 0) - (r.llmMs ?? 0)}ms
                </span>
                <span className="font-semibold">{((r.audioMs ?? 0) / 1000).toFixed(2)}s</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <p className="flex items-start gap-2 text-xs text-ink-600">
        <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-500" />
        Spike. Speech goes browser → Sarvam directly. The reply comes from the LOCAL
        backend's real <code>POST /chat</code> — the full Oscar agent — so it DOES write
        to that user's chat history and push to their device. Because /chat returns one
        body rather than tokens, &quot;first token&quot; is when the whole answer lands.
      </p>
    </div>
  )
}
