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
 * ## The rule this module exists to enforce
 *
 * **A booking may CREATE records. It may never MODIFY a record it did not
 * create.**
 *
 * Nothing here authenticates anybody: the form asks for an email address and
 * believes it. So every write has to be safe in the hands of someone who
 * typed a stranger's address into it. Review found three ways the earlier
 * version was not, each reachable by anyone who could guess an address:
 *
 *   * `recordConsent` UPSERTS, so a recorded refusal — `granted = false`,
 *     one of the three things §2.1 says nobody can approve past — was
 *     replaced by a grant. "Never call me" became "you may call me", with
 *     the booking form's wording attached as the evidence;
 *   * an existing contact's `phone` and `time_zone` were overwritten, which
 *     re-points an opt-in at a number the submitter chose and moves quiet
 *     hours onto a clock they chose;
 *   * `createMeeting` advances the deal, so anyone could walk a real
 *     prospect's deal to `meeting` by booking as `anything@their-domain`.
 *
 * So a booking now resolves the company and the contact FIRST, and what it
 * does next depends on whether it recognised them:
 *
 *   | matched nothing        | creates company, contact, consent; deal → meeting |
 *   | matched a company      | creates the contact; no deal move; flagged        |
 *   | matched a contact      | touches neither; no consent; no deal move; flagged |
 *
 * A recognised booking is still RECORDED — refusing a real prospect because
 * the team already has them on file would be the worse failure — but it is
 * recorded as `meetings.needs_review`, with what they typed kept in the
 * meeting's notes for a person to reconcile. That person is the one who can
 * tell a returning prospect from someone using their name.
 *
 * ## Why this is the consent flow that matters
 *
 * §2.1 makes SMS and voice opt-in only. A booking form is where an opt-in
 * actually happens — someone types their number and ticks "you may call me"
 * — so the consent rows written here carry the source, the moment, and the
 * form's exact wording as evidence. A consent with no evidence of what was
 * agreed to is a claim, and §2.1 is not a place for claims. Consent is
 * written ONLY for a contact this request created, because only then is the
 * person who ticked the box certainly the person the row is about.
 *
 * ## What it refuses to guess
 *
 * The visitor's timezone comes from their browser and is validated; without
 * one, the request is recorded but nothing can be sent to them (the send
 * path refuses `unknown_timezone`) — a person follows up by hand. A phone
 * number that cannot be normalised is not stored: an unmatchable number is
 * one the suppression list can never protect.
 *
 * ## Atomicity
 *
 * The whole thing is one transaction. It was not, and a booking that failed
 * at the meeting left a company, a contact and their consent rows behind —
 * an unauthenticated way to put rows in the database while the caller was
 * told the booking failed.
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
  | {
      readonly ok: true
      readonly meetingId: string
      readonly companyDomain: string
      /** True when the booking matched records already on file and changed none of them. */
      readonly needsReview: boolean
    }
  | { readonly ok: false; readonly message: string; readonly status: 400 | 404 }

/** How far ahead a stranger may book. Also the guard that keeps a Date at the
 *  far end of the range out of the database, which used to 500 the route. */
