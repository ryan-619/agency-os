/**
 * Typed schema for every table created by packages/db/migrations.
 *
 * The migrations are the source of truth for the DATABASE; this file is the
 * source of truth for TYPES. They are kept in step by a test that migrates a
 * real Postgres engine from zero and compares every table and column against
 * what is declared here (packages/db/test/schema-parity.test.ts), so drift
 * fails CI instead of failing in production.
 *
 * Property names are camelCase, column names snake_case. The auth tables use
 * the exact property names @auth/drizzle-adapter expects (id, name, email,
 * emailVerified, image / userId, providerAccountId / sessionToken ...), which
 * is why those differ in style from the columns underneath them.
 */
import { relations, sql } from 'drizzle-orm'
import {
  boolean, date, doublePrecision, index, integer, jsonb, numeric, pgTable, primaryKey, smallint, text,
  time, timestamp, uniqueIndex, uuid, bigint,
} from 'drizzle-orm/pg-core'

/** Columns every table carries (PROMPT.md §4). */
const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}

const id = () => uuid('id').primaryKey().defaultRandom()

// ---------------------------------------------------------------------------
// Organisation and team
// ---------------------------------------------------------------------------

export const orgs = pgTable('orgs', {
  id: id(),
  name: text('name').notNull(),
  /** The public booking page lives at /book/<slug>. NULL means none (0012). */
  bookingSlug: text('booking_slug').unique(),
  ...timestamps,
})

export const users = pgTable(
  'users',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    name: text('name'),
    /** 'owner' | 'member'. Only owner may edit connectors and credentials (§4). */
    role: text('role').notNull().default('member'),
    /** Offboarding is a role change, not a row deletion (0004's own words;
     *  0018). A revoked user keeps every row that names them — approvals,
     *  handled replies, costs — and can no longer sign in or run a turn. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // --- Auth.js adapter columns ---
    emailVerified: timestamp('email_verified', { withTimezone: true }),
    image: text('image'),
    ...timestamps,
  },
  (t) => [index('users_org_id_idx').on(t.orgId)],
)

export const accounts = pgTable(
  'accounts',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerAccountId] }),
    index('accounts_user_id_idx').on(t.userId),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    sessionToken: text('session_token').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
)

/** Magic-link tokens. Short-lived credentials — never log a row from here (§2.3). */
export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
)

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    /** A users.id, or the literal 'agent'. Text, not a foreign key. */
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    subjectType: text('subject_type'),
    subjectId: uuid('subject_id'),
    detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
    ...timestamps,
  },
  (t) => [
    index('audit_log_org_created_idx').on(t.orgId, t.createdAt.desc()),
    index('audit_log_subject_idx').on(t.subjectType, t.subjectId),
  ],
)

// ---------------------------------------------------------------------------
// ICP, companies, evidence
// ---------------------------------------------------------------------------

export const icpProfiles = pgTable(
  'icp_profiles',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    definition: jsonb('definition').notNull(),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('icp_profiles_org_name_key').on(t.orgId, t.name),
    // 0021: one active profile per org; `activate_icp` swaps it in one transaction.
    uniqueIndex('icp_profiles_one_active_per_org').on(t.orgId).where(sql`active`),
  ],
)

export const companies = pgTable(
  'companies',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    name: text('name'),
    country: text('country'),
    /** IANA zone for the company's main office. A FALLBACK for a contact who
     *  has none — never derived from `country`, which is not a timezone (0010). */
    timeZone: text('time_zone'),
    /** Funding stage, one of `COMPANY_STAGES` (application-checked; 0021 explains why not a CHECK). */
    stage: text('stage'),
    /** A claim from research, never a scan observation: shown with `headcountSource` (0021). */
    headcount: integer('headcount'),
    title: text('title'),
    /** What the company is, from research (0021): bounded, and never a finding. */
    industry: text('industry'),
    city: text('city'),
    description: text('description'),
    /** Where the headcount came from — a URL or a short note. Never without a headcount (0021). */
    headcountSource: text('headcount_source'),
    /** The listing's main line, E.164 by CHECK (0022). A business's number, never a person's contact record. */
    phone: text('phone'),
    /** As the listing gives it (0022). */
    address: text('address'),
    /** Google Maps place id: one company per place in an org (0022). */
    googlePlaceId: text('google_place_id'),
    googleMapsUrl: text('google_maps_url'),
    /** 0.0–5.0, as the listing showed it when read. */
    googleRating: numeric('google_rating', { precision: 2, scale: 1 }),
    googleReviewCount: integer('google_review_count'),
    /** The listing's primary type, e.g. `dentist`. */
    googleCategory: text('google_category'),
    /** The website the LISTING names — maybe a Facebook page or a directory entry, never assumed to be theirs. */
    listingWebsite: text('listing_website'),
    /** When the listing facts were read; a listing fact is never stored without it (0022). */
    listingCheckedAt: timestamp('listing_checked_at', { withTimezone: true }),
    /** Google's coordinates for the listing (0023); a pair, dated by `listingCheckedAt`. */
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    /** 'apollo' | 'manual' | 'import' | 'agent' | 'inbound' | 'google_maps' */
    source: text('source').notNull().default('manual'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('companies_org_domain_key').on(t.orgId, t.domain),
    uniqueIndex('companies_org_place_key').on(t.orgId, t.googlePlaceId).where(sql`google_place_id IS NOT NULL`),
  ],
)

