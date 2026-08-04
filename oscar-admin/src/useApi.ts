import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from './lib/api'

/**
 * One fetch per view, with the abort actually wired up. Without the AbortController
 * a fast tab switch lands the previous view's response in the new view's state.
 */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!!path)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce(n => n + 1), [])

  useEffect(() => {
    if (!path) return
    const ac = new AbortController()
    setLoading(true)
    setError(null)
    api<T>(path, ac.signal)
      .then(d => { setData(d); setLoading(false) })
      .catch((e: unknown) => {
        if ((e as Error)?.name === 'AbortError') return
        setError(e instanceof ApiError ? e.message : String(e))
        setLoading(false)
      })
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps])

  return { data, error, loading, reload }
}
