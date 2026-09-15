/**
 * The public booking page (PROMPT.md §8.6, §2.1).
 *
 * "Booking links land inbound leads with consent recorded at the form."
 *
 * This is the one place in the product an outsider writes to the database
 * without signing in, so it is written defensively and it does very little:
 * find the org by its slug, record who asked and when they would like to
 * talk, record what they consented to IN THEIR OWN WORDS from the form, and
 * hand the rest to a person.
 *
 * ## Why this is the consent flow that matters
 *
 * §2.1 makes SMS and voice opt-in only. A booking form is where an opt-in
 * actually happens — someone types their number and ticks "you may call me"
 * — so the consent rows written here carry the source, the moment, and the
 * form's exact wording as evidence. A consent with no evidence of what was
 * agreed to is a claim, and §2.1 is not a place for claims.
 *
 * ## What it refuses to guess
 *
 * The visitor's timezone comes from their browser and is validated; without
 * one, the request is recorded but nothing can be sent to them (the send
 * path refuses `unknown_timezone`) — a person follows up by hand. A phone
 * number that cannot be normalised is not stored: an unmatchable number is
 * one the suppression list can never protect.
 */
import { and, eq } from 'drizzle-orm'
import { normaliseDomainValue, normaliseEmail, normalisePhone } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { createMeeting } from './meetings.js'
import { isKnownTimeZone, recordConsent } from './contacts.js'

export interface BookingRequest {
  readonly slug: string
  readonly name: string
  readonly email: string
  readonly company?: string | null
  readonly phone?: string | null
  /** The wall-clock start the visitor picked, as an instant, and their zone. */
  readonly startsAt: Date
  readonly timeZone: string
  readonly notes?: string | null
  /** Ticked boxes. The email box is implied by asking to be contacted about a meeting. */
  readonly consent: { readonly sms: boolean; readonly voice: boolean; readonly whatsapp: boolean }
  /** The exact wording the visitor agreed to, for the consent rows' evidence. */
  readonly consentWording: string
  readonly now?: Date
}

export type BookingOutcome =
  | { readonly ok: true; readonly meetingId: string; readonly companyDomain: string }
  | { readonly ok: false; readonly message: string; readonly status: 400 | 404 }