export const scans = pgTable(
  'scans',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
    ok: boolean('ok').notNull(),
    error: text('error'),
    /** Full response headers, TLS info and script srcs. */
    raw: jsonb('raw').notNull().default(sql`'{}'::jsonb`),
    ...timestamps,
  },
  (t) => [index('scans_company_ran_idx').on(t.companyId, t.ranAt.desc())],
)

export const findings = pgTable(
  'findings',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    /**
     * Part of a composite foreign key (scan_id, company_id, org_id) -> scans,
     * so a finding cannot be filed against a company its scan never touched.
     * Drizzle cannot express that here; the migration owns it.
     */
    scanId: uuid('scan_id').notNull(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    signalKey: text('signal_key').notNull(),
    /** §2.2 — false for a fetch failure, timeout, WAF block or CDN quirk. */
    observed: boolean('observed').notNull(),
    /** NULL whenever observed is false. The database enforces it. */
    gap: boolean('gap'),
    weight: integer('weight').notNull().default(0),
    detail: text('detail'),
    /** The header value seen, the URL fetched, the timestamp. */
    evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
    stale: boolean('stale').notNull().default(false),
    /** §2.2 (0018). False for an informational signal — observed, recorded,
     *  and NOT in the ICP. Such a row carries no weight, by CHECK, so nobody
     *  can read "also observed" as "a gap that counts". */
    scored: boolean('scored').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('findings_scan_signal_key').on(t.scanId, t.signalKey),
    index('findings_company_stale_idx').on(t.companyId, t.stale),
    index('findings_company_informational_idx').on(t.companyId),
  ],
)

export const scores = pgTable(
  'scores',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    /** The scan this score was computed from — see 0006. */
    scanId: uuid('scan_id').notNull(),
    icpProfileId: uuid('icp_profile_id').notNull().references(() => icpProfiles.id, { onDelete: 'restrict' }),
    score: integer('score').notNull(),
    tier: text('tier'),
    qualified: boolean('qualified').notNull().default(false),
    disqualifiedReason: text('disqualified_reason'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    index('scores_company_computed_idx').on(t.companyId, t.computedAt.desc()),
    index('scores_org_qualified_idx').on(t.orgId, t.qualified, t.score.desc()),
    index('scores_scan_idx').on(t.scanId),
  ],
)

// ---------------------------------------------------------------------------
// People, consent, deals
// ---------------------------------------------------------------------------

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    firstName: text('first_name'),
    lastName: text('last_name'),
    title: text('title'),
    email: text('email'),
    phone: text('phone'),
    linkedinUrl: text('linkedin_url'),
    source: text('source').notNull().default('manual'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** IANA zone. §2.1 evaluates quiet hours HERE, not at the sender. Null is
     *  a refusal, not a default — see `decideSend` (0010). */
    timeZone: text('time_zone'),
    /** Set the moment this contact replies. Pauses every sequence they are in,
     *  in every campaign, without anything having to enumerate them (0010). */
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    /** NOT NULL whenever `pausedAt` is: a pause with no cause gets cleared by
     *  whoever finds it. */
    pausedReason: text('paused_reason'),
    /** A permanent bounce is evidence about an ADDRESS, not a person asking
     *  to be left alone — so it is a column and a refusal, never a
     *  suppression row (0018). The code is the DSN's own RFC 3463 status. */
    emailBouncedAt: timestamp('email_bounced_at', { withTimezone: true }),
    /** NOT NULL exactly when `emailBouncedAt` is: the evidence for the mark. */
    emailBounceCode: text('email_bounce_code'),
    ...timestamps,
  },
  (t) => [
    index('contacts_company_idx').on(t.companyId),
    index('contacts_paused_idx').on(t.orgId, t.pausedAt),
  ],
)

/** One row per channel per contact. Absence means NO (§2.1). */
export const consents = pgTable(
  'consents',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    /** 'email' | 'sms' | 'voice' | 'whatsapp' */
    channel: text('channel').notNull(),
    granted: boolean('granted').notNull(),
    source: text('source').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
    ...timestamps,
  },
  (t) => [uniqueIndex('consents_contact_channel_key').on(t.contactId, t.channel)],
)

/** Wins over everything. Checked in the send path, not the campaign builder (§2.1). */
export const suppressions = pgTable(
  'suppressions',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    /** 'email' | 'domain' | 'phone' | 'linkedin' (0016) */
    kind: text('kind').notNull(),
    /** Stored already normalised by packages/core. */
    value: text('value').notNull(),
    reason: text('reason').notNull(),
    /** 'manual' | 'reply' | 'voice' | 'unsubscribe' | 'erasure' | null —
     *  WHICH path recorded the opt-out (0018). Null on rows written before
     *  the column existed; inventing a value for them would be a claim. */
    source: text('source'),
    ...timestamps,
  },
  (t) => [uniqueIndex('suppressions_org_kind_value_key').on(t.orgId, t.kind, t.value)],
)

export const deals = pgTable(
  'deals',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    /** new | contacted | replied | meeting | proposal | won | lost */
    stage: text('stage').notNull().default('new'),
    valueCents: bigint('value_cents', { mode: 'number' }),
    currency: text('currency').notNull().default('USD'),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    nextAction: text('next_action'),
    nextActionAt: timestamp('next_action_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    lostReason: text('lost_reason'),
    ...timestamps,
  },
  (t) => [
    index('deals_org_stage_idx').on(t.orgId, t.stage),
    index('deals_company_idx').on(t.companyId),
    uniqueIndex('deals_one_open_per_company').on(t.orgId, t.companyId),
  ],
)

