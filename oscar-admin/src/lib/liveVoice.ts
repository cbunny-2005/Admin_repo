/**
 * Live voice engine — hold a conversation, no buttons between turns.
 *
 *   mic ─100ms PCM16─▶ Sarvam STT (WS) ─final─▶ LLM (SSE) ─sentence─▶ Sarvam TTS (WS) ─▶ speaker
 *
 * SPIKE. Proves the pipeline is fast enough to feel live; not production code.
 *
 * Three things here are load-bearing and were each found the hard way:
 *
 * 1. **100 ms frames, never 20 ms.** Streaming 20 ms frames — which is what a mic
 *    naturally produces — returns `"Rem, Rem, Rem"` for a clean English sentence.
 *    The socket accepts them and reports no error, so it looks like a bad model
 *    rather than a framing bug. 100 ms transcribes perfectly.
 *
 * 2. **Auth by SUBPROTOCOL, not header.** A browser cannot set headers on a
 *    WebSocket. Sarvam accepts `api-subscription-key.<key>` as a subprotocol and
 *    echoes it back, which is the only way this works client-side at all.
 *
 * 3. **Speak sentence one while the model is still writing.** Waiting for the full
 *    reply before starting TTS adds ~400 ms of dead air to every turn and is the
 *    difference between "it thinks, then talks" and "it starts talking".
 */

const KEY = import.meta.env.VITE_SARVAM_KEY as string | undefined

/** The REAL backend. `/chat/stream` is used, not `/chat`: it streams the agent's
 *  tokens over the WebSocket the client already holds, so the first sentence can be
 *  spoken while the model is still writing the rest. `/chat` returns one complete
 *  body, which forces a full wait before any sound — the thing this spike exists to
 *  avoid. Same agent either way; only the delivery differs. */
const BASE = (import.meta.env.VITE_BACKEND_URL as string | undefined)
  ?? 'http://127.0.0.1:8000'
const DEFAULT_USER_ID = Number(import.meta.env.VITE_CHAT_USER_ID ?? 90)
/** bulbul:v3 voice. Sarvam ships 44; these are the ones worth trying first for an
 *  English-India assistant. `dev` is the default. */
export const SPEAKERS = [
  'dev', 'shubh', 'karun', 'hitesh', 'abhilash', 'rahul', 'amit', 'varun',
  'anushka', 'manisha', 'vidya', 'arya', 'priya', 'neha', 'kavya', 'shreya',
]
const DEFAULT_SPEAKER = (import.meta.env.VITE_SARVAM_SPEAKER as string) ?? 'dev'

const STT_WS = 'wss://api.sarvam.ai/speech-to-text-realtime/ws'
const TTS_WS = 'wss://api.sarvam.ai/text-to-speech/ws'

const FRAME_MS = 100
const TARGET_SR = 16000
/** How much silence ends your turn.
 *
 *  🔴 NOT tuned for latency, and 400 was a mistake. 400 ms is the floor a CLIP can
 *  survive, but a person pausing to think mid-sentence is silent for longer than
 *  that — so "assign task to Sriram … regarding … the TTS event" arrived as three
 *  separate questions and Oscar answered each with "could you clarify?". The
 *  transcript in the logs is a conversation cut into confetti.
 *
 *  800 ms costs 400 ms of latency and buys back whole sentences. Coherence beats
 *  speed: a fast answer to half a sentence is not an answer. */
const SILENCE_MS = Number(import.meta.env.VITE_VAD_SILENCE_MS ?? 800)
/** The first point in a growing reply worth speaking.
 *
 *  The obvious /[.!?]\s/ is WRONG and cost the whole benefit of streaming: it needs
 *  whitespace AFTER the punctuation, so a one-sentence reply — "Understood!", "Got
 *  it! What next?" — never matched and nothing was spoken until the model finished.
 *  Most replies are one sentence, so streaming was effectively off.
 *
 *  Now: end of a sentence anywhere (trailing punctuation counts), or a clause break
 *  once there is enough to be worth saying. MIN_SPEAK_CHARS stops us shipping "I"
 *  or "Done," as a standalone utterance, which sounds worse than waiting. */
const MIN_SPEAK_CHARS = 24
function firstChunkEnd(s: string): number {
  const sentence = /[.!?](\s|$)/.exec(s)
  if (sentence && sentence.index + 1 >= MIN_SPEAK_CHARS) return sentence.index + 1
  if (s.length >= MIN_SPEAK_CHARS) {
    const clause = /[,;:—]\s/.exec(s.slice(MIN_SPEAK_CHARS))
    if (clause) return MIN_SPEAK_CHARS + clause.index + 1
  }
  return -1
}

