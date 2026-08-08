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

/** The reply endpoint. Defaults to the REAL local `/chat` — the actual Oscar brain,
 *  tools and all — so the latency measured is the one a user would live with, not a
 *  stripped-down floor. Point it at /spike/llm/oscar to measure that floor instead. */
const LLM_URL = (import.meta.env.VITE_CHAT_URL as string | undefined)
  ?? 'http://127.0.0.1:8000/chat'
const DEFAULT_USER_ID = Number(import.meta.env.VITE_CHAT_USER_ID ?? 7)

/** `/chat` answers with ONE JSON body; `/spike/llm/*` streams SSE tokens. Detected
 *  from the URL so both work without a second flag to keep in sync. */
const isSse = (u: string) => u.includes('/spike/')

const STT_WS = 'wss://api.sarvam.ai/speech-to-text-realtime/ws'
const TTS_WS = 'wss://api.sarvam.ai/text-to-speech/ws'

const FRAME_MS = 100
const TARGET_SR = 16000
/** 400 ms measured as the floor: at 200 ms the VAD ends the utterance mid-sentence. */
const SILENCE_MS = 400
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
  private stt?: WebSocket
  private tts?: WebSocket
  private ctx?: AudioContext
  private stream?: MediaStream
  private node?: ScriptProcessorNode
  private pending: number[] = []
  private running = false

  private speechEndAt = 0
  private t: Timings = {}
  private reply = ''
  private spokenFirst = false

  // Playback. Sarvam streams MP3 chunks; decoding one standalone mid-stream is not
  // reliable, so they are concatenated and played as a blob.
  //
  // 🔴 There is NO completion message. Verified against the live socket: 18 audio
  // chunks arrive and then nothing — no `flush` echo, no `audio.complete`, the
  // socket just goes quiet. Waiting for one (the obvious reading of the API) means
  // audio accumulates forever and the user hears silence, which is exactly how this
  // first failed. End-of-speech is therefore detected by IDLE: no new chunk for
  // IDLE_MS. Queued so a second batch cannot cut off the first.
  private audioChunks: Uint8Array[] = []
  private idleTimer: number | undefined
  private playQueue: string[] = []
  private playing = false
  private audioEl = new Audio()

  constructor(h: Handlers, userId: number = DEFAULT_USER_ID) {
    this.h = h
    this.userId = userId
  }

  get isRunning() { return this.running }

  async start() {
    if (!KEY) { this.h.onError('VITE_SARVAM_KEY is not set'); return }
    if (this.running) return
    this.running = true
    try {
      await this.openTts()
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
    try { this.node?.disconnect() } catch { /* already gone */ }
    try { this.stream?.getTracks().forEach(t => t.stop()) } catch { /* ditto */ }
    try { this.ctx?.close() } catch { /* ditto */ }
    try { this.stt?.close() } catch { /* ditto */ }
    try { this.tts?.close() } catch { /* ditto */ }
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.audioEl.pause()
    this.playQueue.forEach(URL.revokeObjectURL)
    this.playQueue = []
    this.playing = false
    this.h.onLevel(0)
    this.h.onPhase('idle')
  }

  // ── Sockets ───────────────────────────────────────────────────────────────

  private sub(): string[] {
    // The subprotocol IS the credential — see the header note at the top.
    return [`api-subscription-key.${KEY}`]
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
            target_language_code: 'en-IN', speaker: 'shubh',
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
        if (!text) { this.h.onPhase('listening'); return }
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
      this.audioChunks.push(u8)
      // Restart the idle countdown on every chunk — it fires once the server stops.
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => this.flushAudio(), IDLE_MS) as unknown as number
    }
  }

  /** The server has gone quiet — turn what arrived into one playable blob. */
  private flushAudio() {
    if (!this.audioChunks.length) return
    const blob = new Blob(this.audioChunks as BlobPart[], { type: 'audio/mpeg' })
    this.audioChunks = []
    this.playQueue.push(URL.createObjectURL(blob))
    if (!this.playing) this.playNext()
  }

  private playNext() {
    const url = this.playQueue.shift()
    if (!url) {
      this.playing = false
      // Straight back to listening — that continuity IS the live-voice feel.
      if (this.running) this.h.onPhase('listening')
      return
    }
    this.playing = true
    this.audioEl.src = url
    this.audioEl.onended = () => { URL.revokeObjectURL(url); this.playNext() }
    this.audioEl.onerror = () => { URL.revokeObjectURL(url); this.playNext() }
    void this.audioEl.play().catch(e => {
      // Autoplay policy: the first sound of a session can need a user gesture. Say
      // so instead of failing silently, which is indistinguishable from a dead TTS.
      this.h.onError(`Audio blocked by the browser (${(e as Error).name}) — click the page once.`)
      this.playNext()
    })
  }

  // ── LLM ───────────────────────────────────────────────────────────────────

  private async ask(text: string) {
    this.reply = ''
    this.spokenFirst = false
    this.t.llmMs = undefined
    this.t.audioMs = undefined
    try {
      const res = await fetch(LLM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: this.userId, message: text }),
      })
      if (!res.ok) throw new Error(`${LLM_URL} -> HTTP ${res.status}`)

      if (isSse(LLM_URL)) await this.readSse(res)
      else await this.readJson(res)

      if (!this.spokenFirst && this.reply.trim()) this.speak(this.reply)
      else if (this.spokenFirst) {
        const m = /[.!?]\s/.exec(this.reply)
        const rest = m ? this.reply.slice(m.index + 1).trim() : ''
        if (rest) this.tts?.send(JSON.stringify({ type: 'text', data: { text: rest } }))
      }
      this.tts?.send(JSON.stringify({ type: 'flush' }))
    } catch (e) {
      this.h.onError((e as Error).message)
      // Back to listening rather than stuck on "Thinking…" — a dead reply must not
      // strand the call, which is exactly how a 404 presented before.
      this.h.onPhase('listening')
    }
  }

  /** `POST /chat` — the real assistant. One body, no tokens, so "first token" and
   *  "reply complete" are the same instant. That is the honest number for this
   *  endpoint: nothing can be spoken until the whole answer exists. */
  private async readJson(res: Response) {
    const d = await res.json()
    this.t.llmMs = Math.round(performance.now() - this.speechEndAt)
    this.h.onTimings({ ...this.t })
    this.reply = (d.response ?? '').toString()
    this.h.onReplyToken(this.reply)
  }

  /** `POST /spike/llm/*` — SSE tokens, so sentence one can be spoken while the rest
   *  is still being written. */
  private async readSse(res: Response) {
    if (!res.body) throw new Error('no stream from the LLM endpoint')
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        let d: any
        try { d = JSON.parse(line.slice(6)) } catch { continue }
        if (!d.t) continue
        if (this.t.llmMs === undefined) {
          this.t.llmMs = Math.round(performance.now() - this.speechEndAt)
          this.h.onTimings({ ...this.t })
        }
        this.reply += d.t
        this.h.onReplyToken(this.reply)
        if (!this.spokenFirst) {
          const m = /[.!?]\s/.exec(this.reply)
          if (m) { this.speak(this.reply.slice(0, m.index + 1)); this.spokenFirst = true }
        }
      }
    }
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