// ---------------------------------------------------------------------------
// Outreach
// ---------------------------------------------------------------------------

export const meetings = pgTable(
  'meetings',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    /** SET NULL: the meeting happened even if the person's row is removed. */
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    dealId: uuid('deal_id').references(() => deals.id, { onDelete: 'set null' }),
    title: text('title'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    /** A meeting is a wall-clock commitment; the zone says which "2 o'clock". */
    timeZone: text('time_zone').notNull(),
    /** 'manual' | 'agent' | 'booking_page' */
    source: text('source').notNull().default('manual'),
    /** The calendar event id or the booking request id. Never a credentialed link. */
    externalRef: text('external_ref'),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** An unauthenticated booking matched records already on file (0015).
     *  Nothing about them was modified; a person confirms who booked. */
    needsReview: boolean('needs_review').notNull().default(false),
    /** 'held' | 'no_show' | 'rescheduled' | null — what happened, the one
     *  fact a pipeline learns from a meeting (0018). Cancellation stays
     *  `cancelledAt`. */
    outcome: text('outcome'),
    ...timestamps,
  },
  (t) => [
    index('meetings_org_starts_idx').on(t.orgId, t.startsAt),
    index('meetings_company_idx').on(t.companyId, t.startsAt.desc()),
  ],
)

export const proposals = pgTable(
  'proposals',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id').references(() => deals.id, { onDelete: 'set null' }),
    /** The scan the scope was written from. RESTRICT: the evidence stays
     *  readable as long as the proposal does (0012, the 0006 discipline). */
    scanId: uuid('scan_id').notNull().references(() => scans.id, { onDelete: 'restrict' }),
    /** 'draft' | 'sent' | 'accepted' | 'declined' | 'withdrawn' */
    status: text('status').notNull().default('draft'),
    title: text('title').notNull(),
    /** The generated `Proposal` from packages/core, whole. */
    document: jsonb('document').notNull(),
    currency: text('currency').notNull().default('USD'),
    totalLow: integer('total_low'),
    totalHigh: integer('total_high'),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('proposals_org_status_idx').on(t.orgId, t.status, t.createdAt.desc()),
    index('proposals_company_idx').on(t.companyId, t.createdAt.desc()),
  ],
)

export const campaigns = pgTable(
  'campaigns',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    icpProfileId: uuid('icp_profile_id').references(() => icpProfiles.id, { onDelete: 'set null' }),
    channel: text('channel').notNull(),
    /** Default off. Turning it on is an owner-only decision (§2.4). */
    autoSend: boolean('auto_send').notNull().default(false),
    dailyCap: integer('daily_cap').notNull().default(25),
    /** Wall-clock local times, evaluated in the RECIPIENT's timezone (§2.1). */
    quietStart: time('quiet_start').notNull().default('21:00'),
    quietEnd: time('quiet_end').notNull().default('08:00'),
    status: text('status').notNull().default('draft'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('campaigns_org_name_key').on(t.orgId, t.name),
    index('campaigns_org_status_idx').on(t.orgId, t.status),
  ],
)