/** How long the TTS socket must be quiet before we treat the reply as fully
 *  synthesised. Chunks arrive ~32 ms apart, so 250 ms is comfortably past the gap
 *  without adding noticeable delay before playback starts. */
const IDLE_MS = 250

export type Phase = 'idle' | 'listening' | 'thinking' | 'speaking'

export type Timings = {
  sttMs?: number       // speech end → final transcript
  llmMs?: number       // speech end → first token
  audioMs?: number     // speech end → first spoken word
}

export type Handlers = {
  onPhase: (p: Phase) => void
  onLevel: (rms: number) => void          // drives the orb
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onReplyToken: (full: string) => void
  onTimings: (t: Timings) => void
  onError: (msg: string) => void
}

/** Downsample browser audio (usually 48 kHz float) to 16 kHz PCM16.
 *  Averaged rather than decimated — plain decimation aliases and measurably hurts
 *  transcription on sibilants. */
function toPcm16(input: Float32Array, fromRate: number): Int16Array {
  const ratio = fromRate / TARGET_SR
  const outLen = Math.floor(input.length / ratio)
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]
    const v = sum / Math.max(1, end - start)
    out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff
  }
  return out
}

function b64(bytes: Int16Array): string {
  const u8 = new Uint8Array(bytes.buffer)
  let s = ''
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
  return btoa(s)
}

export class LiveVoice {
  private h: Handlers
  private userId: number
  private speaker: string
  private stt?: WebSocket
  private tts?: WebSocket
  private appWs?: WebSocket
  private ctx?: AudioContext
  private stream?: MediaStream
  private node?: ScriptProcessorNode
  private pending: number[] = []
  private running = false

  /** This call's own conversation. Without it every turn lands in the AMBIENT
   *  history bucket (session_id = null), which `_history_messages` shows to EVERY
   *  conversation — so a photo sent from the phone a minute earlier leaked into a
   *  spoken "Hey hi" and Oscar answered "Got the image — what would you like me to
   *  do with it?". Opening a session scopes this call to itself. */
  private sessionId?: number

  /** A turn is in flight. Sending another while one is running is what broke the
   *  conversation: history is only written when a turn COMPLETES (agent.py pushes
   *  at the end), so a second turn starting 0.6 s later reads an empty history and
   *  has no idea what was just asked. That is why "assign a task to Sriram" →
   *  "what time?" → "11 AM today" → "clarify what you'd like to schedule at 11 AM".
   *  Overlapping turns also race on the server's per-user turn context. */
  private busy = false
  /** Speech that arrived while busy — merged into ONE message rather than dropped,
   *  because the fragments are usually halves of the same sentence. */
  private queued: string[] = []

  private speechEndAt = 0
  private t: Timings = {}
  private reply = ''
  private spokenFirst = false

  // Playback via MediaSource — chunks are appended and PLAY IMMEDIATELY.
  //
  // The first version concatenated every chunk into one blob and played it after
  // the socket went quiet. That is correct and feels broken: it converts a stream
  // into a batch, so nothing is heard until the ENTIRE sentence has synthesised —
  // roughly a second of silence while the text was already on screen. "Text fast,
  // voice slow" is exactly what that looks like.
  //
  // MSE appends each MP3 chunk to a live buffer, so audio starts on chunk ONE
  // (~200 ms) and the rest arrives while it is already speaking. Falls back to the
  // blob path where MSE cannot take audio/mpeg (Safari), because slow audio still
  // beats no audio.
  private media?: MediaSource
  private sb?: SourceBuffer
  private appendQ: Uint8Array[] = []
  private mseReady = false
  private audioChunks: Uint8Array[] = []   // fallback path only
  private idleTimer: number | undefined
  private audioEl = new Audio()
  private audioWired = false
  private useMse = typeof MediaSource !== 'undefined'
    && MediaSource.isTypeSupported('audio/mpeg')

  constructor(h: Handlers, userId: number = DEFAULT_USER_ID,
              speaker: string = DEFAULT_SPEAKER) {
    this.h = h
    this.userId = userId
    this.speaker = speaker
  }

  get isRunning() { return this.running }

  async start() {
    if (!KEY) { this.h.onError('VITE_SARVAM_KEY is not set'); return }
    if (this.running) return
    this.running = true
    try {
      await this.openTts()
      await this.openApp()
      await this.openSession()
      await this.openStt()
      await this.openMic()
      this.h.onPhase('listening')
    } catch (e) {
      this.running = false
      this.h.onError((e as Error).message)
      this.stop()
    }
  }

