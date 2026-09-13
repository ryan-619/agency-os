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
  boolean, index, integer, jsonb, numeric, pgTable, primaryKey, text,
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
  (t) => [uniqueIndex('icp_profiles_org_name_key').on(t.orgId, t.name)],
)

export const companies = pgTable(
  'companies',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    name: text('name'),
    country: text('country'),
    stage: text('stage'),
    headcount: integer('headcount'),
    title: text('title'),
    /** 'apollo' | 'manual' | 'import' | 'agent' */
    source: text('source').notNull().default('manual'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [uniqueIndex('companies_org_domain_key').on(t.orgId, t.domain)],
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
    ...timestamps,
  },
  (t) => [
    uniqueIndex('findings_scan_signal_key').on(t.scanId, t.signalKey),
    index('findings_company_stale_idx').on(t.companyId, t.stale),
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
    ...timestamps,
  },
  (t) => [index('contacts_company_idx').on(t.companyId)],
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
    /** 'email' | 'domain' | 'phone' */
    kind: text('kind').notNull(),
    /** Stored already normalised by packages/core. */
    value: text('value').notNull(),
    reason: text('reason').notNull(),
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
  ],
)

// ---------------------------------------------------------------------------
// Outreach
// ---------------------------------------------------------------------------

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
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    error: text('error'),
    ...timestamps,
  },
  (t) => [
    index('touches_campaign_status_scheduled_idx').on(t.campaignId, t.status, t.scheduledFor),
    index('touches_contact_idx').on(t.contactId, t.createdAt.desc()),
    index('touches_company_idx').on(t.companyId, t.createdAt.desc()),
  ],
)

export const calls = pgTable(
  'calls',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    direction: text('direction').notNull(),
    providerCallSid: text('provider_call_sid'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationS: integer('duration_s'),
    recordingUrl: text('recording_url'),
    transcript: jsonb('transcript').notNull().default(sql`'[]'::jsonb`),
    summary: text('summary'),
    outcome: text('outcome'),
    sentiment: text('sentiment'),
    handoffToUserId: uuid('handoff_to_user_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('calls_contact_idx').on(t.contactId, t.startedAt.desc())],
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
