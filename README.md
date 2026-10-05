# Oscar Admin

Operations panel for the HelloOscar backend. React + Vite + Tailwind v4.

> **Repo mirrors, updated 2026-10-05.** This repo pushes to TWO remotes: `origin`
> (`cbunny-2005/Admin_repo`, original) and `alumnx`
> (`alumnxcodebase/hello_oscar_admin_dashboard`, added 2026-10-05). Only
> `Brand_new_admin_after_revamp` has been pushed to `alumnx` so far, as its `main`
> branch — the other three local branches (`feat/program-console`, `feat/sarvam-voice`,
> local `main`) are **not yet on `alumnx`**. `Brand_new_admin_after_revamp` is the
> correct one to deploy from (see "Deploying it" below) and fully contains the other
> two feature branches' work already.

> **Updated 2026-10-02.** Rewritten against this repo's actual `git log` and current
> `oscar-admin/src` — the previous version of this file described an earlier, fully
> read-only, port-5173 panel that no longer exists on this branch. See "What changed"
> below for exactly what drifted and the commits that moved it.

## This panel is NOT read-only any more

Two tabs write real data: **People** can send a real push notification and edit an
org profile; **Alumnx AI Engineer** creates real tasks and posts real comments for the
programme cohort. Everything else (`Overview`, `Tasks`, `Sessions`, `MCP config`) is
read-only, each call carrying `X-Admin-Secret`. The per-tab `writes` flag in
`oscar-admin/src/App.tsx`'s `NAV` array drives a subtitle so a user knows which page
can touch a customer's phone.

## Run

```bash
cd oscar-admin
npm install
npm run dev          # http://localhost:5174
```

**Port is 5174, not 5173** (updated 2026-10-02 — the old `5173` claim in this file was
stale). `oscar-admin/vite.config.ts` sets `port: 5174` with `strictPort: true`, so a
clash fails loudly instead of silently drifting to another port. 5174 is one of three
localhost origins in the backend's `CORS_ORIGINS` (5173, 5174, 3000) — any other port
dies in preflight with an opaque CORS error that looks nothing like the actual cause.

Open it, enter the backend URL and `ADMIN_SECRET` (or let `.env.local` fill them in —
see `oscar-admin/.env.local`), and the panel verifies the secret against
`/admin/overview` before letting you in.

## Backend URL resolution — fixed here first (2026-09-01)

`oscar-admin/src/lib/api.ts`'s `getBase()` resolves, in order: **`VITE_ADMIN_BASE`
(build-time env) → `localStorage` → a same-origin default** (`localhost:8000` when the
panel itself is served from localhost, else the deployed backend URL baked in as
`DEPLOYED_BASE`).

This panel is where that precedence bug was **found and fixed**, in
**`a5d4553` ("fix(admin): the configured backend wins, and stops being a question")**:
`getBase()` used to read `localStorage` FIRST, so a URL saved once (or carried over
from an earlier deployment) silently outranked the env var forever — the only symptom
was a connection error naming a host nobody had configured. The fix flipped the order
and, when `VITE_ADMIN_BASE` is set, hides the "use a different backend" field on the
login screen entirely (editing it would otherwise write a value `getBase()` now
ignores). **The web app (`Hello_Oscar`) shipped the identical bug later** — see the
backend repo's `CLAUDE.md`, "Browser clients: a deploy-time URL must WIN over a saved
one," which names this exact fix as precedent.

## Deploying it

