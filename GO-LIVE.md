# Going live on myagencyos.in

Everything you need to do, in order, with the links. Written 2026-09-26.

Steps marked **YOU** need your logins. Steps marked **ME** I do from here —
tell me when the step before is done.

The order is not a suggestion. Two of these steps break things if done early,
and both are called out where they appear.

---

## Where things stand right now

| | state |
|---|---|
| the app | **live**, at `agency-os-tau-murex.vercel.app` |
| the database | Neon, migrated through **0016** |
| `myagencyos.in` | attached to the Vercel project; DNS served by **Hostinger**, nameserver changes locked for ~24h after registration |
| production code | **11 commits behind** the repo |
| migration **0017** | in the repo, **not applied** to Neon |
| the worker | not hosted — so no chat, no sending, no reply detection |

---

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

### Step 4 **ME** — deploy all 11 commits

Deal ownership, the sign-in improvements, reply classification, draft
generation, the workspace-header fix. Then I switch `AUTH_URL` to
`https://myagencyos.in` and redeploy.

**Why `AUTH_URL` waits until Part 1 is done:** every magic link is built from
it. Point it at a domain that does not resolve and sign-in stops working for
everybody, including you.

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
| 3 | YOU | `./tools/remote-setup.sh` (migration 0017) |
| 4 | ME | deploy 11 commits, switch `AUTH_URL`, verify |
| 5–7 | YOU | Resend domain + records + API key into Vercel |
| 8 | ME | redeploy, verify real mail |
| 9–10 | YOU | Cloudflare Email Routing + Gmail app password |
| — | BOTH | host the worker |

**Start with step 0 at Hostinger.** It works today, and nothing about it is wasted if you move to Cloudflare later.