/** The single log of every message in either direction (§4). */
export const touches = pgTable(
  'touches',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    /** Nullable: the message log outlives the contact. See 0004_outreach.up.sql. */
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    /** What the message is ABOUT. A draft exists before its recipient does
     *  (0008), and Phase 4 needs it to re-verify the findings a draft quotes. */
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    channel: text('channel').notNull(),
    /** 'out' | 'in' */
    direction: text('direction').notNull(),
    status: text('status').notNull().default('queued'),
    subject: text('subject'),
    body: text('body'),
    /** The address or number actually used, kept so the log outlives the contact. */
    recipient: text('recipient'),
    providerId: text('provider_id'),
    /**
     * What kind of reply it was, for triage (0017). NULL means not
     * classified — different from 'other', which means classified and none
     * of these. Inbound only, and 'opted_out' is never a model's decision.
     */
    replyKind: text('reply_kind'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    error: text('error'),
    /** Why the send path refused, from `decideSend` — 'suppressed',
     *  'quiet_hours', 'daily_cap' and the rest. NOT NULL exactly when
     *  `status = 'refused'`. Distinct from `error`, which is something going
     *  wrong; a refusal is the system working (0010). */
    refusalCode: text('refusal_code'),
    // --- a person's decision on a draft (0011) ---------------------------
    /** RESTRICT, like approvals.decided_by: whoever approved a message that
     *  was sent stays identifiable as long as the record of the message. */
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'restrict' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** What the approver said. A denial's reason lives here too. */
    decisionNote: text('decision_note'),
    /** For an INBOUND message: the outbound touch it answers, matched by the
     *  In-Reply-To header against `provider_id`. Address matching alone is
     *  ambiguous once one person is in two campaigns (0011). */
    inReplyTo: uuid('in_reply_to'),
    // --- a person dealt with a reply (0018) --------------------------------
    /** When somebody read this INBOUND message and dealt with it. NULL is
     *  "nobody has". Inbound only, by CHECK. */
    handledAt: timestamp('handled_at', { withTimezone: true }),
    /** Who. RESTRICT, like `approvedBy`: the person stays identifiable as
     *  long as the record does — users are revoked, never deleted. The key
     *  is the composite (handled_by, org_id) → users (id, org_id), owned by
     *  the migration as `scanId`'s is: a reply cannot be handled by another
     *  org's user. */
    handledBy: uuid('handled_by'),
    /**
     * For an OUTBOUND draft: the inbound touch it answers, so the worker can
     * thread it (In-Reply-To/References from that row's `provider_id`) and
     * the inbox can show "answered". A self-reference, so it is declared
     * without `.references` — as `scanId` is — and the migration owns the
     * foreign key (SET NULL: deleting the reply must not delete the answer).
     */
    answersTouchId: uuid('answers_touch_id'),
    // --- a registered template, and what the operator said (0019) ---------
    /**
     * The template an SMS or WhatsApp message was rendered from. The key is
     * the composite (template_id, org_id, channel) → message_templates, owned
     * by the migration as `scanId`'s is: a message can only name a template
     * of its own org AND its own channel. RESTRICT: the registration a sent
     * message was checked against outlives it. Required, by CHECK, on an
     * outbound sms/whatsapp row in any state that can still go out.
     */
    templateId: uuid('template_id'),
    /**
     * What the operator's delivery report said, BESIDE `status` — which
     * stays the send path's word ('sent' = the provider took it). 'pending'
     * | 'delivered' | 'failed'; outbound only. `deliveredAt` is set exactly
     * when delivered, `deliveryError` (the report's reason, bounded) exactly
     * when failed. A failure is evidence about a number, never an opt-out.
     */
    deliveryStatus: text('delivery_status'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    deliveryError: text('delivery_error'),
    ...timestamps,
  },
  (t) => [
    index('touches_campaign_status_scheduled_idx').on(t.campaignId, t.status, t.scheduledFor),
    index('touches_contact_idx').on(t.contactId, t.createdAt.desc()),
    index('touches_company_idx').on(t.companyId, t.createdAt.desc()),
    index('touches_refused_idx').on(t.orgId, t.refusalCode, t.createdAt.desc()),
    index('touches_out_by_provider_id_idx').on(t.providerId),
    index('touches_in_by_provider_id_idx').on(t.providerId),
    index('touches_due_idx').on(t.status, t.scheduledFor),
    index('touches_org_inbox_idx').on(t.orgId, t.createdAt.desc()),
    index('touches_answers_idx').on(t.answersTouchId),
    index('touches_template_idx').on(t.templateId),
    /** Partial in the migration: inbound SMS rows with a provider id only. */
    uniqueIndex('touches_inbound_sms_provider_id_key').on(t.providerId),
  ],
)

export const calls = pgTable(
  'calls',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    /** SET NULL: the record of a call outlives the contact row (0004). */
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    /** 'in' | 'out' */
    direction: text('direction').notNull(),
    /** ringing | in_progress | completed | failed | no_answer | busy | cancelled (0014) */
    status: text('status').notNull().default('ringing'),
    fromNumber: text('from_number'),
    toNumber: text('to_number'),
    provider: text('provider').notNull().default('twilio'),
    providerCallSid: text('provider_call_sid'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationS: integer('duration_s'),
    recordingUrl: text('recording_url'),
    /** `TranscriptEntry[]` from packages/core. */
    transcript: jsonb('transcript').notNull().default(sql`'[]'::jsonb`),
    summary: text('summary'),
    /** qualified | not_qualified | handoff | opted_out | incomplete | no_answer | failed */
    outcome: text('outcome'),
    /** positive | neutral | negative */
    sentiment: text('sentiment'),
    handoffToUserId: uuid('handoff_to_user_id').references(() => users.id, { onDelete: 'set null' }),
    handoffReason: text('handoff_reason'),
    /** §2.1: the instant the AI said it was an AI. Written before it says anything else. */
    disclosedAiAt: timestamp('disclosed_ai_at', { withTimezone: true }),
    /** §2.1: the instant the caller asked to be left alone — and a suppression row was written. */
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
    /** For an OUTBOUND call: the touch whose approval placed it (§2.4). NOT NULL when direction = 'out'. */
    touchId: uuid('touch_id').references(() => touches.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('calls_contact_idx').on(t.contactId, t.startedAt.desc()),
    index('calls_org_started_idx').on(t.orgId, t.startedAt.desc()),
    index('calls_company_idx').on(t.companyId, t.startedAt.desc()),
  ],
)

/** The human-in-the-loop gate the agent's canUseTool blocks on (§5.4). */
export const approvals = pgTable(
  'approvals',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    /** A users.id, or the literal 'agent'. */
    requestedBy: text('requested_by').notNull(),
    toolName: text('tool_name').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    /** 'low' | 'medium' | 'high' */
    risk: text('risk').notNull(),
    status: text('status').notNull().default('pending'),
    /** RESTRICT: a user who has decided an approval cannot be deleted (§2.4). */
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** Why the human decided as they did. Only ever set on a decided row. */
    decidedReason: text('decided_reason'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // --- what this approval gates (0007) ---------------------------------
    /** The chat thread the call was made in. SET NULL: the decision outlives
     *  the conversation. */
    chatSessionId: uuid('chat_session_id').references(() => chatSessions.id, { onDelete: 'set null' }),
    /** One agent turn. Scopes the retry key below. */
    turnId: uuid('turn_id'),
    /** The SDK's `options.toolUseID`. Unique per org: the redelivery key. */
    toolUseId: text('tool_use_id'),
    /** sha256 of the canonical payload, so a denied-then-retried call — which
     *  carries a NEW tool_use_id — is recognised as the same human intent. */
    payloadSha256: text('payload_sha256'),
    ...timestamps,
  },
  (t) => [
    index('approvals_org_status_idx').on(t.orgId, t.status),
    index('approvals_chat_session_idx').on(t.chatSessionId, t.createdAt.desc()),
    uniqueIndex('approvals_org_tool_use_key').on(t.orgId, t.toolUseId),
    uniqueIndex('approvals_org_turn_payload_key').on(t.orgId, t.turnId, t.toolName, t.payloadSha256),
  ],
)

// ---------------------------------------------------------------------------
// Agent runtime
// ---------------------------------------------------------------------------

/**
 * Third-party credentials, encrypted at rest (§2.3, migration 0009).
 *
 * `ciphertext` holds nonce, tag and body together under AES-256-GCM, and the
 * master key lives only in the environment — so a dump of this table decrypts
 * to nothing on its own.
 */
export const secrets = pgTable(
  'secrets',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    /** What the credential is for, in words. Never the value. */
    label: text('label').notNull(),
    ciphertext: text('ciphertext').notNull(),
    /** Which master key encrypted it, so a rotation does not brick the rest. */
    keyVersion: integer('key_version').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('secrets_org_idx').on(t.orgId, t.createdAt.desc())],
)

/** Runtime MCP server registry — what makes the tool set customizable (§6). */
export const connectors = pgTable(
  'connectors',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 'stdio' | 'http' | 'sse' */
    kind: text('kind').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
    /** Pointer to the encrypted credential. Never the credential itself (§2.3). */
    /** Points at `secrets.id`. Never holds a credential (§2.3, 0009). */
    secretRef: uuid('secret_ref').references(() => secrets.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('connectors_org_name_key').on(t.orgId, t.name),
    index('connectors_org_enabled_idx').on(t.orgId, t.enabled),
  ],
)

/** Subagents as data, mapped onto the SDK's `agents` option (§7). */
export const agentDefs = pgTable(
  'agent_defs',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    tools: text('tools').array().notNull().default(sql`'{}'`),
    model: text('model'),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('agent_defs_org_slug_key').on(t.orgId, t.slug)],
)