  stop() {
    this.running = false
    this.busy = false
    this.queued = []
    try { this.node?.disconnect() } catch { /* already gone */ }
    try { this.stream?.getTracks().forEach(t => t.stop()) } catch { /* ditto */ }
    try { this.ctx?.close() } catch { /* ditto */ }
    try { this.stt?.close() } catch { /* ditto */ }
    try { this.appWs?.close() } catch { /* ditto */ }
    try { this.tts?.close() } catch { /* ditto */ }
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.audioEl.pause()
    this.resetAudio()
    this.h.onLevel(0)
    this.h.onPhase('idle')
  }

  // ── Sockets ───────────────────────────────────────────────────────────────

  private sub(): string[] {
    // The subprotocol IS the credential — see the header note at the top.
    return [`api-subscription-key.${KEY}`]
  }

  /** The app's own socket. /chat/stream refuses to generate at all unless this user
   *  has one open — the backend short-circuits rather than bill a reply nobody can
   *  see — so it must be connected BEFORE the first question is asked. */
  private openApp(): Promise<void> {
    const url = BASE.replace(/^http/, 'ws') + `/ws?user_id=${this.userId}`
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      this.appWs = ws
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error(`app socket failed: ${url}`))
      ws.onmessage = e => {
        // The server pings every 30 s and closes with 4002 if we never pong.
        try {
          const f = JSON.parse(e.data)
          if (f.type === 'connection.ping') {
            ws.send(JSON.stringify({ type: 'connection.pong' }))
            return
          }
        } catch { /* non-JSON frames are ignored by contract */ }
        this.onAppFrame(e)
      }
    })
  }

  /** Best-effort: if the backend predates sessions, carry on without one rather
   *  than refuse to start a call. */
  private async openSession() {
    try {
      const r = await fetch(`${BASE}/chat/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: this.userId, title: 'Live voice (spike)' }),
      })
      if (r.ok) this.sessionId = (await r.json()).session_id
    } catch { /* no session — turns fall back to ambient, as before */ }
  }

  private openStt(): Promise<void> {
    // UNDERSCORES, not hyphens. The hyphenated form connects and is then closed
    // with 4000 "Missing required query parameter 'language_code'" — a failure that
    // looks like an auth problem and is not.
    const qs = new URLSearchParams({
      language_code: 'en-IN',
      model: 'saaras:v3-realtime',
      stream_type: 'fast',
      encoding: 'linear16',
      sample_rate: String(TARGET_SR),
      endpointing: 'vad',
      silence_duration_ms: String(SILENCE_MS),
    })
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${STT_WS}?${qs}`, this.sub())
      this.stt = ws
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('STT socket failed to open'))
      ws.onclose = () => { if (this.running) this.h.onError('STT socket closed') }
      ws.onmessage = e => this.onSttMessage(e)
    })
  }

  private openTts(): Promise<void> {
    const qs = new URLSearchParams({ model: 'bulbul:v3' })
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${TTS_WS}?${qs}`, this.sub())
      this.tts = ws
      ws.onopen = () => {
        // Pre-warmed and configured once for the whole conversation — a per-turn
        // connect would bill ~240 ms to every sentence.
        ws.send(JSON.stringify({
          type: 'config',
          data: {
            target_language_code: 'en-IN', speaker: this.speaker,
            output_audio_codec: 'mp3', speech_sample_rate: 22050,
            min_buffer_size: 50, max_chunk_length: 150,
          },
        }))
        resolve()
      }
      ws.onerror = () => reject(new Error('TTS socket failed to open'))
      ws.onmessage = e => this.onTtsMessage(e)
    })
  }

  private onSttMessage(e: MessageEvent) {
    let m: any
    try { m = JSON.parse(e.data) } catch { return }
    switch (m.event ?? m.type) {
      case 'transcript.partial':
        if (m.text) this.h.onPartial(m.text)
        break
      case 'vad.speech_end':
        // The user has stopped talking — every latency number is anchored here.
        this.speechEndAt = performance.now()
        this.h.onPhase('thinking')
        break
      case 'transcript.final': {
        const text = (m.text ?? m.transcript ?? '').trim()
        if (!text) { if (!this.busy) this.h.onPhase('listening'); return }
        if (this.busy) {
          // Still answering the previous fragment — hold this one and send it as
          // part of the next message instead of racing.
          this.queued.push(text)
          this.h.onFinal([...this.queued].join(' '))
          return
        }
        this.t = { sttMs: Math.round(performance.now() - this.speechEndAt) }
        this.h.onTimings(this.t)
        this.h.onFinal(text)
        void this.ask(text)
        break
      }
      case 'error':
        this.h.onError(JSON.stringify(m).slice(0, 200))
        break
    }
  }

  private onTtsMessage(e: MessageEvent) {
    let m: any
    try { m = JSON.parse(e.data) } catch { return }
    const b = m?.data?.audio
    if (b) {
      if (this.t.audioMs === undefined) {
        this.t.audioMs = Math.round(performance.now() - this.speechEndAt)
        this.h.onTimings({ ...this.t })
        this.h.onPhase('speaking')
      }
      const bin = atob(b)
      const u8 = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
      if (this.useMse) {
        this.pushMse(u8)
        // Sarvam sends no completion event, so end-of-reply is still detected by
        // idle — but here it only CLOSES the buffer; playback already started on
        // chunk one, so this costs nothing.
        if (this.idleTimer) clearTimeout(this.idleTimer)
        this.idleTimer = setTimeout(() => this.endMse(), IDLE_MS) as unknown as number
      } else {
        this.audioChunks.push(u8)
        if (this.idleTimer) clearTimeout(this.idleTimer)
        this.idleTimer = setTimeout(() => this.flushAudio(), IDLE_MS) as unknown as number
      }
    }
  }

  /** Open a fresh MediaSource for this reply and start playing the moment the
   *  first bytes land. */
  private startMse() {
    if (!this.audioWired) {
      // One listener for the life of the engine — re-adding per reply would stack
      // handlers and fire the phase change N times.
      this.audioEl.addEventListener('ended', () => {
        this.resetAudio()
        if (this.running) this.h.onPhase('listening')
      })
      this.audioWired = true
    }
    const ms = new MediaSource()
    this.media = ms
    this.mseReady = false
    this.appendQ = []
    this.audioEl.src = URL.createObjectURL(ms)
    ms.addEventListener('sourceopen', () => {
      try {
        const sb = ms.addSourceBuffer('audio/mpeg')
        this.sb = sb
        sb.addEventListener('updateend', () => this.drainQ())
        this.mseReady = true
        this.drainQ()
      } catch {
        // Codec refused after all — fall back rather than go silent.
        this.useMse = false
      }
    })
    void this.audioEl.play().catch(e => {
      this.h.onError(`Audio blocked by the browser (${(e as Error).name}) — click the page once.`)
    })
  }

  /** Tear down the current reply's buffer so the next turn starts clean. */
  private resetAudio() {
    try { this.media && this.media.readyState === 'open' && this.media.endOfStream() } catch { /* fine */ }
    this.media = undefined
    this.sb = undefined
    this.appendQ = []
    this.audioChunks = []
    this.mseReady = false
  }

  private pushMse(u8: Uint8Array) {
    if (!this.media) this.startMse()
    this.appendQ.push(u8)
    this.drainQ()
  }

  /** A SourceBuffer accepts one append at a time; queue the rest. */
  private drainQ() {
    if (!this.mseReady || !this.sb || this.sb.updating) return
    const next = this.appendQ.shift()
    if (!next) return
    try {
      this.sb.appendBuffer(next as unknown as BufferSource)
    } catch {
      this.appendQ.unshift(next)
    }
  }

  /** The reply is fully synthesised — close the stream so `ended` fires and the
   *  call returns to listening. */
  private endMse() {
    if (!this.media || this.media.readyState !== 'open') return
    const finish = () => {
      try { this.media?.endOfStream() } catch { /* already ended */ }
    }
    if (this.sb?.updating || this.appendQ.length) setTimeout(() => this.endMse(), 60)
    else finish()
  }

  /** Fallback only: no MSE, so play what accumulated once the socket goes quiet. */
  private flushAudio() {
    if (!this.audioChunks.length) return
    const blob = new Blob(this.audioChunks as BlobPart[], { type: 'audio/mpeg' })
    this.audioChunks = []
    const url = URL.createObjectURL(blob)
    this.audioEl.src = url
    this.audioEl.onended = () => {
      URL.revokeObjectURL(url)
      if (this.running) this.h.onPhase('listening')
    }
    void this.audioEl.play().catch(e => {
      this.h.onError(`Audio blocked by the browser (${(e as Error).name}) — click the page once.`)
    })
  }

  // ── LLM ───────────────────────────────────────────────────────────────────

  private async ask(text: string) {
    // Anything buffered while the last turn ran belongs with this one.
    if (this.queued.length) {
      text = [...this.queued, text].join(' ')
      this.queued = []
    }
    this.busy = true
    this.reply = ''
    this.spokenFirst = false
    this.t.llmMs = undefined
    this.t.audioMs = undefined
    try {
      // POST only STARTS the run; the answer arrives on the app socket. A
      // `streaming:false` reply means the backend saw no live socket for this user
      // and generated nothing — worth surfacing rather than waiting forever.
      const res = await fetch(`${BASE}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: this.userId, message: text, voice: true,
          ...(this.sessionId ? { session_id: this.sessionId } : {}),
        }),
      })
      if (!res.ok) throw new Error(`/chat/stream -> HTTP ${res.status}`)
      const d = await res.json()
      if (d.streaming === false) {
        throw new Error(`backend declined to stream (${d.reason ?? 'no socket'})`)
      }
    } catch (e) {
      this.busy = false
      this.h.onError((e as Error).message)
      this.h.onPhase('listening')
    }
  }

  /** Frames from the app's own WebSocket — the same ones the Flutter client gets.
   *
   *  chat.delta is prose only: a structured (JSON) answer and every fast-path reply
   *  emit NO deltas, just chat.complete. So this must never assume deltas arrive, or
   *  greetings and "what's due today" would be silent — the two most common things
   *  anyone says to it.
   */
  private onAppFrame(ev: MessageEvent) {
    let f: any
    try { f = JSON.parse(ev.data) } catch { return }
    const p = f.payload ?? {}
    switch (f.type) {
      case 'chat.delta': {
        if (!p.text) return
        if (this.t.llmMs === undefined) {
          this.t.llmMs = Math.round(performance.now() - this.speechEndAt)
          this.h.onTimings({ ...this.t })
        }
        this.reply += p.text
        this.h.onReplyToken(this.reply)
        // Sentence one to the speaker while the model keeps writing.
        if (!this.spokenFirst) {
          const cut = firstChunkEnd(this.reply)
          if (cut > 0) { this.speak(this.reply.slice(0, cut)); this.spokenFirst = true }
        }
        break
      }
      case 'chat.complete': {
        // chat.complete.text is AUTHORITATIVE and replaces the buffer — that is the
        // documented contract, and it is how a fast-path reply (zero deltas) arrives.
        const full = (p.text ?? '').toString()
        if (this.t.llmMs === undefined) {
          this.t.llmMs = Math.round(performance.now() - this.speechEndAt)
          this.h.onTimings({ ...this.t })
        }
        this.reply = full
        this.h.onReplyToken(full)
        if (!this.spokenFirst) {
          if (full.trim()) this.speak(full)
        } else {
          const cut = firstChunkEnd(full)
          const rest = cut > 0 ? full.slice(cut).trim() : ''
          if (rest) this.speak(rest)
        }
        this.tts?.send(JSON.stringify({ type: 'flush' }))
        this.turnDone()
        break
      }
    }
  }

  /** The turn is over: the server has now written this exchange to history, so the
   *  NEXT message will actually see it. Anything the user said while we were busy
   *  goes out as a single merged message. */
  private turnDone() {
    this.busy = false
    if (this.queued.length) {
      const merged = this.queued.join(' ')
      this.queued = []
      void this.ask(merged)
    }
  }

  /** Start a fresh conversation without dropping the call — new session id, so the
   *  agent stops carrying the previous topic. */
  async newSession() {
    this.queued = []
    this.busy = false
    this.sessionId = undefined
    await this.openSession()
    return this.sessionId
  }

  private speak(text: string) {
    this.tts?.send(JSON.stringify({ type: 'text', data: { text } }))
  }

  // ── Mic ───────────────────────────────────────────────────────────────────

  private async openMic() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    })
    const ctx = new AudioContext()
    this.ctx = ctx
    const src = ctx.createMediaStreamSource(this.stream)
    // ScriptProcessor is deprecated in favour of AudioWorklet, but a worklet needs a
    // separate module file and buys nothing for a spike — this runs for seconds at a
    // time, not hours.
    const node = ctx.createScriptProcessor(4096, 1, 1)
    this.node = node
    const framesPer = TARGET_SR * (FRAME_MS / 1000)

    node.onaudioprocess = ev => {
      if (!this.running || this.stt?.readyState !== WebSocket.OPEN) return
      const input = ev.inputBuffer.getChannelData(0)

      let sum = 0
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
      this.h.onLevel(Math.sqrt(sum / input.length))

      const pcm = toPcm16(input, ctx.sampleRate)
      for (let i = 0; i < pcm.length; i++) this.pending.push(pcm[i])

      // Emit fixed 100 ms frames regardless of the browser's buffer size — the
      // whole point of the buffer.
      while (this.pending.length >= framesPer) {
        const frame = Int16Array.from(this.pending.splice(0, framesPer))
        this.stt.send(JSON.stringify({
          event: 'audio_input', audio: b64(frame),
        }))
      }
    }
    src.connect(node)
    node.connect(ctx.destination)
  }
}
