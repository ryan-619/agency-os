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

| works with no worker | does not |
|---|---|
| companies, findings, scores, scan history and the findings diff | the chat panel (says no worker is connected) |
| the nightly rescan of never-scanned and stale companies — needs `CRON_SECRET` | sending **email** — the worker's tick is its only sender |
| contacts, the consent ledger, suppressions, contact import, a person's record and erasure | reading replies from a mailbox (IMAP) |
| the pipeline board and analytics, meetings and their outcomes, `.ics` downloads, briefs | the one-click unsubscribe **header** — the worker writes it into each email it sends |
| proposals, print and Markdown export, a buyer's share link | voice and SMS (Phase 6: built, deliberately not switched on) |
| the inbox, tasks, notes, compliance, the audit log, search, CSV exports, every settings page | |
| **LinkedIn steps** — a person sends from their own account, and `/tasks` runs every send rule first | |
| **replies**, once Resend receiving is set up — `RESEND_WEBHOOK_SECRET` + `RESEND_API_KEY` | |
| **Slack** notifications and the daily digest — `SLACK_WEBHOOK_URL` (the digest also needs `CRON_SECRET`) | |
| the public booking page, the unsubscribe page, the buyer's proposal page | |

`apps/web/src/lib/deployment.ts` is what makes that honest rather than silent:
every screen that would otherwise promise a send asks it first, and says
plainly that no worker is connected. Its flags are configuration only — is
`AGENT_URL` set, `CRON_SECRET`, `SLACK_WEBHOOK_URL`, `UNSUBSCRIBE_SECRET`, an
inbound webhook secret — and **Settings → Deployment** shows each by name
beside what the worker's heartbeat actually says. Leave `AGENT_URL` **unset** —
setting it to something unreachable makes the UI say "unreachable" instead,
which is a worse lie.

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
Never set `VERCEL_ENV` — the platform does, and the cron routes read it.

**Optional — leave each unset until the feature that reads it is configured.**
Every one fails closed: unset, its feature is off, the screens that depend on
it say so, and nothing else changes. The web app reads a BLANK value as unset,
so a copied `.env.example` cannot stop it booting; a present value of the wrong
shape is refused at boot, with a message that names the variable and never
the value.

