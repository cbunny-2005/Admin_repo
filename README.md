# Oscar Admin

Read-only operations panel for the HelloOscar backend. React + Vite + Tailwind v4.

Nothing in this app writes. Every request is a `GET` carrying `X-Admin-Secret`.

## Run

```bash
cd oscar-admin
npm install
npm run dev          # http://localhost:5173
```

Open it, enter the backend URL and `ADMIN_SECRET`, and the panel verifies the secret
before letting you in — so a wrong value fails once, clearly, instead of as five
identical 401s.

**Port 5173 is not arbitrary.** It is the only `localhost` origin present in the
backend's `CORS_ORIGINS`. On any other port every request dies in preflight with an
opaque CORS error, which looks nothing like the actual cause. `vite.config.ts` sets
`strictPort` so it fails loudly rather than silently picking 5174.

## Deploying it

Any static host (`npm run build` → `dist/`). One requirement: **add the deployed
origin to the backend's `CORS_ORIGINS`**, or the built site loads and every panel
shows a connection error.

## What it shows

| View | Endpoint | For |
|---|---|---|
| Overview | `/admin/overview` | counts, plus the photo → details → contact funnel |
| Photos & contacts | `/admin/photo-contacts` | every captured photo, its context and stored contact, filterable by state |
| Sessions | `/admin/sessions`, `/admin/sessions/{id}/transcript` | session list, and a drawer with the full transcript + attached photos |
| WhatsApp | `/admin/whatsapp-contacts` | the directory a labelled broadcast would actually reach |
| MCP config | `/admin/mcp-config` | which org resolves to which MCP, **and from where** — db row, env var, or nothing |

`MCP config` exists because Render's API can set environment variables but cannot
read them back, so "which org points where" was previously unauditable. It reports
the DB rows, the env value, which source won, and the *resolved* server names from
`servers_for_team` — the authoritative answer rather than what a config implies.

## Requires

`ADMIN_SECRET` set on the backend. Unset disables every admin route by design — this
backend has no auth, and these routes return phone numbers and chat transcripts.

The endpoints live in the backend repo (`main.py`, `# ── Admin read API`).
