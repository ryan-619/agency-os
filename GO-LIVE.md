# Going live on myagencyos.in

Everything you need to do, in order, with the links. Written 2026-09-26;
Part 2b added 2026-09-30 for the release that needs migration 0018.

Steps marked **YOU** need your logins. Steps marked **ME** I do from here —
tell me when the step before is done.

The order is not a suggestion. Two of these steps break things if done early,
and both are called out where they appear.

---

## Where things stand right now

Updated after the deploy on 2026-09-26, and again on 2026-09-30 for the
release in Part 2b.

| | state |
|---|---|
| `https://myagencyos.in` | **LIVE**, TLS issued (Let's Encrypt, expires 25 Dec 2026) |
| the database | Neon, migrated through **0017** — verified live, see below. This release needs **0018** first: Part 2b |
| production code | **one release behind** the repo — Part 2b |
| sign-in | the page works; whether the *mail* arrives depends on SMTP, untested |
| the worker | **not hosted** — so no chat, no email sending, no IMAP reply detection |
| scanning | a CLI you run from your machine — and, once Part 2b sets `CRON_SECRET`, a nightly rescan on Vercel |

You can check the first three yourself, any time, from anywhere:

```bash
curl -s https://myagencyos.in/api/health
```

`schema.state: "ok"` means the deployed code and the database agree. It reads
`0017` today, and must read `0018` after Part 2b.

### What is live and what is not

**Working now:** the domain, TLS, the database, the session gate (every page
redirects to `/signin`), the public booking page at `/book/agency`, and the
whole CRM surface once you are signed in — companies, scoring, the pipeline
board, proposals, meetings, suppressions.

**Not working, and none of it is a bug:**

| | needs |
|---|---|
| **chat** | the worker hosted somewhere with a public URL, plus `AGENT_URL` set in Vercel. `AGENT_URL` is deliberately unset, so the panel says "no worker connected" |
| **sending email** | a sending domain (Part 3) **and** the worker running with SMTP configured. LinkedIn needs neither: a person sends it from `/tasks` once the release in Part 2b is live |
| **reply detection** | a mailbox (Part 4) **and** the worker running with IMAP configured — **or**, with no worker at all, Resend receiving (Step 9b) |
| **scanning** | `npm run scan` from your machine against the production database — or `CRON_SECRET` (Part 2b), and the nightly rescan scans six a night, never-scanned first |
| **voice** | A2P 10DLC registration, which takes weeks |

All five come down to two things: **the worker is not hosted**, and **mail is
not set up**. Parts 3 to 5 below are those two things. Part 2b is neither: it
is the release, and it comes first.

## Part 1 — point the domain at the app

### Step 0 **YOU** — put the A record wherever DNS is authoritative TODAY

**A newly registered domain is locked against nameserver changes for about 24
hours.** That lock is at the registry, and it does NOT cover DNS record edits,
which happen in Hostinger's own zone. So the fast path is to skip Cloudflare
entirely for now.

The domain currently answers from `aster.dns-parking.com` and
`helios.dns-parking.com` — Hostinger's own nameservers — so Hostinger's DNS
editor is authoritative right now.

1. **https://hpanel.hostinger.com** → **Domains** → **myagencyos.in**
2. **DNS / Nameservers** → **DNS Records** (not the Nameservers tab, which is
   the locked one)
3. Add — or EDIT, if one already points at a parking IP:

   | Type | Name | Points to |
   |---|---|---|
   | `A` | `@` | `76.76.21.21` |

   Two `A @` records means half your visitors reach a parking page, so edit
   rather than add.

4. Optional: `CNAME` `www` → `cname.vercel-dns.com`

That is the whole requirement for the site to go live. Steps 1 and 0b below
are only needed if you decide you want Cloudflare.

### Step 0b **YOU, optional, after the 24-hour lock** — move DNS to Cloudflare

**Only worth doing for one reason: Cloudflare Email Routing is free**, and it
is the cleanest zero-cost way to receive replies (`replies@myagencyos.in` →
your Gmail), which is what turns the worker from `send-only` to
`send-and-receive`. Everything else — SPF, DKIM, DMARC — is just TXT records
and Hostinger's editor handles them fine.

If you stay on Hostinger DNS, skip this and use Hostinger's own email
forwarding or another free forwarder instead.

Cloudflare has assigned you two nameservers and is waiting for the switch.
Until that happens Cloudflare answers nothing for this domain, so any record
added there has no effect.

1. **https://hpanel.hostinger.com** → **Domains** → **myagencyos.in**
2. Find **DNS / Nameservers** → **Change nameservers** → choose *custom*
3. Replace both with:

   ```
   gabriella.ns.cloudflare.com
   miguel.ns.cloudflare.com
   ```

4. Delete `aster.dns-parking.com` and `helios.dns-parking.com`
5. Save

**Also turn DNSSEC off at Hostinger** if it is on. Cloudflare's own note says
this and it matters: DNSSEC signs records against the *old* nameservers, so
switching with it enabled makes the domain fail to resolve entirely rather
than just serving stale answers. You can re-enable it from Cloudflare later.

Cloudflare emails you when the domain goes **Active** — usually minutes,
occasionally a few hours.

### Step 1 **YOU** — add one DNS record

Once Cloudflare is Active it answers DNS for this domain, and a record added
at Hostinger or in Vercel's DNS would be ignored — nothing queries them for
`myagencyos.in` any more. You can add this record before the switch
completes; it simply takes effect when Cloudflare goes live.

1. Go to **https://dash.cloudflare.com**
2. Select **myagencyos.in**
3. Left sidebar → **DNS** → **Records** → **Add record**
4. Enter exactly:

   | field | value |
   |---|---|
   | Type | `A` |
   | Name | `@` |
   | IPv4 address | `76.76.21.21` |
   | Proxy status | **DNS only** — click the orange cloud so it turns **grey** |
   | TTL | Auto |

5. **Save**

**The grey cloud is the part that goes wrong.** Orange means Cloudflare
proxies the request and terminates TLS itself — in front of Vercel, which is
also terminating TLS. The certificate handshake then fails in a way that is
genuinely unpleasant to diagnose. Grey = Cloudflare answers the DNS question
and stays out of the traffic.

Optional, if you want `www` to work as well:

   | Type | Name | Target | Proxy |
   |---|---|---|---|
   | `CNAME` | `www` | `cname.vercel-dns.com` | DNS only (grey) |

Propagation is usually a minute or two on Cloudflare, occasionally longer.

### Step 2 **ME** — verify and issue TLS

I check it resolves, confirm Vercel has issued the certificate, and that
`https://myagencyos.in` serves the app.

---

## Part 2 — get production current

### Step 3 **YOU** — apply migration 0017

```bash
cd ~/ecomm/agency-os
./tools/remote-setup.sh
```

Same hidden prompt as before: the **direct (unpooled)** Neon connection
string — the host WITHOUT `-pooler` in it. Get it from
**https://console.neon.tech** → your project → Connection string, with
"Pooled connection" switched **off**.

**This must happen before the deploy, not after.** 0017 adds
`touches.reply_kind`, and two queries in the new code — `approveDraft` and
the worker's `dueTouches` — select every column. Against a database without
that column they fail outright with `column touches.reply_kind does not
exist`, which breaks approving a draft and the send tick.

### Step 3b **YOU** — show me it worked

```bash
./tools/remote-status.sh
```

Read-only, same hidden prompt, and the pooled string is fine for this one.
Paste the output here. **Every line of it is a fact about the schema** — column
names, constraint names, counts — and none of it contains the connection
string, so it is safe to paste. Look for:

```
  touches.reply_kind: text, nullable=YES   <- 0017 is applied
```

This step exists because of a real gap rather than politeness. I am not allowed
to hold the production connection string (§2.3), so I cannot check the database
myself — and deploying code that assumes a column the database does not have is
the exact failure this whole ordering is designed to avoid. "Probably applied"
is not good enough to spend a production deploy on.

From the next deploy onward this is no longer needed: `/api/health` now reports
the schema state, so anyone who can reach the URL can check it with no
credential at all.

```bash
curl -s https://myagencyos.in/api/health | python3 -m json.tool
```

`schema.state` is `ok`, `behind`, `ahead`, or `unknown`. It returns 200 even
when it disagrees — deliberately, because the container healthcheck would
otherwise restart-loop the app rather than serve the 95% of it that works.
Add `?strict=1` to get a 503 on disagreement instead.

### Step 4 **ME** — deploy all 11 commits

Deal ownership, the sign-in improvements, reply classification, draft
generation, the workspace-header fix. Then I switch `AUTH_URL` to
`https://myagencyos.in` and redeploy.

**Why `AUTH_URL` waits until Part 1 is done:** every magic link is built from
it. Point it at a domain that does not resolve and sign-in stops working for
everybody, including you.

---

## Part 2b — this release: migration 0018 before the code

The repo is one release ahead of production: the inbox, tasks and notes, the
contacts ledger, compliance, the audit log, search and CSV exports, the
settings pages, proposal share links, LinkedIn steps, the nightly rescan and
the Slack digest. Five steps, **in this order**.

### Step 4a **YOU** — apply migration 0018 before the deploy

```bash
cd ~/ecomm/agency-os
./tools/remote-setup.sh
```

The same hidden prompt and the same **direct (unpooled)** string as Step 3.

**This must happen before the deploy, not after.** 0018 adds
`findings.scored`, which is the first column a page reads — every company page
selects it — and creates `tasks`, `notes`, `proposal_shares` and
`worker_heartbeats`. Deployed against a database without them, the code boots
and serves `/signin` — and then the dashboard, `/inbox`, `/tasks`, `/contacts`
and every company page answer with a 500. Migrating first costs nothing: code
that is behind its schema never reads the new columns.

Then show me it worked, exactly as in Step 3b:

```bash
./tools/remote-status.sh
```

Paste the output. Look for:

```
  findings.scored: boolean, nullable=NO   <- 0018 is applied
  0018 tables: notes, proposal_shares, tasks, worker_heartbeats
```

### Step 4b **YOU** — the new variables, only the ones you want

Every one is optional. Unset, its feature is off, the page that needs it says
so, and nothing else changes. Set them in
**https://vercel.com/aryansharma8604-6232s-projects/agency-os/settings/environment-variables**
for **Production**, marked sensitive — yourself; I do not handle credentials.

| name | set on | turns on |
|---|---|---|
| `CRON_SECRET` | Vercel, Production only | the nightly rescan and the daily digest. `openssl rand -hex 32` |
| `RESCAN_BATCH_SIZE` | Vercel | companies per night. Leave it unset: 6 |
| `SLACK_WEBHOOK_URL` | Vercel | Slack messages — a reply, a booking, a deal won or lost, a proposal accepted, an opt-out that could not be recorded, the digest, a campaign that paused itself because its addresses bounced, a silent worker. A Slack incoming-webhook URL, and the URL is the credential |
| `UNSUBSCRIBE_SECRET` | Vercel **and** the worker — the SAME value | one-click unsubscribe. `openssl rand -base64 32` |
| `WEB_PUBLIC_URL` | the worker | `https://myagencyos.in` — where the unsubscribe link points. It must be `https://` on a public host: in production the worker refuses to boot on anything else |
| `RESEND_WEBHOOK_SECRET`, `RESEND_API_KEY` | Vercel | replies with no worker — Step 9b |
| `OUTREACH_BOUNCE_PAUSE_PCT` | the worker | leave it unset: a campaign past 5% bounces pauses itself |
| `SECRETS_KEY` | Vercel **and** the worker — the same value | storing a connector's credential from Settings |

The worker is not hosted yet, so the three worker lines only matter after
Part 5. `DEPLOYING.md` §5 says what each one does when it is unset.

### Step 4c **YOU** — Vercel: Fluid Compute, and the plan

Only needed if you set `CRON_SECRET`.

1. Project → **Settings → Functions** → **Fluid Compute** must be on. It is the
   default for projects created since 23 April 2025, which this one is — check
   anyway. The nightly rescan is built around a 300-second ceiling, and without
   Fluid Compute a function stops at 60.
2. **The plan.** Hobby runs these crons once a day within ±59 minutes of their
   schedule, which would work — but Vercel's terms restrict Hobby to
   non-commercial use, and this is an agency's sales tool. Pro is the plan
   that fits, and it runs a cron on its minute.

### Step 4d **ME** — deploy

Then, **YOU**, the agents: the seed never updates a subagent that already
exists (`ON CONFLICT DO NOTHING`), so the live qualifier, researcher and closer
keep their old tool lists. Open **Settings → Agents** and add the new tools
each one should have — `packages/db/seed/agents.json` lists them. Nothing
breaks if you skip this; a subagent simply cannot call a tool it was not given.

### Step 4e **ME, then YOU** — verify

**ME:**

```bash
curl -s https://myagencyos.in/api/health | python3 -m json.tool
```

`schema.state` must be `"ok"` with `applied: "0018"`. `worker.status` reads
`not_configured` until Part 5 — that is the honest answer, not a fault.

**YOU:** open **https://myagencyos.in/settings/deployment**. It lists which
variables are set, by name only, and answers "why would nothing send?".

**YOU**, if you set `CRON_SECRET` — run the rescan once by hand, with the secret
in a shell variable from your password manager, never pasted here:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://myagencyos.in/api/cron/rescan
```

It answers `{"orgs":[…]}` with how many companies it scanned, and `/audit` gains
two lines, "started the scheduled rescan" and "ran the scheduled rescan". Run
it again within five minutes and the org reads `skipped: 'claimed'`: each run
claims the org until its own ceiling, so two deliveries never scan the same
companies twice. A 503 means the variable did not reach the
deployment (redeploy after setting it); a 401 means the value differs; a 403
means you called a preview URL.

---

## Part 3 — mail, so outreach can actually land

### Step 5 **YOU** — add the sending domain to Resend

1. **https://resend.com/domains** → **Add Domain**
2. Enter **`outreach.myagencyos.in`** — the subdomain, not the apex.

   Cold outreach damages the reputation of whatever domain sends it. Keeping
   it on a subdomain means a bad campaign cannot hurt mail sent from
   `you@myagencyos.in`.

3. Resend shows you a **DKIM** record and an **SPF** record. Leave that page
   open.

### Step 6 **YOU** — put those records into Cloudflare

Same place as Step 1 (**dash.cloudflare.com → myagencyos.in → DNS → Records**).
Add what Resend showed you, copied **exactly** — the DKIM value is a public
key and one wrong character fails silently.

All of these are **DNS only (grey cloud)**.

Then add the DMARC record, which is yours rather than Resend's:

| Type | Name | Content |
|---|---|---|
| `TXT` | `_dmarc.outreach` | `v=DMARC1; p=none; rua=mailto:YOUR@EMAIL; fo=1; adkim=r; aspf=r` |

Replace `YOUR@EMAIL` with an address you actually read.

**`p=none` is deliberate.** It means "watch and report, do not reject". A
`p=reject` published on day one with SPF or DKIM slightly wrong bounces every
message you send, and you find out from silence. Run it for a fortnight, read
the reports, confirm everything passes, then tighten.

`./tools/mail-dns.sh` prints all of this for your domain if you would rather
have it as commands.

### Step 7 **YOU** — get a Resend API key

**https://resend.com/api-keys** → Create API Key → copy it.

Then **https://vercel.com/aryansharma8604-6232s-projects/agency-os/settings/environment-variables**
and set, for **Production**:

| name | value |
|---|---|
| `MAIL_FROM` | `Your Name <hello@outreach.myagencyos.in>` |
| `SMTP_HOST` | `smtp.resend.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `resend` |
| `SMTP_PASSWORD` | your Resend API key |

Set these yourself — I do not handle credentials.

### Step 8 **ME** — redeploy and verify sign-in through the real mailbox

This is also the first time Phase 4 is proved against a real mailbox rather
than the local sink.

---

## Part 4 — receiving replies (free)

### Step 9 **YOU** — Cloudflare Email Routing

1. **dash.cloudflare.com** → **myagencyos.in** → **Email** → **Email Routing**
2. Enable it. Cloudflare adds its own MX records automatically.
3. Create a route: **`replies@myagencyos.in`** → forward to a Gmail you read.
4. Confirm the forwarding address from the email Cloudflare sends you.

### Step 10 **YOU** — an app password for that Gmail

**https://myaccount.google.com/apppasswords** (needs 2-step verification on).
Create one for "Mail".

The worker polls that mailbox over IMAP. Give me nothing — set these on
whatever host the worker ends up on:

| name | value |
|---|---|
| `IMAP_HOST` | `imap.gmail.com` |
| `IMAP_PORT` | `993` |
| `IMAP_SECURE` | `true` |
| `IMAP_USER` | that Gmail address |
| `IMAP_PASSWORD` | the app password |

That is what flips the worker from `outreach: send-only` to
`send-and-receive`, and it is what makes reply detection — and the reply
triage — actually run.

### Step 9b **YOU, instead of 9–10 while there is no worker** — Resend receiving

Cloudflare Email Routing → Gmail → IMAP can only be read by the worker, and
the worker is not hosted. Resend can receive replies and hand them straight to
the web app on Vercel:

1. **https://resend.com/domains** → turn on **receiving** for a subdomain such
   as `replies.myagencyos.in`, and add the MX record it shows — copied exactly,
   grey cloud if the DNS is at Cloudflare.
2. **Webhooks** → add an endpoint for the **`email.received`** event at
   `https://myagencyos.in/api/inbound/resend`. Copy its signing secret
   (`whsec_…`).
3. In Vercel, for Production, marked sensitive: `RESEND_WEBHOOK_SECRET` (that
   secret) and `RESEND_API_KEY` — a key that can **read** received email. The
   one in `SMTP_PASSWORD` is probably sending-only, and with it every delivery
   is refused with a 502 until it is replaced.
4. I redeploy; you reply to a message from a contact's address, and it appears
   in `/inbox`.

Until both are set the route refuses everything with a 503, which is the
correct failure. `DEPLOYING.md` "Replies through Resend" has the two limits
worth knowing — check with one real reply that its threading headers arrive.

---

## Part 5 — the worker, which is the remaining gap

Everything above gets `myagencyos.in` live with companies, scans, scoring, the
pipeline, proposals and the booking page. **It does not give you chat,
sending or reply detection**, because all three need the long-running worker
and Vercel cannot run one.

Three options, in order of how well they work:

1. **Fly.io** — `fly.toml` is written and validated. Needs a card on file
   even for the free allowance; roughly $3/month after that.
   `./tools/run-worker.sh` documents the secrets.
2. **Your Mac** — free, works today, only live while the machine is awake.
   `./tools/run-worker.sh` runs it against production with nothing exposed.
3. **Any VPS** — `docker-compose.yml` defines the whole stack including the
   voice service.

Mail queued while the worker is down is not lost. It waits, and every §2.1
rule is re-checked at the moment of sending, so nothing improper escapes —
it simply goes later than intended.

---

## Part 6 — before the first campaign

**Warm the domain.** A domain with no sending history that starts at fifty
messages a day looks exactly like a compromised account. Set the campaign's
`dailyCap` low and raise it:

| week | cap |
|---|---|
| 1 | 5/day |
| 2 | 15/day |
| 3 | 25/day |
| 4 | 40/day, if nothing is bouncing |

It is a campaign setting, not a code change — but it is the difference
between a domain that works in a month and one burned in a week.

**Check the headers of a real message** before you trust it: send one to a
personal address and look for `spf=pass`, `dkim=pass`, `dmarc=pass`. Anything
else is worth fixing before the first campaign rather than after it.

---

## Still outstanding, separately

- **Rotate the Neon password** — it went through this chat twice.
- **A2P 10DLC registration** for voice. Weeks-long; start it now if you want
  voice this quarter. Phase 6 is built and proved end to end against a
  simulated Twilio; only the carrier is untested.

---

## The short version

| # | who | what |
|---|---|---|
| 0 | YOU | **Hostinger → DNS Records → A `@` → `76.76.21.21`** (works today) |
| 0b | YOU | *optional, after 24h* — nameservers → Cloudflare, DNSSEC off, re-add records |
| 2 | ME | verify DNS + TLS |
| 3 | YOU | `./tools/remote-setup.sh` (migration 0017) — done |
| 3b | YOU | `./tools/remote-status.sh` → paste the output (safe; schema facts only) |
| 4 | ME | deploy, switch `AUTH_URL`, verify |
| 4a | YOU | **`./tools/remote-setup.sh` (migration 0018) BEFORE the deploy**, then `./tools/remote-status.sh` → paste |
| 4b | YOU | the new variables you want, in Vercel — every one optional |
| 4c | YOU | if `CRON_SECRET`: Fluid Compute on, and the Pro plan |
| 4d | ME / YOU | deploy; then add the new tools to the agents in Settings → Agents |
| 4e | ME / YOU | `/api/health` reads 0018; open `/settings/deployment`; run the rescan once with the bearer |
| 5–7 | YOU | Resend domain + records + API key into Vercel |
| 8 | ME | redeploy, verify real mail |
| 9–10 | YOU | Cloudflare Email Routing + Gmail app password — for the worker |
| 9b | YOU | or, with no worker: Resend receiving + two variables in Vercel |
| — | BOTH | host the worker |

**Start with step 0 at Hostinger.** It works today, and nothing about it is wasted if you move to Cloudflare later.