| variable | turns on | unset |
|---|---|---|
| `CRON_SECRET` | the two daily crons (see "Scheduled jobs on Vercel"). `openssl rand -hex 32`, at least 32 characters, **Production only** | `/api/cron/*` answers 503; nothing is rescanned and no digest is built |
| `RESCAN_BATCH_SIZE` | companies per org per nightly rescan, 1–20 | `6` |
| `SLACK_WEBHOOK_URL` | posts to one Slack channel: a recorded reply (not a provider's retry of one), an accepted booking, a deal moved to won or lost on the board, a proposal accepted, an opt-out that could not be recorded, the daily digest, a silent worker. Ids, the company's domain and a link — never a name, an address or a body. Must be `https://hooks.slack.com/…`; the URL is the credential and is never logged | nothing is posted; the digest is still recorded in the audit log |
| `UNSUBSCRIBE_SECRET` | verifying a one-click unsubscribe at `/api/unsubscribe/<token>`. **The same value on the worker**, which mints the links | `/api/unsubscribe` answers 503 — and logs `OPT-OUT NOT RECORDED` for a well-formed token, because a worker holding the secret minted it |
| `RESEND_WEBHOOK_SECRET` | replies through Resend (see "Replies through Resend"): the endpoint's `whsec_…` signing secret | `/api/inbound/resend` answers 503 |
| `RESEND_API_KEY` | the same route's fetch of each received message — a key that can READ received email | `/api/inbound/resend` answers 503 |
| `SECRETS_KEY` | storing a connector's credential (Settings → Connectors) and re-entering one (Settings → Credentials). **The same value on the worker** | both refuse with 503; Settings → Deployment reads "not set", or "set, not a valid key" |

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

## Scheduled jobs on Vercel

`vercel.json` declares two crons. Each is a `GET` from Vercel's scheduler to a
route in the web app, and neither needs the worker.

| path | schedule (UTC) | what it does | ceiling |
|---|---|---|---|
| `/api/cron/rescan` | `17 3 * * *` | re-scans up to `RESCAN_BATCH_SIZE` companies per org — never-scanned first, then the oldest stale scan — through the same `recordScan` the CLI uses | `maxDuration = 300` |
| `/api/cron/digest` | `43 6 * * *` | builds the daily digest, posts it to Slack when `SLACK_WEBHOOK_URL` is set, then posts a separate alert if the worker has gone silent | `maxDuration = 60` |

Both at minutes off the hour, because most schedules run at `:00`.

**Turning them on.** Create the secret with `openssl rand -hex 32` and add it as
`CRON_SECRET` in Project Settings → Environment Variables, for **Production
only**, marked sensitive. Then redeploy: cron configuration and the variable
are both read from a deployment. Vercel sends the value as `Authorization:
Bearer <CRON_SECRET>` on every cron call, and every cron route goes through
one gate (`apps/web/src/lib/cron-auth.ts`):

| request | answer |
|---|---|
| `CRON_SECRET` unset | 503, and nothing runs |
| no bearer, or the wrong one | 401 |
| the right bearer, but `VERCEL_ENV` is not `production` | 403 `not_production` — a preview shares the production database |
| the right bearer, in production | the run |

**Two platform requirements, neither optional:**

- **Fluid Compute must be on** for the project (Settings → Functions). It is
  the default for projects created since 23 April 2025; without it Hobby stops
  a function at 60 s and the rescan would dispatch nothing past its first
  minute. The rescan's whole deadline is computed against `maxDuration = 300`.
- **A Pro plan.** Hobby allows a cron once a day, within ±59 minutes of its
  schedule, which these two would survive — but Vercel's fair-use terms
  restrict Hobby to non-commercial personal use, and an agency's sales tool is
  commercial. Pro also runs a cron within its minute and keeps runtime logs for
  a day instead of an hour.

**Run one by hand**, because the dashboard's Run control may not carry the
secret. Put `CRON_SECRET` in your shell from your password manager — never
into a chat or a file:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/rescan
curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/digest
```

**What they answer, and where to read it afterwards.** Runtime logs are kept
for an hour on Hobby, so each run records itself in the audit log — `/audit`,
under "Scheduled rescans" and "Scheduled jobs":

- The rescan answers `{ orgs: [...] }`: per org `picked`, `scanned`,
  `unreachable`, `skipped`, `remaining`, `elapsedMs` and `stoppedBy` (`done`,
  `batch` or `budget`; `batch` night after night means raise
  `RESCAN_BATCH_SIZE`). An org with no usable ICP is `notRun`. An org whose run
  threw is `failed: <ErrorClass>` and makes the whole answer a 500, so the
  platform's cron log shows it. The audit row is `scan.cron_run`.
- The digest answers `{ posted, why?, orgs: [...] }` and writes `cron.digest`
  whether or not it posted. It is idempotent on a 20-hour window: an org with
  a `cron.digest` row in the last 20 hours is skipped, and duplicate
  deliveries serialise on a transaction-scoped advisory lock, so one message
  is sent. A failed Slack post is recorded and not retried until the next
  day's run. With no `SLACK_WEBHOOK_URL` nothing is fetched and the answer is
  200 with `posted: false, why: 'no_slack'`.

**The rescan is not a scan button.** Nobody clicks it, and a person still scans
one company with `npm run scan -- <domain>`. It never picks a `*.inbound`
company — the booking page's placeholder named after a person — because
scanning it would send somebody's email address out as a DNS lookup every
night.

**The alert that the worker is silent comes from here, not from the worker**,
because a silent worker cannot report itself. When a worker is configured
(`AGENT_URL`) and the newest heartbeat is older than max(600 s, three of that
worker's own ticks) — or there is none — the digest run posts a separate
message after the digest, so it is the newest in the channel. It is checked
once a day, because that is how often the cron runs. With no Slack, the
`cron.digest` row is highlighted in `/audit` instead.

---

## A sending domain, and why outreach needs one

Nothing in Phase 4 reaches an inbox without it. SPF, DKIM and DMARC are how
a receiving server decides that mail claiming to be from you really is, and
an unauthenticated cold email from a new domain is filtered before anyone
reads a word of it. This matters more than the model, the host, or anything
else outstanding.

```bash
./tools/mail-dns.sh
```

asks for the domain and prints the `vercel dns add` commands, generates the
DMARC record, and gives the order to do it in.

**Vercel covers the DNS, not the sending.** Point the domain's nameservers
at Vercel and the TXT records live there happily. What Vercel cannot be is
the domain itself: a `*.vercel.app` subdomain has no DNS you control, so
there is nowhere to publish a DKIM key, and the apex is shared by millions
of deployments whose reputation is not yours to build. Vercel is also not a
mail sender — Resend is, on a free tier of 3,000/month.

**Use a SUBDOMAIN for outreach** (`outreach.example.com`, not the apex).
Cold email that goes badly damages the reputation of whatever domain sent
it; a subdomain keeps that away from the address the team actually uses.

**The script does not invent your SPF and DKIM values**, and that is
deliberate. Resend generates a DKIM key per domain and its SPF include
depends on the sending region, so both are copied from its dashboard
verbatim. A guessed DKIM key is not a typo — it is a domain that fails
authentication silently, which is the failure this whole exercise exists to
avoid.

**`p=none` first, always.** A `p=reject` published on day one with SPF or
DKIM slightly wrong bounces every message you send, and you learn about it
from silence rather than from an error. Monitor for a fortnight, confirm
`spf=pass`, `dkim=pass`, `dmarc=pass` in a real message's headers, then
tighten.

**And warm it up.** A domain with no history that starts at fifty a day
looks like a compromised account. 5/day in week one, 40 by week four, using
the campaign's `dailyCap` — a setting, not a code change, but the difference
between a domain that works in a month and one burned in a week.

## Replies through Resend (no worker needed)

With no worker, nothing reads a mailbox — so nothing can learn that somebody
replied, and the inbox, the pause-on-reply rule and the reply opt-out all wait
for one. Resend can receive the mail instead and post it to the web app:

1. In Resend, turn on **receiving** for a subdomain (for example
   `replies.myagencyos.in`) and add the MX record it shows, copied exactly.
2. Add a webhook endpoint for the **`email.received`** event at
   `https://<host>/api/inbound/resend`.
3. In Vercel, for Production and marked sensitive: `RESEND_WEBHOOK_SECRET`
   (that endpoint's `whsec_…` signing secret) and `RESEND_API_KEY`.
4. Redeploy, reply to a message from a contact's address, and look in `/inbox`.

The route answers 503 until BOTH are set, and also when the secret is not a
`whsec_` secret (logged at error).

**The key must be able to READ received email.** The key behind the magic links
is probably sending-only. A 401 or 403 from the receiving API is logged with a
hint saying so, and until the key is replaced every delivery is answered 502
and Resend keeps retrying it.

**The route is a reader and nothing else.** It verifies the Svix signature (an
in-repo verifier, pinned to Svix's published test vector), fetches the message,
and hands it to the same `handleInboundEmail` the IMAP listener and
`/api/inbound/email` use — one matcher, one opt-out reader. It can send
nothing.

**Its status codes are decisions about retrying.** A message that could not be
fetched gets 502 and a recording failure 500, so Resend retries both;
everything the route did read — a non-match, a message with no sender — gets
200. The generic `/api/inbound/email` answers 200 either way. This one does
not, because a 2xx for a message nobody read could swallow a "stop".

Two limits, stated rather than discovered:

- **Check with one real reply whether the fetched headers carry
  `In-Reply-To`/`References`.** If they do not, only address matching can file
  a reply: the From address has to be on exactly one contact across every org.
  On a worker-less deployment nothing sends email, so there is usually no
  outbound Message-ID to match by anyway.
- **A bounce that arrives this way is never recognised as a bounce.** The
  receiving API lists attachments without their contents, so the delivery
  report is unavailable and the contact is not marked bounced. Most reporting
  servers mark the report `Auto-Submitted`, which files it as an auto-reply
  that pauses nobody; one that does not is filed as a reply.

## Running the worker on your own machine

The deployment for an agency that has not rented a server yet, and less of a
compromise than it sounds — because of an asymmetry worth understanding
before choosing anything else:

| what the worker does | direction | needs a public address? |
|---|---|---|
| sends queued outreach | out, to SMTP + Postgres | **no** |
| detects replies (IMAP) | out | **no** |
| recovers stuck sends, expires approvals | out | **no** |
| sweeps expired sign-in links | out | **no** |
| answers the chat panel | **in**, from the web app | yes |

`AGENT_URL` is read by exactly one thing — `apps/web/src/lib/agent.ts`, which
calls `/internal/turns`, the interrupt route and the connector probe. Every
other job is this worker reaching out. So:

```bash
./tools/run-worker.sh
```

asks for the production connection string at a hidden prompt and runs the
worker against Neon with **nothing on the machine exposed** — no port open, no
tunnel, no inbound route. The chat panel keeps saying no worker is connected,
which is true.

It then asks whether to configure **sending** (SMTP) and **reply detection**
(IMAP), and this is not optional paperwork. The worker treats all of those
variables as optional and boots cleanly without them, running only the
recovery jobs: `apps/agent/src/index.ts` gates the sender on
`SMTP_HOST && MAIL_FROM` and the inbox on
`IMAP_HOST && IMAP_USER && IMAP_PASSWORD`. Skip both prompts and you get a
worker that reports itself healthy while approved mail sits in the queue
forever and no reply is ever read. The boot log's `outreach: <mode>` line is
the authority — `disabled`, `send-only` or `send-and-receive`.

Closing the tab stops it. Queued mail then waits for the next run rather than
being lost — `touches` rows keep their status, and `recoverStuckSends` settles
anything caught mid-send on the next boot.

**The laptop sleeping is the real caveat**, and it is a scheduling one rather
than a correctness one: quiet hours and the daily cap are evaluated at the
moment of sending, so mail queued for 09:00 while the lid was shut goes out
when the worker next runs and is re-checked against every §2.1 rule first.
Nothing is sent that should not be; it is sent later than intended. `caffeinate
-dis ./tools/run-worker.sh` keeps the machine awake for as long as it runs.

### Giving other people access

There is no signup flow (§1): `users.org_id` is NOT NULL with no default, so
Auth.js's adapter cannot create a user, and the sign-in callback refuses any
address without a row *before* any mail is sent. Access is granted in the
database:

```bash
./tools/add-teammate.sh
```

It folds the address to lower case before writing, which is not cosmetic —
@auth/core folds the sign-in identifier before any lookup and the adapter then
matches `users.email` exactly, so a row stored as `Priya@Agency.com` is
invisible to it and the person is locked out with an opaque error. Re-running
for somebody who already has access says so and changes nothing.

They then sign in at the live site with a magic link. Nothing needs sending by
hand — tell them the address to type at `/signin`.

**Settings → Team** (`/settings/team`, owners only) does the same from the
browser, and more: it grants access, changes a role, and REVOKES access without
deleting anybody. Granting sends no mail — the person asks for a link at
`/signin`, like everyone else. Revoking ends that person's sessions at once and
is checked again on every request and every chat turn; the history they wrote
keeps their name. `./tools/add-teammate.sh` stays, for the first owner and for
a database nobody can sign in to yet.

### If you do want chat on the live site

That is the one feature needing an inbound route, and it changes the picture
in two ways worth deciding deliberately rather than discovering:

1. **Your machine becomes internet-reachable.** A tunnel
   (`cloudflared tunnel --url http://127.0.0.1:3002`) publishes the internal
   API. It is bearer-token gated, and `/livez` and `/readyz` on that port are
   not — they would answer anyone. Set `AGENT_URL` and the SAME
   `AGENT_INTERNAL_TOKEN` in Vercel, and note a quick tunnel's URL changes
   on every restart, so each restart means updating Vercel and redeploying.
2. **Every teammate's chat turn runs on whatever credential that worker
   holds.** With `ANTHROPIC_API_KEY` that is a bill. With
   `AGENT_USE_LOCAL_LOGIN` it is one person's personal subscription backing a
   service other people use — which is what `loadEnv`'s production refusal is
   about, and why `run-worker.sh` sets `NODE_ENV=production` and does not
   offer the flag.

Chat against your own login, on your own machine, against your own data is a
different thing from that, and is what the local development path is for.

## The worker, on Fly.io

`fly.toml` at the repo root deploys `apps/agent`. Read its header before
changing anything in it: Fly's defaults scale a machine to zero between
requests, which is Vercel's problem wearing a different hat — the advisory
lock drops, the fifteen-second tick stops, queued mail sits unsent, and
nothing looks broken because `/readyz` answers fine on a machine that was
just woken up. `auto_stop_machines = "off"` and `min_machines_running = 1`
are the load-bearing lines.

```bash
fly launch --no-deploy --copy-config     # once; keeps this fly.toml
fly secrets set DATABASE_URL='...'       # the DIRECT, unpooled string
fly secrets set AGENT_INTERNAL_TOKEN='...'
fly deploy
```

**Only two secrets are required**: `DATABASE_URL` and `AGENT_INTERNAL_TOKEN`.
Everything else turns a feature on, and the worker says which at boot.

| secret | what it turns on | without it |
|---|---|---|
| `DATABASE_URL` | everything | refuses to boot |
| `AGENT_INTERNAL_TOKEN` | the web app may call it | refuses to boot |
| `ANTHROPIC_API_KEY` | chat | `chat_disabled`; **everything else still runs** |
| `SECRETS_KEY` | connectors with credentials | those connectors are skipped, with a reason |
| `SMTP_HOST`, `MAIL_FROM`, `SMTP_*` | sending | `outreach: disabled` |
| `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD` | reply detection | `outreach: send-only` — replies never pause a sequence |
| `UNSUBSCRIBE_SECRET` | the RFC 8058 one-click `List-Unsubscribe` header on every email. **The same value as Vercel's** | no header, and one warn line at boot — `unsubscribe: headers off`, naming the missing variable (logged only when SMTP is configured) |
| `WEB_PUBLIC_URL` | where that header's link points: the web app's public https origin, e.g. `https://myagencyos.in` | as above — the header needs both |
| `OUTREACH_BOUNCE_PAUSE_PCT` | the hard-bounce rate past which an email campaign pauses itself — over 30 days, once it has written to at least 20 people. `100` turns it off | `5`. The boot log says `bounce auto-pause: on` |

After an automatic pause the bounce window restarts, so a person re-activating
the campaign is not paused again by the same addresses. A bounce is never a
suppression: it marks the address, and email to it stops until somebody
corrects it.

**Each worker writes a heartbeat** — one `worker_heartbeats` row, keyed
`hostname:pid`, upserted every `OUTREACH_TICK_MS`. A machine Fly has scaled to
zero therefore shows up as a growing `worker.ageSeconds` in `/api/health`
rather than as a queue somebody eventually notices has stopped moving.

**`DATABASE_URL` must be the DIRECT, non-pooled string.** The worker's
single-instance lock is session-scoped and does not survive transaction-mode
pooling — under the pooler two workers both believe they hold it.

Then point the web app at it, in Vercel:

```bash
vercel env add AGENT_URL production          # https://agency-os-agent.fly.dev
vercel env add AGENT_INTERNAL_TOKEN production   # the SAME value as above
```

and redeploy the web app. Until both are set, every screen that would promise
a send says no worker is connected, which is the honest state. **Do not set
`AGENT_URL` to something unreachable** — the UI then says "unreachable"
instead of "not configured", which is a worse lie.

### A worker with no model is still worth deploying

`ANTHROPIC_API_KEY` is optional, and the half of the worker that needs no
model is the half that does the irreversible work: the outreach tick and the
single send path, reply detection, `recoverStuckSends`, the restart
reconciler, the approval sweeper, and the expired sign-in token sweep §4 asks
for. Deploy it without a key and the product gains everything except the chat
panel, which reports `chat_disabled` until one exists.

### What a Claude subscription cannot do here

`AGENT_USE_LOCAL_LOGIN` is refused when `NODE_ENV=production`, and that is
not an oversight to work around. It authenticates as a PERSON: the credential
is one human's, created by an interactive browser flow no container has, and
metered against a window meant for one person working at a keyboard. A shared
service standing behind it cannot be billed, rate-limited, audited or revoked
apart from them (§2.3).

`claude setup-token` does mint a long-lived token from a subscription, so the
mechanism exists. It is still the wrong thing to put in a server's
environment, for every reason above, and the guard stays. The supported split
is: **the worker on Fly does the deterministic work with no model, and chat
runs locally against a developer's own login** — which is what a personal
subscription is for.

## Every deploy after the first: migrate FIRST

The app and the database ship separately here, so the order matters and it is
always the same one: **apply the migrations, then deploy the app.** A schema
that is ahead of the code is harmless — nothing reads the new column. Code
that is ahead of the schema is a live error page.

0016 is the concrete example. It adds `linkedin` to `suppressions.kind`, and
the suppressions form now offers it; deploying that against a database still
holding the old CHECK gives an operator an error the moment they try to record
an opt-out — the worst possible place for one.

**0018 is the current one, and the widest.** It adds `findings.scored`, which
every company page reads first, and the tables and columns behind `/inbox`,
`/tasks`, `/contacts` and the dashboard. Code deployed ahead of it boots,
serves `/signin`, and answers each of those pages with a 500. The release, in
order — GO-LIVE.md has the same steps as a runbook:

1. **Apply 0018 before deploying the code** — `./tools/remote-setup.sh` below,
   or `npm run db:migrate` against the DIRECT string. `./tools/remote-status.sh`
   then prints `findings.scored: boolean, nullable=NO   <- 0018 is applied`.
2. **Set only the new variables you want** — every one optional and failing
   closed: `CRON_SECRET` and `RESCAN_BATCH_SIZE` (the crons), `SLACK_WEBHOOK_URL`,
   `UNSUBSCRIBE_SECRET` (Vercel AND Fly, one value) with `WEB_PUBLIC_URL`
   (Fly), `RESEND_WEBHOOK_SECRET` + `RESEND_API_KEY` (replies with no worker),
   `OUTREACH_BOUNCE_PAUSE_PCT` (Fly), `SECRETS_KEY` (the credentials page). §5
   and the Fly table above say what each does unset.
3. **If you set `CRON_SECRET`: confirm Fluid Compute is on and the project is on
   Pro** — see "Scheduled jobs on Vercel".
4. **Deploy.**
5. **Verify**: `curl -s https://<host>/api/health` reads `schema.state: "ok"`
   with `applied: "0018"`; open **Settings → Deployment**; and run a cron by
   hand with the bearer, then read its `/audit` row.

**Existing agents do not pick up the new tool grants.** The seed inserts
`agent_defs` with `ON CONFLICT (org_id, slug) DO NOTHING`, so re-running it
changes nothing about a subagent that already exists — it only shapes a NEW
database. To give the live qualifier, researcher and closer their new tools
(`get_scan_history`, `get_evidence_changes`, `check_send`, `get_consent`,
`get_company_timeline`, `search_crm`, `get_replies`, `classify_reply`,
`add_note`, `create_task` — `packages/db/seed/agents.json` lists which agent
gets which, each as `mcp__agency__<tool>`), edit each in **Settings → Agents**. Nothing breaks if you do not: a tool missing
from a subagent's list is simply one it cannot call.

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

0. Open **Settings → Deployment** (`/settings/deployment`) first. It answers
   "why would nothing send?" from the worker's heartbeat, shows the schema
   state exactly as `/api/health` computes it, and lists which variables are
   set — by name, never a value.
1. Confirm the deployment agrees with its database, before anything else:

   ```bash
   curl -s https://<your-url>/api/health | python3 -m json.tool
   ```

   `schema.state` must be `ok`. `behind` means the migration has not been
   applied and features will fail one at a time as people reach them — run
   `./tools/remote-setup.sh` and check again. `unknown` means the database has
   never been migrated at all. Note the endpoint returns **200** either way,
   on purpose (CLAUDE.md §4 has the reason); `?strict=1` turns a disagreement
   into a 503 if you want to gate a script on it.

   Read `worker` in the same answer. `worker.status` is `live`, `silent` (not
   heard from for more than max(600 s, three of the worker's own ticks)),
   `never` (a worker is configured and none has ever written a row) or
   `not_configured` (no row, and no `AGENT_URL`/`AGENT_INTERNAL_TOKEN` here);
   `worker.ageSeconds` is how long ago the newest heartbeat landed. A live row
   reads `live` even where this deployment has no `AGENT_URL` — a worker
   writing to the database is an observation, and it beats configuration.
   `worker: null` with a `workerError` means the table could not be read —
   almost always 0018 not applied, which `schema` will already say. None of
   this changes the status code, not even under `?strict=1`: strict asks
   whether THIS deployment agrees with its database, not whether another
   process is alive.

2. Sign in at `https://<your-url>/signin` with the seeded owner address and
   check the link arrives. If it does not, the problem is Resend or
   `MAIL_FROM`, not the app — `/api/health` will still be green.
3. Open `/` and confirm the dashboard's worker line says no worker is
   configured. If it does not, `AGENT_URL` is set and should not be — unless
   a worker really is writing heartbeats, in which case it says so.
4. Set the org's booking slug if you want the public page:
   `UPDATE orgs SET booking_slug = 'agency' WHERE …`, then check
   `/book/agency` loads for a signed-out browser.

## Scanning, once deployed

`npm run scan` is a CLI, not a service. On Vercel the one thing that scans is
the nightly rescan cron, once `CRON_SECRET` is set: it takes never-scanned
companies first, `RESCAN_BATCH_SIZE` a night, so sixteen seeded companies at
the default six are all scanned by the third night. Until then — or to do
everything now — a freshly deployed instance has companies with no scores, no
findings, and "Generate proposal" refused for want of evidence. That is not a
gap in the deploy; it is where the scanner lives. Run it from your machine
against the same database:

```bash
DATABASE_URL='<the DIRECT neon url>' npm run scan            # everything unscanned
DATABASE_URL='<the DIRECT neon url>' npm run scan -- --all   # re-scan
```

It reads public pages only, from wherever you run it, and writes findings to
the database the deployed app reads. Same for `npm run db:seed` and the CSV
import.

## The public surface, and what is not protected

`apps/web/src/proxy.ts` exempts `/signin`, `/api/auth`, `/api/health`,
`/api/inbound`, `/book`, `/api/book`, `/api/cron`, `/api/unsubscribe`,
`/unsubscribe`, `/p` and `/api/p` from the session gate. A prefix matches only
a whole path segment, so `/p` does not exempt `/pipeline` or `/proposals`, and
`apps/web/test/proxy.test.ts` pins the lookalikes. Every exempt route that
does anything authenticates the request itself, inside its handler. On a
laptop that was theoretical. On a public URL it is not:

- **`/api/book/[slug]`** writes to the database without authentication. It is
  hardened — a booking may create records and may never modify one it did not
  create (see `packages/db/src/booking.ts`) — but it is still an open write
  endpoint, and a bored stranger can fill the meetings table with junk. Every
  such row is flagged `needs_review`. Each accepted booking also posts one
  Slack message when `SLACK_WEBHOOK_URL` is set — one outbound request per
  accepted row, bounded by the same WAF rule; a refused booking posts nothing.
- **`/api/health`** is unauthenticated and queries the database on every call.
  It also reports which migration the database is at, which is a small piece of
  fingerprinting given away to anyone who asks. That is a deliberate trade: the
  alternative is that nobody can verify a deploy without holding the production
  connection string, and a migration number names no column, no table and no
  software version. If you would rather not publish it, put Vercel's WAF in
  front of the route — do not gate it on a session, because an orchestrator and
  a deploy gate both have to reach it unauthenticated.
- **`/api/auth`** lets an anonymous caller create `verification_tokens` rows for
  any address. They grant nothing and expire in 15 minutes, but nothing prunes
  them and each one attempts to send mail only for real members.
- **`/api/cron/*`** does nothing without the bearer: 503 with no `CRON_SECRET`,
  401 with a wrong one, 403 anywhere but production. Even with it, the work is
  bounded by `RESCAN_BATCH_SIZE`, a twenty-hour floor per company and one
  digest per org per twenty hours.
- **`/api/unsubscribe/<token>` and `/unsubscribe/<token>`** are the one-click
  opt-out. The token names one outbound message and nothing else — no
  address, no org, no expiry — and is an HMAC under `UNSUBSCRIBE_SECRET`. A
  POST records the opt-out; if a suppression row cannot be stored the answer
  is 500, `OPT-OUT NOT RECORDED` is logged at error, and Slack is told when
  it is configured. A GET
  only redirects to the page, because link scanners prefetch, and the page
  records nothing when it loads. Bodies over 1 KB get 413, a bad token a 404
  with no hint, and no secret a 503.
- **`/p/<token>` and `/api/p/<token>/accept`** are a buyer's proposal link. The
  page is a read that counts a view — a count and two timestamps, never an IP
  or a user agent, and a mail client's link preview counts too. The accept is
  a write under the booking page's rules: a 2 KB body, an answer of
  `{ ok: true }` and nothing enumerable. A token is 32 random bytes and only
  its sha256 is stored. A link expires after 30 days or when its evidence goes
  stale, whichever is first (with the default ICP that is always the evidence,
  at most 14 days after the scan), and a person can revoke it. The buyer page
  shows no score and no tier.
- **`/api/inbound/resend`** sits under `/api/inbound`: it refuses everything
  until both Resend variables are set, and verifies the Svix signature before
  it acts on anything.

The platform's own request logs record every request's path, so `/p/<token>`
and `/unsubscribe/<token>` are in Vercel's logs. A share link can be revoked;
an unsubscribe token can only ever do the one thing its holder asked for.

CLAUDE.md §4 says rate limiting "belongs at the reverse proxy in front of the
VPS". On Vercel there is no reverse proxy you control, so that sentence has no
owner any more. Turn on Vercel's WAF / rate limiting for `/api/book`,
`/api/p`, `/api/unsubscribe` and `/api/auth`, or accept that these are open.
