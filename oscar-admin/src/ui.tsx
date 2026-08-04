import type { ReactNode } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx(
      'rounded-2xl border border-ink-700/70 bg-ink-900/70 backdrop-blur',
      'shadow-[0_1px_0_0_rgba(255,255,255,.04)_inset,0_18px_40px_-24px_rgba(0,0,0,.9)]',
      className,
    )}>{children}</div>
  )
}

export function Stat({ label, value, sub, tone = 'default' }: {
  label: string; value: ReactNode; sub?: string
  tone?: 'default' | 'good' | 'warn' | 'brand'
}) {
  const tones = {
    default: 'text-ink-100',
    good: 'text-emerald-300',
    warn: 'text-amber-300',
    brand: 'text-brand-400',
  }
  return (
    <Card className="p-5 rise">
      <div className="text-[11px] font-medium uppercase tracking-[.14em] text-ink-400">{label}</div>
      <div className={cx('mt-2 text-3xl font-semibold tabular-nums tracking-tight', tones[tone])}>
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-ink-400">{sub}</div>}
    </Card>
  )
}

const BADGE_TONES: Record<string, string> = {
  complete: 'bg-emerald-500/12 text-emerald-300 ring-emerald-500/25',
  awaiting_contact: 'bg-amber-500/12 text-amber-300 ring-amber-500/25',
  awaiting_details: 'bg-ink-600/40 text-ink-300 ring-ink-600',
  ocr: 'bg-sky-500/12 text-sky-300 ring-sky-500/25',
  manual: 'bg-violet-500/12 text-violet-300 ring-violet-500/25',
  db: 'bg-emerald-500/12 text-emerald-300 ring-emerald-500/25',
  env: 'bg-amber-500/12 text-amber-300 ring-amber-500/25',
  none: 'bg-ink-600/40 text-ink-400 ring-ink-600',
  on: 'bg-brand-500/15 text-brand-400 ring-brand-500/30',
}

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  const key = tone ?? String(children)
  return (
    <span className={cx(
      'inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[11px] font-medium',
      'ring-1 whitespace-nowrap',
      BADGE_TONES[key] ?? 'bg-ink-700/60 text-ink-300 ring-ink-600',
    )}>{children}</span>
  )
}

/** Muted em-dash for null. A blank cell reads as "not loaded"; this reads as "empty". */
export const Empty = () => <span className="text-ink-600">—</span>

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-700/70">
            {head.map(h => (
              <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold
                                     uppercase tracking-[.12em] text-ink-400 whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-700/40">{children}</tbody>
      </table>
    </div>
  )
}

export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <td className={cx('px-4 py-3 align-middle', className)}>{children}</td>
)

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-16 text-sm text-ink-400">
      <Loader2 className="size-4 animate-spin" />
      {label ?? 'Loading…'}
    </div>
  )
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <Card className="p-5 border-rose-500/25 bg-rose-500/[.05]">
      <div className="flex gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-300" />
        <div className="min-w-0">
          <div className="text-sm font-medium text-rose-200">Request failed</div>
          <div className="mt-1 text-sm leading-relaxed text-ink-300 break-words">{error}</div>
          {onRetry && (
            <button onClick={onRetry}
              className="mt-3 rounded-lg border border-ink-600 bg-ink-800 px-3 py-1.5
                         text-xs font-medium hover:bg-ink-700 transition">
              Retry
            </button>
          )}
        </div>
      </div>
    </Card>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[.12em] text-ink-400">
        {label}
      </span>
      {children}
    </label>
  )
}

export const inputCls =
  'w-full rounded-xl border border-ink-600 bg-ink-850 px-3 py-2 text-sm ' +
  'placeholder:text-ink-600 outline-none transition ' +
  'focus:border-brand-500 focus:ring-2 focus:ring-brand-500/25'