export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** From the SDK's final `result` message; passed back as `resume` (§5.3). */
    sdkSessionId: text('sdk_session_id'),
    title: text('title'),
    archived: boolean('archived').notNull().default(false),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set while a turn is running, so a worker restart is visible as an
     *  interrupted turn rather than as a spinner that never resolves (0007). */
    runningTurnId: uuid('running_turn_id'),
    runningSince: timestamp('running_since', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('chat_sessions_sdk_id_key').on(t.orgId, t.sdkSessionId)],
)

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
    /** 'user' | 'assistant' | 'tool' | 'system' */
    role: text('role').notNull(),
    content: jsonb('content').notNull().default(sql`'{}'::jsonb`),
    toolName: text('tool_name'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    /** NOTE: drizzle `numeric` with no mode is typed STRING on read and write.
     *  Adding two of these with `+` concatenates. */
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    // --- ordering within a turn (0007) ------------------------------------
    /** One agent turn. Null on rows written before 0007. */
    turnId: uuid('turn_id'),
    /** Position within the turn. created_at is not enough: several frames of
     *  one turn land inside the same millisecond. */
    seq: integer('seq'),
    /** Ties a tool call and its result together, and makes a replayed frame
     *  idempotent rather than a duplicate. */
    toolUseId: text('tool_use_id'),
    ...timestamps,
  },
  (t) => [
    index('chat_messages_session_created_idx').on(t.sessionId, t.createdAt),
    index('chat_messages_turn_idx').on(t.sessionId, t.turnId, t.seq),
    uniqueIndex('chat_messages_tool_use_key').on(t.sessionId, t.toolUseId, t.role),
  ],
)

// ---------------------------------------------------------------------------
// Notes, tasks, share links (0018)
// ---------------------------------------------------------------------------

/**
 * A teammate's words about a company, optionally about one of its contacts.
 *
 * Kept apart from evidence on purpose: nothing that writes a proposal or a
 * brief may read this table, and packages/core's tests assert that by
 * source. A note is what somebody thinks; a finding is what the scanner saw.
 */
export const notes = pgTable(
  'notes',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    /** Same-org composite FK to contacts (id, org_id), CASCADE — owned by 0018. */
    contactId: uuid('contact_id'),
    /** RESTRICT: whoever wrote it stays identifiable as long as the note does.
     *  Same-org composite FK to users (id, org_id), owned by 0018. */
    authorUserId: uuid('author_user_id').notNull(),
    body: text('body').notNull(),
    pinned: boolean('pinned').notNull().default(false),
    ...timestamps,
  },
  (t) => [index('notes_company_idx').on(t.companyId, t.pinned, t.createdAt)],
)

/**
 * Where LinkedIn steps, kickoff checklists, renewal reminders and plain
 * to-dos land. `kind` is 'todo' | 'linkedin_send' | 'kickoff' | 'renewal'.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id').references(() => deals.id, { onDelete: 'set null' }),
    /** For a `linkedin_send`: the touch a person is asked to send by hand.
     *  Required for that kind, by CHECK; one OPEN task per touch. */
    touchId: uuid('touch_id').references(() => touches.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('todo'),
    title: text('title').notNull(),
    detail: text('detail'),
    /** SET NULL: an unassigned task is a normal state. Same-org composite FK
     *  to users (id, org_id), owned by 0018 — as are the two below. */
    assigneeUserId: uuid('assignee_user_id'),
    /** Nullable: the agent creates tasks and has no users row; the audit row
     *  names the actor. */
    createdBy: uuid('created_by'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    doneAt: timestamp('done_at', { withTimezone: true }),
    /** RESTRICT: a done task names a person who stays identifiable. NOT NULL
     *  exactly when `doneAt` is. */
    doneBy: uuid('done_by'),
    ...timestamps,
  },
  (t) => [
    index('tasks_org_open_idx').on(t.orgId, t.dueAt),
    index('tasks_company_idx').on(t.companyId),
    uniqueIndex('tasks_one_open_per_touch').on(t.touchId),
  ],
)