🔴 **Branch to deploy: `Brand_new_admin_after_revamp`** — verified 2026-10-05, this is
the only branch with commits past 2026-09-05 (HEAD `62b95bf`) and the one actually
live at `hello-oscar-admin.vercel.app` (Vercel's own project settings pick the branch;
check there before assuming, per the "Vercel deploys the program console from this repo
too" note elsewhere in this file). `feat/program-console` (2026-09-01) is an ancestor
already merged into it; `feat/sarvam-voice` (2026-08-20, local-only, never pushed) and
`main` (2026-08-10, oldest) are both stale — do not deploy either.

Any static host (`npm run build` → `dist/`). One requirement: **add the deployed
origin to the backend's `CORS_ORIGINS`**, or the built site loads and every panel
shows a connection error.

Set `VITE_ADMIN_BASE` on the deploy so the field above resolves it correctly rather
than falling back to whatever `DEFAULT_BASE` hardcodes.

### `.env` vars a deploy needs

🔴 **Verified 2026-10-05 by reading `oscar-admin/.env.local` and grepping every
`import.meta.env.VITE_*` reference under `oscar-admin/src` directly** — not from
memory. All are `VITE_*` (Vite inlines them into the shipped bundle at build time —
nothing here is a server-side secret the browser can't already see):

| Var | Required for a deploy? | Purpose |
|---|---|---|
| `VITE_ADMIN_BASE` | **Yes, effectively** | Backend URL the panel calls. Wins over `localStorage` (see "Backend URL resolution" above) — without it, a deploy falls back to whatever `DEFAULT_BASE` hardcodes in `lib/api.ts`, which may not be the backend you want |
| `VITE_ADMIN_SECRET` | Optional | Pre-fills the admin secret at login so nobody has to type `ADMIN_SECRET` by hand. Omit it and the login form just asks |
| `VITE_PLATFORM_INVITE_CODE` | Optional | Auto-fills the `personal`-account gate code on the Create-login form (must match backend's `PLATFORM_INVITE_CODE`) |
| `VITE_SUPER_ADMIN_CODE` | Optional | Auto-fills the `team_lead`-account gate code (must match backend's `SUPER_ADMIN_PASS`) |
| `VITE_PROGRAM_TEAM_ID` | **Yes, if the Alumnx AI Engineer tab is used** | Which team/workspace that tab manages (local `.env.local` points it at `65`) |
| `VITE_CHAT_USER_ID` | Only for the voice spike | Which user id live-voice testing acts as — **local dev / voice-spike only, not needed for a normal panel deploy** |
| `VITE_BACKEND_URL` | Only for the voice spike | Separate from `VITE_ADMIN_BASE` — feeds the live-voice `/chat/stream` + `/ws` leg, not the admin REST calls. **Not needed unless deploying with voice features enabled** (voice tabs are currently removed from `NAV`, see below) |
| `VITE_SPIKE_LLM_URL` | No — local-only | Points at a local backend's `/spike/llm/oscar` (`ENABLE_VOICE_SPIKE=1`). Never set this in a real deploy |
| `VITE_SARVAM_KEY` | No — voice tabs are removed | Would be exposed in the bundle if set (Vite inlines `VITE_*`). Leave unset; the key currently in `.env.local` is for local experimentation only and must never ship to a public deploy |
| `VITE_SARVAM_SPEAKER`, `VITE_VAD_SILENCE_MS`, `VITE_WAKE_WORD`, `VITE_MIC_GATE`, `VITE_MIC_GATE_RMS` | No — voice tabs are removed | Dead for a current deploy; referenced only by voice-spike code paths not reachable from `NAV` today |

**Also required, on the backend side, not this repo:** the deployed panel's own origin
must be added to the backend's `CORS_ORIGINS` (see above), and the backend needs
`ADMIN_SECRET` set (gates every `/admin/*` route this panel calls).

**Currently live config** (`hello-oscar-admin.vercel.app`): `VITE_ADMIN_BASE` points at
`alumnxailabs-epa-3.onrender.com` — see the `epa-3` role-change warning below before
assuming that backend's data is dev-only.

## What it shows

| Tab | Endpoint(s) | Writes? | For |
|---|---|---|---|
| Overview | `GET /admin/overview` | no | counts (task/session totals; the photo→contact funnel reported here historically is **gone**, see below) |
| People | several `/admin/*` + `POST /notifications/test` | **yes** | user search, presence, push verification, org profile edit |
| Alumnx AI Engineer | programme-specific routes | **yes** | assign tasks to the cohort, read replies |
| Tasks | `GET /admin/tasks`, `GET /admin/tasks/{id}` | no | every task, filterable by team/user/status/date-range/title; click a row for the full audit trail (assignees, timeline, comments, notifications, attachments) |
| Sessions | `GET /admin/sessions`, `GET /admin/sessions/{id}/transcript` | no | session list + a drawer with the full transcript |
| MCP config | `GET /admin/mcp-config` | no | which org resolves to which MCP, **and from where** — db row, env var, or nothing |

## What changed — removed tabs (verified via `git log`, 2026-10-02)

**Photos & contacts, WhatsApp, and both Voice tabs (Sarvam + OpenAI Realtime) are
gone**, removed in **`06ea91c`** ("feat(admin): trim the panel to six tabs, add task
tracking and recent presence", 2026-09-01) on branch `Brand_new_admin_after_revamp`.
That same commit's Overview photo-funnel (progress bars, awaiting-details/
awaiting-contact badges, WhatsApp directory stat) was removed with them, and added
`Tasks` as a new tab backed by the then-new `GET /admin/tasks` route. **If you are
reading an older copy of this file that still lists Photos/WhatsApp/Voice as live
tabs, that copy predates 2026-09-01 and is wrong** — those features were deleted
upstream on the backend (see the backend repo's `CLAUDE.md`, "Photo → contact →
WhatsApp poster — REMOVED" and "AI-Managed WhatsApp — REMOVED") and this panel
followed.

🔴 **Presence is NOT a standalone tab — it lives inside People.** `06ea91c`'s own
message says "add task tracking and recent presence," and confirmed by grep
(2026-10-02): `oscar-admin/src/people.tsx` calls `GET /admin/presence?limit=100`
directly (comment there: "ordered by last_seen and omits anyone who has..."). There is
no `presence`/`teams` entry in the current `NAV` array (`overview`, `people`,
`program`, `tasks`, `sessions`, `mcp` only, per `oscar-admin/src/App.tsx`), and no call
to `GET /admin/teams` anywhere under `oscar-admin/src` — that route is documented on
the backend but this panel does not call it.

## 🔴 `epa-3` now serves REAL production traffic — this is a role change, not new info

**As of 2026-09-24**, per the backend repo's `CLAUDE.md` (dated today, 2026-10-02,
canonical): the Render service `AlumnxAILabs_epa-3` — the backend this panel is
deployed against at `hello-oscar-admin.vercel.app` — **is now the live deploy target
for `remove-rfq-from-oscar`**, confirmed directly by the project owner from the Render
dashboard. **It is NOT "just the admin panel's dev-DB backend" any more.** Any earlier
assumption in this repo's docs or code comments that `epa-3` / `oscar_dev` is isolated,
safe-to-poke, admin-only data should be treated as **historical and currently wrong**
until independently re-verified — the backend doc itself flags this as **not yet
re-confirmed via a live Render API call** (the Render MCP token was expired when that
note was written), so treat it as "the owner says so," not as independently audited.

**Practical consequence for anyone touching this panel:** actions in the People /
Alumnx AI Engineer tabs that write (push notifications, task creation, org-profile
edits) may now be touching **real user-facing data**, not a disposable dev copy.
Treat every write here with the same caution as a production action until this is
re-verified.

## Requires

`ADMIN_SECRET` set on the backend. Unset disables every admin route by design — this
backend has no auth, and these routes return phone numbers and chat transcripts.

The read-only endpoints live in the backend repo (`main.py`, `# ── Admin read API` —
9 routes total, see the backend's `CLAUDE.md` "Admin read API + panel" section for the
full list and their exact shapes). The write-capable routes used by People / Alumnx AI
Engineer are not part of that 9-route read-only set; check the backend repo directly
for their current shape before assuming they are documented there under "Admin read
API."
