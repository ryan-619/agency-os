import { NextResponse } from 'next/server'
import { Resolver } from 'node:dns/promises'
import { can } from '@agency/core'
import { auth } from '@/auth'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import {
  DKIM_DEFAULT_SELECTORS, isDkimSelector, lookupMailDns, mailFromDomain, type ResolveTxt,
} from '@/lib/mail-dns'

/**
 * SPF, DMARC and DKIM for the agency's OWN sending domain (/settings/mail).
 *
 * The domain is the one in `MAIL_FROM` — configuration, never a request
 * parameter — so this route cannot be pointed at somebody else's domain,
 * let alone at an internal name. The one input is `?dkim=`, a selector,
 * which must be a single DNS label (refused with a 400 otherwise) before
 * `lookupMailDns` puts it in front of `._domainkey.<domain>`. TXT lookups
 * only; no address is ever resolved, and nothing is connected to.
 *
 * Every rule about what an answer MEANS is in `lib/mail-dns.ts` and tested
 * there. This file is the resolver: a fresh one per request, with a short
 * timeout, so a slow nameserver makes a record "could not be checked" in a
 * few seconds rather than holding the page. A lookup's error NAME is its
 * answer (`ESERVFAIL`), and nothing else about the error is reported.
 *
 * Any signed-in member may ask (`connectors:read`): it reads public DNS
 * about our own domain, and says nothing a `dig` would not.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const revalidate = 0

const NO_STORE = { 'cache-control': 'no-store' }

/** Per query, per try. Two tries: one dropped UDP packet is not a verdict. */
const TIMEOUT_MS = 2_500
const TRIES = 2

export async function GET(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, 'connectors:read')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Validated BEFORE anything is resolved, and as given: a selector that is
  // not one DNS label is refused, never trimmed into one.
  const dkim = new URL(request.url).searchParams.get('dkim')
  if (dkim !== null && !isDkimSelector(dkim)) {
    return NextResponse.json(
      { error: 'A DKIM selector is a single DNS label: letters, digits and inner hyphens, at most 63 characters.' },
      { status: 400, headers: NO_STORE },
    )
  }
  const selectors = dkim === null ? DKIM_DEFAULT_SELECTORS : [dkim.toLowerCase()]

  const from = mailFromDomain(env().MAIL_FROM)
  if (from.domain === null) {
    // Not an error: the development default is `@localhost`, which has no
    // public DNS. The page says so rather than reporting three "missing".
    return NextResponse.json({ checked: false, reason: from.reason }, { headers: NO_STORE })
  }

  const resolver = new Resolver({ timeout: TIMEOUT_MS, tries: TRIES })
  const resolveTxt: ResolveTxt = (name) => resolver.resolveTxt(name)
  const report = await lookupMailDns(from.domain, selectors, resolveTxt)

  // Verdicts only. The domain is the agency's own and not a secret, but the
  // records are content and the log has no use for them.
  log.info('mail dns checked', {
    spf: report.spf.verdict, dmarc: report.dmarc.verdict, dkim: report.dkim.verdict, selectors: selectors.length,
  })
  return NextResponse.json({ checked: true, ...report }, { headers: NO_STORE })
}