/**
 * A buyer link to a proposal.
 *
 * The token is a bearer credential and ONLY its sha256 is stored — the CHECK
 * makes a raw token unstorable (§2.3). A view is a count and two instants,
 * never an IP or a user agent. An acceptance names the person who typed their
 * name, never a session, because the buyer has none.
 */
export const proposalShares = pgTable(
  'proposal_shares',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    proposalId: uuid('proposal_id').notNull().references(() => proposals.id, { onDelete: 'cascade' }),
    /** sha256 of the token, lower-case hex. Never the token. */
    tokenHash: text('token_hash').notNull(),
    /** RESTRICT; same-org composite FK to users (id, org_id), owned by 0018. */
    createdBy: uuid('created_by').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    viewCount: integer('view_count').notNull().default(0),
    firstViewedAt: timestamp('first_viewed_at', { withTimezone: true }),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    /** NOT NULL exactly when `acceptedAt` is, and never blank. */
    acceptedByName: text('accepted_by_name'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('proposal_shares_token_hash_key').on(t.tokenHash),
    index('proposal_shares_proposal_idx').on(t.proposalId, t.createdAt.desc()),
  ],
)

/**
 * A message template registered with the regulator or the platform (0019).
 *
 * Under TRAI's TCCCPR 2018 every commercial SMS to an Indian number must be a
 * template registered on DLT — the header and template id a registered pair,
 * the text the registered body with each `{#var#}` filled — or the operator
 * scrubs it. A row is that registration, copied in by a person or from the
 * DLT portal's CSV export; `packages/core/src/dlt.ts` reads its body.
 */
/**
 * What the AI is told about the agency, and its morning brief (0020). One
 * row per org, written from Settings → Assistant. The playbook is appended to
 * the AI's instructions on every turn as a description, never a rule; the
 * brief is one unattended turn a day at `briefAt` in `briefTimeZone`, in
 * `briefUserId`'s name, claimed for the zone's own date (`briefLastRunOn`).
 */
export const assistantSettings = pgTable(
  'assistant_settings',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    /** At most 20,000 characters, by CHECK. */
    playbook: text('playbook').notNull().default(''),
    /** SET NULL (playbook_updated_by); same-org composite FK, owned by the migration. */
    playbookUpdatedBy: uuid('playbook_updated_by'),
    /** When the playbook was last saved — `updated_at` moves on every write, the daily claim's included. */
    playbookUpdatedAt: timestamp('playbook_updated_at', { withTimezone: true }),
    briefEnabled: boolean('brief_enabled').notNull().default(false),
    /** SET NULL (brief_user_id); same-org composite FK, owned by the migration. */
    briefUserId: uuid('brief_user_id'),
    /** HH:MM, by CHECK, read in `briefTimeZone`. */
    briefAt: text('brief_at').notNull().default('08:30'),
    briefTimeZone: text('brief_time_zone').notNull().default('Asia/Kolkata'),
    /** The zone's own date of the last brief, as 'YYYY-MM-DD'. */
    briefLastRunOn: date('brief_last_run_on', { mode: 'string' }),
    /** "Run it now": started by the worker's next look whatever the clock says, cleared by its claim. */
    briefRequestedAt: timestamp('brief_requested_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('assistant_settings_one_per_org').on(t.orgId)],
)

/**
 * What the agency sells (0022): a name, a price range and the NEEDS it answers
 * (`NEED_KEYS` in packages/core). Prices are whole units of `currency`.
 */
export const services = pgTable(
  'services',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    needs: text('needs').array().notNull().default(sql`'{}'::text[]`),
    priceFrom: integer('price_from'),
    priceTo: integer('price_to'),
    currency: text('currency').notNull().default('INR'),
    /** 'one_off' | 'monthly' | 'yearly' | 'hourly' | 'daily' */
    priceUnit: text('price_unit').notNull().default('one_off'),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('services_org_name_key').on(t.orgId, sql`lower(btrim(${t.name}))`)],
)

/**
 * What Google's PageSpeed Insights measured of a company's homepage (0022).
 * A failed audit carries its reason and no score, by CHECK.
 */
export const siteAudits = pgTable(
  'site_audits',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    /** CASCADE; same-org composite FK (company_id, org_id), owned by the migration. */
    companyId: uuid('company_id').notNull(),
    /** 'pagespeed' */
    source: text('source').notNull().default('pagespeed'),
    /** 'mobile' | 'desktop' */
    strategy: text('strategy').notNull(),
    url: text('url').notNull(),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
    ok: boolean('ok').notNull(),
    error: text('error'),
    performance: integer('performance'),
    accessibility: integer('accessibility'),
    bestPractices: integer('best_practices'),
    seo: integer('seo'),
    lcpMs: integer('lcp_ms'),
    cls: numeric('cls', { precision: 6, scale: 3 }),
    tbtMs: integer('tbt_ms'),
    fcpMs: integer('fcp_ms'),
    /** The field data's overall category: 'FAST' | 'AVERAGE' | 'SLOW'; null when Google has none. */
    fieldCategory: text('field_category'),
    ...timestamps,
  },
  (t) => [index('site_audits_company_ran_idx').on(t.companyId, t.ranAt)],
)

