# Deploying the web app to Vercel

This deploys **`apps/web` only** — the CRM half. Read §"What does not deploy"
below before you rely on it for anything.

PROMPT.md §3 specifies Docker Compose on a single VPS, "self-hosted, lead data
stays on the agency's hardware". Vercel plus a hosted Postgres is a deliberate
departure from that, chosen knowingly: lead data, contact details and consent
records leave the agency's hardware and live on Vercel's and Neon's. That is a
decision about where regulated personal data sits, not a deployment detail, and
it is written here rather than left implicit (§13).

---

## What does not deploy, and what the app says about it

`apps/agent` cannot run on Vercel. It holds a Postgres session advisory lock for
its lifetime, ticks every fifteen seconds looking for due messages, and keeps an
IMAP IDLE socket open. None of those survive in a function that lives for a
second and is frozen between requests.

So on Vercel, with `AGENT_URL` left unset:

| works | does not |
|---|---|
| companies, scans, findings, scores | the chat panel (says "not configured") |
| contacts, consent, suppressions | sending anything at all |
| the pipeline board, meetings, briefs | reply detection |
| proposals generated from findings | voice and SMS (Phase 6, unbuilt) |
| the public booking page | |

`apps/web/src/lib/deployment.ts` is what makes that honest rather than silent:
every screen that would otherwise promise a send asks it first, and says
plainly that no worker is connected. Leave `AGENT_URL` **unset** — setting it
to something unreachable makes the UI say "unreachable" instead, which is a
worse lie.

To get the missing half, host `apps/agent` somewhere with long-lived processes
(Fly.io, Railway, or the VPS the spec actually asks for) against the same
database, and set `AGENT_URL` and `AGENT_INTERNAL_TOKEN` in Vercel. Note that
the worker needs the **direct**, non-pooled connection string: its advisory
lock is session-scoped and does not survive transaction-mode pooling.

---

## One-time setup

Everything in this section touches a credential, so **you run it, not the
assistant.** Nothing here should ever be pasted into a chat, a source file, or
a commit (§2.3).

### 1. Neon

Create a project. Copy **two** connection strings from the dashboard:

- the **pooled** one (host contains `-pooler`) — this is `DATABASE_URL` for Vercel;
- the **direct** one — use it for migrations, and later for the worker if you
  add one.

Append `?sslmode=require` if it is not already there.

### 2. Migrate and seed, from your machine

```bash
DATABASE_URL='<the DIRECT neon url>' npm run db:migrate
DATABASE_URL='<the DIRECT neon url>' SEED_OWNER_EMAIL='<your address>' npm run db:seed
```

Seeding is not optional. There is no signup flow (§1): `auth.ts` refuses any
address that does not already have a `users` row, so without this nobody can
ever sign in — including you.

### 3. Resend

Create an account, verify a sending domain, and make an SMTP credential. You
will set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` and `MAIL_FROM`
in Vercel. `MAIL_FROM` must be on the domain you verified, or the magic links
will be rejected by the recipient's mail server rather than by Resend.

### 4. Vercel

Already done: the project `agency-os` exists and this repo is linked to it, and
a preview deployment has been built and served, so the build pipeline itself is
proven. **Root Directory stays at the repo root** — do not set it to `apps/web`.

That is the opposite of the usual monorepo advice, and it was settled by trying
both. `vercel.json` at the repo root carries `buildCommand: npm run
build:vercel` and `outputDirectory: apps/web/.next`, because `packages/core` and
`packages/db` are consumed as compiled `dist/` output and `next build` alone
does not produce it.

Deploying from `apps/web` fails. npm workspaces hoist `node_modules` to the
repo root, the build traces files at repo-root-relative paths, and the CLI then
resolves them under `apps/web`, where there is no `node_modules`:

    Error: ENOENT ... apps/web/node_modules/@swc/helpers/...

### 4a. A warning about building locally

**A local `vercel build` traces your `.env` into the deployment output.** It was
caught here by `.vercelignore`, which refuses to upload it — and the deploy then
fails on the dangling reference rather than shipping the file. Verified: with
real env files present, the traced set was `['.env', '.env.example',
'.env.local']`; with them moved aside, `['.env.example']`.

`.env` on this machine holds a live `ANTHROPIC_API_KEY` and `SECRETS_KEY`, so
this is a credential-exfiltration path, not a build quirk (§2.3). Two
consequences:

- **never remove `.vercelignore`**, and
- prefer **git-connected deploys**, where the problem cannot arise: `.env` is
  gitignored, so Vercel's builder never sees one. Connect the repo in the
  dashboard and this whole section stops mattering.

If you must deploy from this machine, move the env files aside first:

```bash
# apps/web/.env is a SYMLINK to ../../.env, so do NOT mv all three into one
# directory: the link's basename collides with the real file and clobbers it.
BAK=$(mktemp -d)
mv .env "$BAK/root.env"
mv .env.local "$BAK/root.env.local"
[ -L apps/web/.env ] && rm apps/web/.env   # -L, not -e: -e follows a link that
                                           # now dangles and answers false

npx vercel build --yes --target production
npx vercel deploy --prebuilt --prod --archive=tgz

