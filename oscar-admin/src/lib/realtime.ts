/**
 * OpenAI Realtime — speech-to-speech, for comparison against the Sarvam pipeline.
 *
 * Structurally different from liveVoice.ts, and that IS the experiment:
 *
 *   Sarvam pipeline   mic → STT → LLM → TTS → speaker     4 services, 3 waits
 *   Realtime          mic ⇄ one model ⇄ speaker           1 service, no transcript
 *
 * There is no transcription step to wait for and no separate TTS to invoke, so the
 * model can begin answering while the user is still finishing a sentence. It also
 * gives barge-in for free — talk over it and it stops mid-word — which our pipeline
 * cannot do at any latency.
 *
 * WebRTC rather than a WebSocket: OpenAI's own guidance for browsers, and it hands
 * audio playback, jitter buffering and echo handling to the browser instead of us
 * reimplementing them. The audio element is fed a MediaStream directly, so nothing
 * here decodes or queues chunks.
 *
 * 🔴 The API key never reaches the browser. `/voice/realtime-token` mints a
 * short-lived ephemeral secret server-side; that is what this connects with. Keep it
 * that way — a page holding the real key is a page that leaks it.
 */

const BASE = (import.meta.env.VITE_BACKEND_URL as string | undefined)
  ?? 'http://127.0.0.1:8000'

export type RtPhase = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking'

export type RtHandlers = {
  onPhase: (p: RtPhase) => void
  onUserText: (text: string) => void      // what it heard (arrives AFTER the answer)
  onReplyText: (text: string) => void
  onLatency: (ms: number) => void         // speech end → first audio
  onError: (msg: string) => void
  /** Every step and every event, so a failure is visible instead of a silent orb.
   *  This tab talks browser→OpenAI directly, so NOTHING about it reaches the
   *  server log — without this there is no way to see what went wrong. */
  onLog?: (line: string) => void
}

export class RealtimeVoice {
  private h: RtHandlers
  private pc?: RTCPeerConnection
  private dc?: RTCDataChannel
  private stream?: MediaStream
  private audioEl = new Audio()
  private speechEndAt = 0
  private timed = false
  private running = false

  constructor(h: RtHandlers) { this.h = h }

  private log(line: string) { this.h.onLog?.(line) }

  get isRunning() { return this.running }