/**
 * The agency's own profile (0023): what a quote prints about the seller —
 * legal name, address, GSTIN and the GST it charges (only with a GSTIN, by
 * CHECK), the UPI ID an advance is paid to, validity and terms, and a
 * brochure link. One row per org.
 */
export const orgProfiles = pgTable('org_profiles', {
  id: id(),
  orgId: uuid('org_id').notNull().unique().references(() => orgs.id, { onDelete: 'cascade' }),
  legalName: text('legal_name'),
  address: text('address'),
  phone: text('phone'),
  email: text('email'),
  website: text('website'),
  gstin: text('gstin'),
  gstRate: numeric('gst_rate', { precision: 5, scale: 2 }).notNull().default('0'),
  upiVpa: text('upi_vpa'),
  upiPayee: text('upi_payee'),
  advancePercent: smallint('advance_percent').notNull().default(50),
  quoteValidityDays: smallint('quote_validity_days').notNull().default(15),
  quoteTerms: text('quote_terms'),
  brochureUrl: text('brochure_url'),
  /** Composite FK (updated_by, org_id) → users, SET NULL — in the migration. */
  updatedBy: uuid('updated_by'),
  ...timestamps,
})

/**
 * A priced offer of the agency's own services (0023): line items, totals the
 * database holds to `total = subtotal + tax`, the needs it answers with their
 * dated evidence, and — once sent — the seller as it was then.
 */
