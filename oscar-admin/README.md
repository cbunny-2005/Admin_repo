# oscar-admin

> **Replaced 2026-10-02.** This file was still the unedited Vite/React template
> boilerplate (React Compiler, Oxlint setup notes) and described nothing about this
> actual app. **See `/README.md` at the repo root for the real, current docs** —
> what this panel does, which tabs write, the port-5174 CORS requirement, the
> backend-URL precedence fix, and the `epa-3` role-change warning. This file now only
> covers things specific to running `oscar-admin/` as a Vite project.

## Stack

React 19 + TypeScript + Vite, Tailwind v4 (`@tailwindcss/vite`), Oxlint.

## Commands

```bash
npm install
npm run dev      # http://localhost:5174 — see root README for why 5174, not 5173
npm run build    # -> dist/
```

## Config files relevant here

- `vite.config.ts` — `port: 5174` with `strictPort: true` (fails loudly on a clash
  rather than silently picking another port that the backend's `CORS_ORIGINS` doesn't
  know about); `base` defaults to `/` for Vercel, overridable via `BASE_PATH` env for a
  subpath host.
- `.env.local` (gitignored, not committed) — holds `VITE_ADMIN_BASE`,
  `VITE_ADMIN_SECRET`, and programme/voice-spike-specific vars. See the file itself
  for what each one does; it is commented in place.
- `src/lib/api.ts` — the backend client. `getBase()`'s precedence
  (`VITE_ADMIN_BASE` → `localStorage` → same-origin default) is the fix described in
  the root README; do not reorder it without reading that section first.

## Source layout

```
src/
  App.tsx       # tab nav (NAV array), login gate
  views.tsx     # Overview, Sessions, Mcp
  people.tsx    # People tab (writes: push test, org profile)
  program.tsx   # Alumnx AI Engineer Program console (writes: tasks, comments)
  tasks.tsx     # Tasks tab (read-only, /admin/tasks)
  lib/api.ts    # backend client, getBase()/getSecret()/setCreds()
  lib/liveVoice.ts, realtime.ts, sarvam.ts   # voice-spike leftovers. Confirmed
                                              # (2026-10-02, grep over src/) not
                                              # imported by App.tsx or any NAV view —
                                              # dead code since the Voice tabs were
                                              # removed in 06ea91c (2026-09-01, see
                                              # root README). Safe to delete; left in
                                              # place here only because this pass was
                                              # docs-only.
```

## Linting

Oxlint is configured (`.oxlintrc.json`). For type-aware rules, install
`oxlint-tsgolint` per the Oxlint docs — not evaluated as part of this pass.