/** The org behind a booking link, or null. Public: nothing else about the org is returned. */
export async function orgByBookingSlug(db: AgencyDb, slug: string): Promise<{ id: string; name: string } | null> {
  const rows = await db
    .select({ id: schema.orgs.id, name: schema.orgs.name })
    .from(schema.orgs)
    .where(eq(schema.orgs.bookingSlug, slug))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Record an inbound booking request.
 *
 * Creates the company (from the address's domain) and the contact if they
 * are new; writes the consent rows; records the meeting, which moves the
 * deal to `meeting`. Idempotent enough for a double-submit: a second request
 * from the same address reuses the contact and adds a second meeting, which
 * a person then tidies — better than refusing a real lead for clicking twice.
 */
export async function bookInbound(db: AgencyDb, req: BookingRequest): Promise<BookingOutcome> {
  const now = req.now ?? new Date()
  const org = await orgByBookingSlug(db, req.slug)
  if (!org) return { ok: false, status: 404, message: 'This booking link is not active.' }

  const email = normaliseEmail(req.email)
  if (!email) return { ok: false, status: 400, message: 'That does not look like an email address.' }
  const name = req.name.trim()
  if (!name) return { ok: false, status: 400, message: 'Please tell us your name.' }
  if (!isKnownTimeZone(req.timeZone)) {
    return { ok: false, status: 400, message: 'Your timezone could not be read. Please pick it from the list.' }
  }
  if (Number.isNaN(req.startsAt.getTime()) || req.startsAt.getTime() < now.getTime() - 60_000) {
    return { ok: false, status: 400, message: 'Please pick a time in the future.' }
  }

  let phone: string | null = null
  if (req.phone?.trim()) {
    phone = normalisePhone(req.phone)
    if (!phone) {
      return {
        ok: false,
        status: 400,
        message: 'Please include the country code in your phone number, like +1 415 555 0100 — or leave it out.',
      }
    }
  }
  if ((req.consent.sms || req.consent.voice || req.consent.whatsapp) && !phone) {
    return { ok: false, status: 400, message: 'To be called or texted, add a phone number with its country code.' }
  }

  // A free-mail address does not name a company. The domain is the company
  // for everyone else; for gmail and friends the row is named after the
  // person and a human fixes it.
  const domain = normaliseDomainValue(email) ?? email.split('@')[1] ?? 'unknown'
  const freeMail = /^(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|proton|protonmail|aol)\./.test(domain)
  const companyDomain = freeMail ? `${email.replace(/[^a-z0-9]+/g, '-')}.inbound` : domain

  let companyId: string
  const existing = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, org.id), eq(schema.companies.domain, companyDomain)))
    .limit(1)
  if (existing[0]) {
    companyId = existing[0].id
  } else {
    const inserted = await db
      .insert(schema.companies)
      .values({
        orgId: org.id,
        domain: companyDomain,
        name: req.company?.trim() || (freeMail ? name : null),
        source: 'manual',
        timeZone: req.timeZone,
      })
      .returning({ id: schema.companies.id })
    companyId = inserted[0]!.id
  }

  let contactId: string
  const known = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, org.id), eq(schema.contacts.email, email)))
    .limit(1)
  if (known[0]) {
    contactId = known[0].id
    // The visitor told us where they are; that is better than whatever was
    // recorded before, and it is what quiet hours will be checked against.
    await db
      .update(schema.contacts)
      .set({ timeZone: req.timeZone, ...(phone ? { phone } : {}) })
      .where(eq(schema.contacts.id, contactId))
  } else {
    const [first, ...rest] = name.split(/\s+/)
    const inserted = await db
      .insert(schema.contacts)
      .values({
        orgId: org.id,
        companyId,
        firstName: first ?? null,
        lastName: rest.join(' ') || null,
        email,
        phone,
        timeZone: req.timeZone,
        // 0003's CHECK: apollo | manual | import | agent | inbound. An inbound
        // lead is what this is; the booking page is recorded on the meeting.
        source: 'inbound',
      })
      .returning({ id: schema.contacts.id })
    contactId = inserted[0]!.id
  }

  // Consent, per channel, with the form's wording as evidence (§2.1).
  const evidence = { form: 'booking_page', wording: req.consentWording.slice(0, 1000), at: now.toISOString() }
  const source = `booking page, ${now.toISOString().slice(0, 10)}`
  await recordConsent(db, { orgId: org.id, contactId, channel: 'email', granted: true, source, evidence })
  for (const channel of ['sms', 'voice', 'whatsapp'] as const) {
    if (req.consent[channel]) {
      await recordConsent(db, { orgId: org.id, contactId, channel, granted: true, source, evidence })
    }
  }

  const meeting = await createMeeting(db, {
    orgId: org.id,
    companyId,
    contactId,
    title: `Intro call with ${name}`,
    startsAt: req.startsAt,
    endsAt: new Date(req.startsAt.getTime() + 30 * 60_000),
    timeZone: req.timeZone,
    source: 'booking_page',
    notes: req.notes?.trim().slice(0, 2000) || null,
    actor: 'booking_page',
  })
  if (!meeting.ok) return { ok: false, status: 400, message: meeting.message }

  await appendAudit(db, {
    orgId: org.id,
    actor: 'booking_page',
    action: 'lead.inbound',
    subjectType: 'contact',
    subjectId: contactId,
    detail: {
      companyId,
      meetingId: meeting.meeting.id,
      consented: ['email', ...(['sms', 'voice', 'whatsapp'] as const).filter((c) => req.consent[c])],
    },
  }).catch(() => {})

  return { ok: true, meetingId: meeting.meeting.id, companyDomain }
}