mv "$BAK/root.env" .env
mv "$BAK/root.env.local" .env.local
ln -s ../../.env apps/web/.env
```

Check the trace before deploying, rather than trusting `.vercelignore` to have
caught it:

```bash
grep -ro '"\.env[^"]*"' .vercel/output/functions | sort -u   # .env.example only
```

### 5. Environment variables

Set these in **Project Settings → Environment Variables**, yourself:

| variable | value |
|---|---|
| `DATABASE_URL` | the **pooled** Neon URL, with `?sslmode=require` |
| `DATABASE_POOL_MAX` | `1` — see below |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_URL` | your production URL, e.g. `https://agency-os.vercel.app` |
| `SMTP_HOST` | Resend's SMTP host |
| `SMTP_PORT` | `587` |
| `SMTP_USER` / `SMTP_PASSWORD` | the Resend credential |
| `MAIL_FROM` | `Agency OS <noreply@your-verified-domain>` |

Leave **unset**: `AGENT_URL`, `AGENT_INTERNAL_TOKEN` (no worker),
`INBOUND_WEBHOOK_SECRET` (so `/api/inbound/email` keeps failing closed),
`ANTHROPIC_API_KEY` (the web app never calls the model; only the worker does).

**`DATABASE_POOL_MAX=1` matters.** Each serverless instance keeps its own pool,
and they do not share. At the default of 10, a few concurrent instances
exhaust a small Neon plan's connection limit, and the pool then waits — the
code now caps that wait at ten seconds so it fails with a real message instead
of hanging until the function is killed, but the fix for exhaustion is a small
per-instance pool plus the pooled connection string.

`AUTH_URL` has no safe default. Auth.js reads it directly when it builds the
magic-link URL, and without it falls back to the request's `Host` header —
which lets a forged header decide where a sign-in link points.

### 6. Deploy

Once the variables above are set, promote to production:

```bash
npx vercel --prod
```

A preview deployment already exists and returns 302 to a Vercel login — that is
Deployment Protection on previews, not an application error. Production is
public by default; check that in **Settings → Deployment Protection** before you
share the URL.

---

## Every deploy after the first: migrate FIRST

The app and the database ship separately here, so the order matters and it is
always the same one: **apply the migrations, then deploy the app.** A schema
that is ahead of the code is harmless — nothing reads the new column. Code
that is ahead of the schema is a live error page.

0016 is the concrete example. It adds `linkedin` to `suppressions.kind`, and
the suppressions form now offers it; deploying that against a database still
holding the old CHECK gives an operator an error the moment they try to record
an opt-out — the worst possible place for one.

```bash
./tools/remote-setup.sh
```

The same prompt-based script as the first-time setup. It asks for the DIRECT
(unpooled) connection string, applies whatever is pending, re-runs the
idempotent seed, and prints what the database now holds. Then deploy.

Check what is pending before and after, if you want to see it:

```bash
npm run db:migrate -- status
```

(that one needs `DATABASE_URL` in your environment, so for the remote database
prefer the script.)

## After the first deploy

1. Sign in at `https://<your-url>/signin` with the seeded owner address and
   check the link arrives. If it does not, the problem is Resend or
   `MAIL_FROM`, not the app — `/api/health` will still be green.
2. Open `/` and confirm the dashboard's banner says the worker is not
   connected. If it does not, `AGENT_URL` is set and should not be.
3. Set the org's booking slug if you want the public page:
   `UPDATE orgs SET booking_slug = 'agency' WHERE …`, then check
   `/book/agency` loads for a signed-out browser.

## Scanning, once deployed

`npm run scan` is a CLI, not a service — on Vercel nothing runs it, so a
freshly deployed instance has companies with no scores, no findings, and
"Generate proposal" refused for want of evidence. That is not a gap in the
deploy; it is where the scanner lives. Run it from your machine against the
same database:

```bash
DATABASE_URL='<the DIRECT neon url>' npm run scan            # everything unscanned
DATABASE_URL='<the DIRECT neon url>' npm run scan -- --all   # re-scan
```

It reads public pages only, from wherever you run it, and writes findings to
the database the deployed app reads. Same for `npm run db:seed` and the CSV
import.

## The public surface, and what is not protected

`apps/web/src/proxy.ts` exempts `/signin`, `/api/auth`, `/api/health`,
`/api/inbound`, `/book` and `/api/book` from the session gate. On a laptop that
was theoretical. On a public URL it is not:

- **`/api/book/[slug]`** writes to the database without authentication. It is
  hardened — a booking may create records and may never modify one it did not
  create (see `packages/db/src/booking.ts`) — but it is still an open write
  endpoint, and a bored stranger can fill the meetings table with junk. Every
  such row is flagged `needs_review`.
- **`/api/health`** is unauthenticated and queries the database on every call.
- **`/api/auth`** lets an anonymous caller create `verification_tokens` rows for
  any address. They grant nothing and expire in 15 minutes, but nothing prunes
  them and each one attempts to send mail only for real members.

CLAUDE.md §4 says rate limiting "belongs at the reverse proxy in front of the
VPS". On Vercel there is no reverse proxy you control, so that sentence has no
owner any more. Turn on Vercel's WAF / rate limiting for `/api/book` and
`/api/auth`, or accept that these are open.