export const quotes = pgTable(
  'quotes',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    /** Composite FK (company_id, org_id) → companies, CASCADE — in the migration. */
    companyId: uuid('company_id').notNull(),
    /** Composite FK (contact_id, org_id) → contacts, SET NULL — in the migration. */
    contactId: uuid('contact_id'),
    number: text('number').notNull(),
    title: text('title').notNull(),
    intro: text('intro'),
    items: jsonb('items').notNull().default(sql`'[]'::jsonb`),
    currency: text('currency').notNull().default('INR'),
    subtotal: bigint('subtotal', { mode: 'number' }).notNull().default(0),
    taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull().default('0'),
    taxAmount: bigint('tax_amount', { mode: 'number' }).notNull().default(0),
    total: bigint('total', { mode: 'number' }).notNull().default(0),
    advancePercent: smallint('advance_percent').notNull().default(0),
    advanceAmount: bigint('advance_amount', { mode: 'number' }).notNull().default(0),
    needs: jsonb('needs').notNull().default(sql`'[]'::jsonb`),
    terms: text('terms'),
    /** YYYY-MM-DD, the last day it may be accepted, in India's day. */
    validUntil: date('valid_until').notNull(),
    seller: jsonb('seller'),
    /** 'draft' | 'sent' | 'accepted' | 'declined' | 'withdrawn' */
    status: text('status').notNull().default('draft'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByName: text('accepted_by_name'),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    declineReason: text('decline_reason'),
    /** Composite FK (created_by, org_id) → users, SET NULL — in the migration. */
    createdBy: uuid('created_by'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('quotes_org_number_key').on(t.orgId, t.number),
    index('quotes_company_created_idx').on(t.companyId, t.createdAt),
  ],
)

/**
 * A link a business opens (0023): its quote, its audit page or a preview of
 * the website the agency would build. Only the token's sha256 is stored.
 */
export const shareLinks = pgTable(
  'share_links',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    /** 'quote' | 'report' | 'preview' */
    kind: text('kind').notNull(),
    /** Composite FK (company_id, org_id) → companies, CASCADE — in the migration. */
    companyId: uuid('company_id').notNull(),
    quoteId: uuid('quote_id').references(() => quotes.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    /** Composite FK (created_by, org_id) → users, SET NULL — in the migration. */
    createdBy: uuid('created_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    viewCount: integer('view_count').notNull().default(0),
    firstViewedAt: timestamp('first_viewed_at', { withTimezone: true }),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('share_links_company_created_idx').on(t.companyId, t.createdAt),
    index('share_links_quote_idx').on(t.quoteId).where(sql`quote_id IS NOT NULL`),
  ],
)

// ---------------------------------------------------------------------------
// Follow-up sequences (0024)
// ---------------------------------------------------------------------------

/** A campaign's steps after its opener: another message on its channel, a call or a visit. */
export const campaignSteps = pgTable(
  'campaign_steps',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    /** Composite FK (campaign_id, org_id) → campaigns, CASCADE — in the migration. */
    campaignId: uuid('campaign_id').notNull(),
    /** 2 onwards: the opener is step 1, written by enrolment. */
    position: smallint('position').notNull(),
    /** 'message' | 'call' | 'visit' */
    kind: text('kind').notNull(),
    /** Days after the step before: after its message was sent, or its task made. */
    afterDays: smallint('after_days').notNull(),
    subject: text('subject'),
    /** A message's words, with {first_name}, {company} and {agency}; NULL for a call or a visit. */
    body: text('body'),
    ...timestamps,
  },
  (t) => [uniqueIndex('campaign_steps_position_key').on(t.campaignId, t.position)],
)

/** One person's way through a campaign's steps; stopped the moment they reply. */
export const sequenceRuns = pgTable(
  'sequence_runs',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    /** Composite FK (campaign_id, org_id) → campaigns, CASCADE — in the migration. */
    campaignId: uuid('campaign_id').notNull(),
    /** Composite FK (contact_id, org_id) → contacts, CASCADE — in the migration. */
    contactId: uuid('contact_id').notNull(),
    /** When the opener went; a reply after it stops the run. */
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    nextPosition: smallint('next_position').notNull().default(2),
    /** When the step before was taken: its message sent, or its task made. */
    anchorAt: timestamp('anchor_at', { withTimezone: true }).notNull(),
    /** Composite FK (waiting_touch_id, org_id) → touches, SET NULL — in the migration. */
    waitingTouchId: uuid('waiting_touch_id'),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    /** 'replied' | 'paused' | 'refused' | 'deal_closed' | 'campaign_ended' | 'finished' */
    stopReason: text('stop_reason'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('sequence_runs_campaign_contact_key').on(t.campaignId, t.contactId),
    index('sequence_runs_live_idx').on(t.orgId, t.anchorAt).where(sql`stopped_at IS NULL`),
  ],
)

export const messageTemplates = pgTable(
  'message_templates',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    /** 'sms' | 'whatsapp' | 'voice' */
    channel: text('channel').notNull(),
    /** 'dovesoft' */
    provider: text('provider').notNull().default('dovesoft'),
    /** The DLT content-template id (SMS, voice) or Meta's template name (WhatsApp). */
    externalId: text('external_id').notNull(),
    /** The DLT header (SMS: six characters, upper-case), the WABA number, or the calling line. */
    senderId: text('sender_id').notNull(),
    /** SMS/voice: 'promotional' | 'transactional' | 'service_implicit' |
     *  'service_explicit'. WhatsApp: 'marketing' | 'utility' | 'authentication'.
     *  Per channel, by CHECK. */
    category: text('category').notNull(),
    /** The registered text, with its `{#var#}` slots. */
    body: text('body').notNull(),
    name: text('name'),
    language: text('language').notNull().default('en'),
    active: boolean('active').notNull().default(true),
    /** SET NULL (created_by); same-org composite FK to users (id, org_id),
     *  owned by the migration. */
    createdBy: uuid('created_by'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('message_templates_org_channel_external_key').on(t.orgId, t.channel, t.externalId),
    uniqueIndex('message_templates_id_org_channel_key').on(t.id, t.orgId, t.channel),
    index('message_templates_org_active_idx').on(t.orgId, t.channel, t.active),
  ],
)

// ---------------------------------------------------------------------------
// System tables (0018)
// ---------------------------------------------------------------------------

/**
 * One row per worker instance, upserted every tick; the web reads the newest.
 *
 * A SYSTEM table with no `org_id`, like the auth tables: the worker serves
 * every org — `dueTouches` and the restart reconciler are cross-org — so
 * "the org's worker" is not a concept. A worker that scaled to zero leaves
 * approvals landing on nothing while `/readyz` answers fine (§2.4); this row
 * is how the web can say so.
 */
export const workerHeartbeats = pgTable(
  'worker_heartbeats',
  {
    id: id(),
    workerId: text('worker_id').notNull(),
    bootedAt: timestamp('booted_at', { withTimezone: true }).notNull(),
    /** Never before `bootedAt`, by CHECK. */
    lastTickAt: timestamp('last_tick_at', { withTimezone: true }).notNull(),
    /** 'disabled' | 'send-only' | 'send-and-receive' | 'receive-only' */
    outreach: text('outreach').notNull(),
    /** 'enabled' | 'disabled' */
    chat: text('chat').notNull(),
    /** Counts and names only. Never a credential, never a message body. */
    detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
    ...timestamps,
  },
  (t) => [uniqueIndex('worker_heartbeats_worker_key').on(t.workerId)],
)

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const orgsRelations = relations(orgs, ({ many }) => ({
  users: many(users),
  companies: many(companies),
}))

export const companiesRelations = relations(companies, ({ one, many }) => ({
  org: one(orgs, { fields: [companies.orgId], references: [orgs.id] }),
  scans: many(scans),
  findings: many(findings),
  scores: many(scores),
  contacts: many(contacts),
}))

export const scansRelations = relations(scans, ({ one, many }) => ({
  company: one(companies, { fields: [scans.companyId], references: [companies.id] }),
  findings: many(findings),
}))

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  company: one(companies, { fields: [contacts.companyId], references: [companies.id] }),
  consents: many(consents),
  touches: many(touches),
}))

export type Org = typeof orgs.$inferSelect
export type User = typeof users.$inferSelect
export type Company = typeof companies.$inferSelect
export type Finding = typeof findings.$inferSelect
export type Contact = typeof contacts.$inferSelect
export type Consent = typeof consents.$inferSelect
export type Suppression = typeof suppressions.$inferSelect
export type Campaign = typeof campaigns.$inferSelect
export type Touch = typeof touches.$inferSelect
export type Approval = typeof approvals.$inferSelect
export type Connector = typeof connectors.$inferSelect
export type AgentDef = typeof agentDefs.$inferSelect
export type Note = typeof notes.$inferSelect
export type Task = typeof tasks.$inferSelect
export type ProposalShare = typeof proposalShares.$inferSelect
export type WorkerHeartbeat = typeof workerHeartbeats.$inferSelect
export type MessageTemplate = typeof messageTemplates.$inferSelect
