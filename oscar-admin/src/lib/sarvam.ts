/**
 * Sarvam speech, called STRAIGHT FROM THE BROWSER — no backend involved.
 *
 * Deliberate: the point of this module is to measure what an Indian-language voice
 * turn actually costs, and proxying through Render would add a cold start and a
 * second network hop to every measurement, hiding the number we came for.
 * api.sarvam.ai answers preflight with `access-control-allow-origin: *`, so a
 * browser can call it directly.
 *
 * 🔴 THE KEY IS IN THE BUNDLE. Anything prefixed VITE_ is inlined into the JS Vite
 * ships, so this key is readable by anyone who loads the page. Acceptable for a
 * localhost-only admin panel, NOT acceptable anywhere public — if this panel is
 * ever deployed, these calls must move behind the backend and the key be rotated.
 * Frontend-only was an explicit choice for this test, not a default.
 */

const KEY = import.meta.env.VITE_SARVAM_KEY as string | undefined
const BASE = 'https://api.sarvam.ai'

export const hasSarvamKey = () => !!KEY

/** Sarvam's own request id — worth surfacing, it is what their support asks for. */
export type Timed<T> = T & { ms: number; requestId?: string }

function assertKey(): string {
  if (!KEY) throw new Error('VITE_SARVAM_KEY is not set — add it to .env.local and restart Vite')
  return KEY
}

/** Speech → text. `saaras:v3` auto-detects the language; do NOT pin one for
 *  code-mixed speech, which is most of how people actually talk here. */
export async function transcribe(blob: Blob, model = 'saaras:v3'): Promise<Timed<{
  transcript: string; languageCode?: string; languageProbability?: number
}>> {
  const key = assertKey()
  const fd = new FormData()
  // Filename matters: Sarvam infers the container from the extension, and a blob
  // posted without one is rejected as an unsupported format.
  fd.append('file', blob, blob.type.includes('wav') ? 'audio.wav' : 'audio.webm')
  fd.append('model', model)
  fd.append('mode', 'transcribe')

  const t0 = performance.now()
  const res = await fetch(`${BASE}/speech-to-text`, {
    method: 'POST', headers: { 'api-subscription-key': key }, body: fd,
  })
  const ms = Math.round(performance.now() - t0)
  if (!res.ok) throw new Error(`Sarvam STT ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  return {
    transcript: j.transcript ?? '',
    languageCode: j.language_code,
    languageProbability: j.language_probability,
    requestId: j.request_id,
    ms,
  }
}

/** Text → speech. Returns a playable object URL plus the byte count, because "how
 *  long did it take" is only half the question when the audio has to travel. */
export async function speak(
  text: string,
  opts: { language?: string; speaker?: string; model?: string } = {},
): Promise<Timed<{ url: string; bytes: number }>> {
  const key = assertKey()
  const t0 = performance.now()
  const res = await fetch(`${BASE}/text-to-speech`, {
    method: 'POST',
    headers: { 'api-subscription-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model ?? 'bulbul:v3',
      text,
      target_language_code: opts.language ?? 'en-IN',
      speaker: opts.speaker ?? 'shubh',
    }),
  })
  const ms = Math.round(performance.now() - t0)
  if (!res.ok) throw new Error(`Sarvam TTS ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()

  // The API returns base64 WAV, not a URL. Decoded here so the caller gets
  // something an <audio> element plays with no further handling.
  const b64 = (j.audios ?? [])[0]
  if (!b64) throw new Error('Sarvam TTS returned no audio')
  const bin = atob(b64)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  const blob = new Blob([buf], { type: 'audio/wav' })
  return { url: URL.createObjectURL(blob), bytes: blob.size, requestId: j.request_id, ms }
}

/** Languages bulbul speaks. STT auto-detects, so this only drives TTS. */
export const LANGUAGES = [
  { code: 'en-IN', label: 'English (India)' },
  { code: 'hi-IN', label: 'Hindi' },
  { code: 'te-IN', label: 'Telugu' },
  { code: 'ta-IN', label: 'Tamil' },
  { code: 'kn-IN', label: 'Kannada' },
  { code: 'ml-IN', label: 'Malayalam' },
  { code: 'mr-IN', label: 'Marathi' },
  { code: 'bn-IN', label: 'Bengali' },
  { code: 'gu-IN', label: 'Gujarati' },
  { code: 'pa-IN', label: 'Punjabi' },
]