  async start(instructions?: string) {
    if (this.running) return
    this.running = true
    this.h.onPhase('connecting')
    try {
      // 1. Ephemeral token from OUR backend — the real key stays server-side.
      const tk = await fetch(`${BASE}/voice/realtime-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      this.log(`POST ${BASE}/voice/realtime-token → ${tk.status}`)
      if (!tk.ok) throw new Error(`/voice/realtime-token → HTTP ${tk.status}`)
      const tokenJson = await tk.json()
      const client_secret = tokenJson.client_secret
      // The backend may return a nested {client_secret:{value}} shape depending on
      // which OpenAI response form it passes through — accept both.
      const secret = typeof client_secret === 'string'
        ? client_secret : client_secret?.value
      const model = tokenJson.model || 'gpt-realtime'
      if (!secret) throw new Error('no client_secret returned by /voice/realtime-token')
      this.log(`token ok · model=${model} · secret=${String(secret).slice(0, 8)}…`)

      // 2. Peer connection. Remote audio is played by the browser directly.
      const pc = new RTCPeerConnection()
      this.pc = pc
      this.audioEl.autoplay = true
      pc.ontrack = e => { this.audioEl.srcObject = e.streams[0] }

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      this.stream.getTracks().forEach(t => pc.addTrack(t, this.stream!))
      this.log('mic captured, track added')
      pc.oniceconnectionstatechange = () => this.log(`ice: ${pc.iceConnectionState}`)
      pc.onconnectionstatechange = () => this.log(`peer: ${pc.connectionState}`)

      // 3. Events ride a data channel alongside the audio.
      const dc = pc.createDataChannel('oai-events')
      this.dc = dc
      dc.onmessage = e => this.onEvent(e)
      dc.onopen = () => {
        // `session.type` is REQUIRED on the GA API — omit it and the session update
        // is rejected with "Missing required parameter: 'session.type'" even though
        // the WebRTC connection itself succeeded, so it reads like a connection
        // failure when it is really a malformed first message.
        dc.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            ...(instructions ? { instructions } : {}),
            // Ask for the user's transcript too — the model does not need it, but
            // showing what it heard is how we prove it answered BEFORE transcribing.
            audio: {
              input: {
                transcription: { model: 'whisper-1' },
                turn_detection: { type: 'server_vad' },
              },
            },
          },
        }))
        this.log('data channel open, session.update sent')
        this.h.onPhase('listening')
      }

      // 4. SDP exchange. The ephemeral secret is the bearer here.
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      // GA WebRTC endpoint. /v1/realtime is the WEBSOCKET path; posting an SDP offer
      // there answers "The Realtime Beta API is no longer supported. Please use
      // /v1/realtime for the GA API." — a message that points at the URL you already
      // used, which is why this looked unfixable. /v1/realtime/calls is the one that
      // takes an offer.
      const sdp = await fetch(
        `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`, {
          method: 'POST',
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${secret}`,
            'Content-Type': 'application/sdp',
          },
        })
      this.log(`POST /v1/realtime/calls → ${sdp.status}`)
      if (!sdp.ok) {
        const body = await sdp.text()
        let detail = body.slice(0, 200)
        try { detail = JSON.parse(body)?.error?.message ?? detail } catch { /* not JSON */ }
        throw new Error(`realtime SDP → HTTP ${sdp.status}: ${detail}`)
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: await sdp.text() })
      this.log('SDP answer applied — connecting audio')
    } catch (e) {
      this.running = false
      this.log(`FAILED ${(e as Error).message}`)
      this.h.onError((e as Error).message)
      this.stop()
    }
  }

  stop() {
    this.running = false
    try { this.stream?.getTracks().forEach(t => t.stop()) } catch { /* gone */ }
    try { this.dc?.close() } catch { /* gone */ }
    try { this.pc?.close() } catch { /* gone */ }
    this.audioEl.srcObject = null
    this.h.onPhase('idle')
  }

  /** Interrupt mid-sentence — the thing the Sarvam pipeline cannot do. The server
   *  also does this automatically when it hears speech; this is the manual lever. */
  interrupt() {
    this.dc?.send(JSON.stringify({ type: 'response.cancel' }))
  }

  private onEvent(e: MessageEvent) {
    let m: any
    try { m = JSON.parse(e.data) } catch { return }
    // Everything except the per-chunk audio floods, which would drown the log.
    if (!m.type?.includes('.delta')) this.log(`← ${m.type}`)
    switch (m.type) {
      case 'input_audio_buffer.speech_started':
        this.h.onPhase('listening')
        break
      case 'input_audio_buffer.speech_stopped':
        // Anchor latency to the same instant the Sarvam pipeline uses, so the two
        // numbers on screen mean the same thing and can be compared honestly.
        this.speechEndAt = performance.now()
        this.timed = false
        this.h.onPhase('thinking')
        break
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (!this.timed && this.speechEndAt) {
          this.timed = true
          this.h.onLatency(Math.round(performance.now() - this.speechEndAt))
          this.h.onPhase('speaking')
        }
        break
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (m.transcript) this.h.onReplyText(m.transcript)
        break
      case 'conversation.item.input_audio_transcription.completed':
        // Note the ordering: the model answers BEFORE this arrives. It never waited
        // for a transcript, which is exactly the second we cannot recover.
        if (m.transcript) this.h.onUserText(m.transcript)
        break
      case 'response.done':
        if (this.running) this.h.onPhase('listening')
        break
      case 'error':
        this.log(`ERROR ${JSON.stringify(m.error ?? m).slice(0, 200)}`)
        this.h.onError(m.error?.message ?? JSON.stringify(m).slice(0, 160))
        break
    }
  }
}