const MAX_DAYS_AHEAD = 365

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
 * Creates the company and the contact if they are new, writes their consent
 * rows, and records the meeting. Idempotent enough for a double-submit: a
 * second request from the same address adds a second meeting flagged for
 * review, which a person then tidies — better than refusing a real lead for
 * clicking twice.
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
  // Bounded at BOTH ends. An unbounded upper end let a Date near the maximum
  // JS timestamp through to Postgres, which rejected it — after the rest of
  // the booking had already been written.
  const latest = now.getTime() + MAX_DAYS_AHEAD * 86_400_000
  if (Number.isNaN(req.startsAt.getTime()) || req.startsAt.getTime() < now.getTime() - 60_000) {
    return { ok: false, status: 400, message: 'Please pick a time in the future.' }
  }
  if (req.startsAt.getTime() > latest) {
    return { ok: false, status: 400, message: `Please pick a time within the next ${MAX_DAYS_AHEAD} days.` }
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

  // Who do we already know? Decided BEFORE anything is written, because it
  // decides what may be written at all.
  const [existingCompany] = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(and(eq(schema.companies.orgId, org.id), eq(schema.companies.domain, companyDomain)))
    .limit(1)
  const [knownContact] = await db
    .select({ id: schema.contacts.id, companyId: schema.contacts.companyId })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, org.id), eq(schema.contacts.email, email)))
    .limit(1)

  const recognised = Boolean(existingCompany || knownContact)
  /**
   * They ticked a box for a channel §2.1 makes opt-in only — and nothing here
   * has verified that the number is theirs. Somebody can type a stranger's
   * number and tick "you may call me". Cold voice and SMS are structurally
   * impossible regardless (`decideSend` refuses them without a consent row,
   * and Phase 6 is not deployed), but the row this writes is exactly the one
   * that would later unlock them, so a person confirms it before it is worth
   * anything. Real verification is an OTP to that number, which belongs with
   * Phase 6 where there is something that can send one.
   */
  const claimsPhoneChannel = req.consent.sms || req.consent.voice || req.consent.whatsapp

  /** Computed once: the row that is written and the answer that is returned
   *  must be the same fact, or the caller reports something else happened. */
  const needsReview = recognised || claimsPhoneChannel

  // What they told us about themselves. Kept as TEXT on the meeting when we
  // may not act on it, so the team can see the claim and decide.
  const claimed: string[] = []
  if (knownContact) {
    if (phone) claimed.push(`phone given: ${phone}`)
    claimed.push(`timezone given: ${req.timeZone}`)
    const ticked = (['sms', 'voice', 'whatsapp'] as const).filter((c) => req.consent[c])
    claimed.push(
      ticked.length > 0
        ? `ticked consent for ${ticked.join(', ')} — NOT recorded, because this address was already on file. Confirm who booked before acting on it.`
        : 'no channel consent ticked.',
    )
  }
  const notes = [req.notes?.trim().slice(0, 2000) || null, claimed.length > 0 ? `[unverified booking] ${claimed.join(' · ')}` : null]
    .filter(Boolean)
    .join('\n\n') || null

  try {
    const result = await db.transaction(async (tx) => {
      const txDb = tx as unknown as AgencyDb

      let companyId: string
      if (knownContact) {
        // The team's own filing wins over the address's domain. Someone whose
        // address is @acme-group.com may be filed under acme.com because a
        // person put them there; deriving the company from the domain instead
        // invented a second company row AND then refused the booking, because
        // `createMeeting` rightly will not put a contact in a meeting with a
        // company they do not belong to.
        companyId = knownContact.companyId
      } else if (existingCompany) {
        companyId = existingCompany.id
      } else {
        const inserted = await txDb
          .insert(schema.companies)
          .values({
            orgId: org.id,
            domain: companyDomain,
            name: req.company?.trim().slice(0, 120) || (freeMail ? name : null),
            // 0015 added 'inbound'. It used to be 'manual', which reads as
            // "somebody on the team typed this" — and this row's name came
            // from a stranger's form and reaches the agent's context.
            source: 'inbound',
            timeZone: req.timeZone,
          })
          .returning({ id: schema.companies.id })
        companyId = inserted[0]!.id
      }

      let contactId: string
      const createdContact = !knownContact
      if (knownContact) {
        // Deliberately nothing. Their phone and timezone are the team's
        // record of them; an anonymous form does not get to rewrite either.
        contactId = knownContact.id
      } else {
        const [first, ...rest] = name.split(/\s+/)
        const inserted = await txDb
          .insert(schema.contacts)
          .values({
            orgId: org.id,
            companyId,
            firstName: first ?? null,
            lastName: rest.join(' ') || null,
            email,
            phone,
            timeZone: req.timeZone,
            // 0003's CHECK: apollo | manual | import | agent | inbound. An
            // inbound lead is what this is; the booking page is recorded on
            // the meeting.
            source: 'inbound',
          })
          .returning({ id: schema.contacts.id })
        contactId = inserted[0]!.id
      }

      // Consent, per channel, with the form's wording as evidence (§2.1) —
      // and ONLY for a contact this request created. For an address already
      // on file, the person who ticked the box is not certainly the person
      // the row is about, and overwriting a recorded refusal is the one
      // thing §2.1 says can never be approved past.
      if (createdContact) {
        const evidence = {
          form: 'booking_page',
          wording: req.consentWording.slice(0, 1000),
          at: now.toISOString(),
          // Stated plainly in the evidence, because the evidence is what gets
          // produced if anybody ever asks how this consent was obtained.
          phoneVerified: false,
        }
        const source = `booking page, ${now.toISOString().slice(0, 10)}`
        await recordConsent(txDb, { orgId: org.id, contactId, channel: 'email', granted: true, source, evidence })
        for (const channel of ['sms', 'voice', 'whatsapp'] as const) {
          if (req.consent[channel]) {
            await recordConsent(txDb, { orgId: org.id, contactId, channel, granted: true, source, evidence })
          }
        }
      }

      const meeting = await createMeeting(txDb, {
        orgId: org.id,
        companyId,
        contactId,
        title: `Intro call with ${name}`,
        startsAt: req.startsAt,
        endsAt: new Date(req.startsAt.getTime() + 30 * 60_000),
        timeZone: req.timeZone,
        source: 'booking_page',
        notes,
        actor: 'booking_page',
        needsReview,
        // A recognised company's deal is not moved by a stranger. A brand new
        // lead's is: there is nothing pre-existing to corrupt, and landing the
        // lead on the board is what the booking link is for (§8.6).
        moveDeal: !recognised,
      })
      if (!meeting.ok) throw new BookingRefused(meeting.message)

      await appendAudit(txDb, {
        orgId: org.id,
        actor: 'booking_page',
        action: 'lead.inbound',
        subjectType: 'contact',
        subjectId: contactId,
        detail: {
          companyId,
          meetingId: meeting.meeting.id,
          recognised,
          createdContact,
          createdCompany: !existingCompany,
          consented: createdContact
            ? ['email', ...(['sms', 'voice', 'whatsapp'] as const).filter((c) => req.consent[c])]
            : [],
        },
      }).catch(() => {})

      return { meetingId: meeting.meeting.id }
    })

    return { ok: true, meetingId: result.meetingId, companyDomain, needsReview }
  } catch (err) {
    if (err instanceof BookingRefused) return { ok: false, status: 400, message: err.message }
    throw err
  }
}

/** Carries `createMeeting`'s sentence out through the transaction rollback. */
class BookingRefused extends Error {}
