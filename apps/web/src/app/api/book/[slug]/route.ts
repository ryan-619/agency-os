import { NextResponse } from 'next/server'
import { bookInbound, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { BOOKING_CONSENT_WORDING } from '@/lib/booking-copy'

/**
 * The public booking endpoint (PROMPT.md §8.6, §2.1).
 *
 * Unauthenticated by design — the visitor is a stranger — and exempt from
 * the cookie gate in `proxy.ts` for that reason. It is the only route an
 * outsider can write through, so it is narrow:
 *
 *  - the org is found by slug, and NOTHING about the org is revealed beyond
 *    whether the slug is live (404 either way for a missing one);
 *  - every field is bounded before it reaches the database;
 *  - the consent rows record THIS file's wording, imported from the same
 *    module the form renders, so the evidence is what the visitor saw.
 *
 * Rate limiting belongs at the reverse proxy, like `/api/health`'s (CLAUDE.md
 * §4). What this route does on its own is refuse bodies over 8 KB.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_BODY = 8 * 1024

function text(v: unknown, max: number): string | null {
  return typeof v === 'string' ? v.trim().slice(0, max) || null : null
}

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) {
    return NextResponse.json({ error: 'This booking link is not active.' }, { status: 404 })
  }

  const raw = await request.text()
  if (raw.length > MAX_BODY) return NextResponse.json({ error: 'That request is too large.' }, { status: 413 })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const b = (body ?? {}) as Record<string, unknown>
  const consent = (b.consent ?? {}) as Record<string, unknown>

  const name = text(b.name, 120)
  const email = text(b.email, 254)
  const startsAt = typeof b.startsAt === 'string' ? new Date(b.startsAt) : new Date(Number.NaN)
  const timeZone = text(b.timeZone, 64)
  if (!name) return NextResponse.json({ error: 'Please tell us your name.' }, { status: 400 })
  if (!email) return NextResponse.json({ error: 'Please give us an email address to confirm with.' }, { status: 400 })
  if (!timeZone) return NextResponse.json({ error: 'Your timezone could not be read. Please pick it from the list.' }, { status: 400 })

  const db = getDb() as unknown as AgencyDb
  const r = await bookInbound(db, {
    slug,
    name,
    email,
    company: text(b.company, 120),
    phone: text(b.phone, 32),
    startsAt,
    timeZone,
    notes: text(b.notes, 2000),
    consent: {
      sms: consent.sms === true,
      voice: consent.voice === true,
      whatsapp: consent.whatsapp === true,
    },
    consentWording: BOOKING_CONSENT_WORDING,
  })
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.status })
  // The meeting id is not returned: a stranger has no use for an internal
  // id, and an id is a thing to enumerate with.
  return NextResponse.json({ ok: true }, { status: 201 })
}
