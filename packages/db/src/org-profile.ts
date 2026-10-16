/**
 * The agency's own profile (0023): what a quote prints about the seller.
 *
 * Legal name, address, phone, email and website; the GSTIN and the GST it
 * charges — above zero only with a GSTIN, by CHECK and here first with a
 * sentence; the UPI ID an advance is paid to; how long a quote is valid, the
 * advance it asks and its standard terms; and a brochure link an email may
 * carry. One row per org, written by an owner (Settings → Business profile)
 * and read by every quote: live while a quote is a draft, and snapshotted
 * onto it when it is sent, so a sent quote never changes under its buyer.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { gstinValid, normalisePhone, vpaValid } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

export type OrgProfileRow = typeof schema.orgProfiles.$inferSelect

/** What every reader sees for an org that has never saved a profile. */
export interface OrgProfile {
  readonly legalName: string | null
  readonly address: string | null
  readonly phone: string | null
  readonly email: string | null
  readonly website: string | null
  readonly gstin: string | null
  readonly gstRate: number
  readonly upiVpa: string | null
  readonly upiPayee: string | null
  readonly advancePercent: number
  readonly quoteValidityDays: number
  readonly quoteTerms: string | null
  readonly brochureUrl: string | null
  readonly updatedAt: Date | null
}

export const ORG_PROFILE_DEFAULTS: OrgProfile = {
  legalName: null,
  address: null,
  phone: null,
  email: null,
  website: null,
  gstin: null,
  gstRate: 0,
  upiVpa: null,
  upiPayee: null,
  advancePercent: 50,
  quoteValidityDays: 15,
  quoteTerms: null,
  brochureUrl: null,
  updatedAt: null,
}

function fromRow(row: OrgProfileRow): OrgProfile {
  return {
    legalName: row.legalName,
    address: row.address,
    phone: row.phone,
    email: row.email,
    website: row.website,
    gstin: row.gstin,
    gstRate: Number(row.gstRate),
    upiVpa: row.upiVpa,
    upiPayee: row.upiPayee,
    advancePercent: row.advancePercent,
    quoteValidityDays: row.quoteValidityDays,
    quoteTerms: row.quoteTerms,
    brochureUrl: row.brochureUrl,
    updatedAt: row.updatedAt ?? row.createdAt,
  }
}

/** The profile, or the defaults when none was saved. Never null. */
export async function orgProfileRead(db: AgencyDb, orgId: string): Promise<OrgProfile> {
  const [row] = await db.select().from(schema.orgProfiles).where(eq(schema.orgProfiles.orgId, orgId)).limit(1)
  return row ? fromRow(row) : ORG_PROFILE_DEFAULTS
}

const blankToNull = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v)
const optionalText = (max: number) =>
  z.preprocess(blankToNull, z.string().trim().max(max, `At most ${max} characters.`).nullable().optional())

/** The form and the tools send this; every field optional, blank meaning "clear it". */
export const orgProfileInput = z
  .object({
    legalName: optionalText(200),
    address: optionalText(500),
    phone: optionalText(40),
    email: z.preprocess(blankToNull, z.string().trim().max(200).email('That is not an email address.').nullable().optional()),
    website: z.preprocess(
      blankToNull,
      z.string().trim().max(300).regex(/^https?:\/\//, 'A website starts with https://').nullable().optional(),
    ),
    gstin: z.preprocess(
      (v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim().toUpperCase()) : v),
      z.string().refine(gstinValid, 'That is not a GSTIN: 15 characters, e.g. 29ABCDE1234F1Z5.').nullable().optional(),
    ),
    gstRate: z.coerce.number().min(0, 'GST is 0 or more.').max(28, 'GST is at most 28%.').optional(),
    upiVpa: z.preprocess(
      blankToNull,
      z.string().trim().refine(vpaValid, 'That is not a UPI ID: it looks like name@bank.').nullable().optional(),
    ),
    upiPayee: optionalText(100),
    advancePercent: z.coerce.number().int('A whole percentage.').min(0).max(100).optional(),
    quoteValidityDays: z.coerce.number().int('A whole number of days.').min(1).max(365).optional(),
    quoteTerms: optionalText(4000),
    brochureUrl: z.preprocess(
      blankToNull,
      z.string().trim().max(500).regex(/^https:\/\//, 'A brochure link starts with https://').nullable().optional(),
    ),
  })
  .strict()

export type OrgProfileInput = z.infer<typeof orgProfileInput>

export type OrgProfileSave =
  | { readonly ok: true; readonly profile: OrgProfile }
  | { readonly ok: false; readonly reason: 'invalid'; readonly message: string }

/**
 * Save the fields given over the profile, creating it on the first save, and
 * audit which fields changed — the names, not the values.
 */
export async function orgProfileSave(
  db: AgencyDb,
  args: { readonly orgId: string; readonly input: unknown; readonly actor: string; readonly updatedBy: string | null },
): Promise<OrgProfileSave> {
  const parsed = orgProfileInput.safeParse(args.input)
  if (!parsed.success) return { ok: false, reason: 'invalid', message: parsed.error.issues[0]?.message ?? 'That did not read.' }
  const input = parsed.data

  let phone: string | null | undefined = input.phone
  if (typeof phone === 'string') {
    const e164 = normalisePhone(phone)
    if (!e164) return { ok: false, reason: 'invalid', message: 'Give the phone number with its country code, e.g. +91 98765 43210.' }
    phone = e164
  }

  const current = await orgProfileRead(db, args.orgId)
  const next: OrgProfile = {
    ...current,
    ...Object.fromEntries(Object.entries({ ...input, phone }).filter(([, v]) => v !== undefined)),
  } as OrgProfile
  if (next.gstRate > 0 && !next.gstin) {
    return { ok: false, reason: 'invalid', message: 'GST can be charged only with a GSTIN. Add the GSTIN, or set GST to 0.' }
  }

  const changed = (Object.keys(ORG_PROFILE_DEFAULTS) as (keyof OrgProfile)[]).filter(
    (k) => k !== 'updatedAt' && next[k] !== current[k],
  )
  const values = {
    legalName: next.legalName,
    address: next.address,
    phone: next.phone,
    email: next.email,
    website: next.website,
    gstin: next.gstin,
    gstRate: String(next.gstRate),
    upiVpa: next.upiVpa,
    upiPayee: next.upiPayee,
    advancePercent: next.advancePercent,
    quoteValidityDays: next.quoteValidityDays,
    quoteTerms: next.quoteTerms,
    brochureUrl: next.brochureUrl,
    updatedBy: args.updatedBy,
  }
  const saved = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.orgProfiles)
      .values({ orgId: args.orgId, ...values })
      .onConflictDoUpdate({ target: schema.orgProfiles.orgId, set: values })
      .returning()
    if (changed.length > 0) {
      await tx.insert(schema.auditLog).values({
        orgId: args.orgId,
        actor: args.actor,
        action: 'org.profile_updated',
        subjectType: 'org',
        subjectId: args.orgId,
        detail: { fields: changed },
      })
    }
    return row!
  })
  return { ok: true, profile: fromRow(saved) }
}

/** What a quote snapshots of the seller when it is sent: the org's name and its profile. */
export interface QuoteSeller {
  readonly name: string
  readonly legalName: string | null
  readonly address: string | null
  readonly phone: string | null
  readonly email: string | null
  readonly website: string | null
  readonly gstin: string | null
  readonly upiVpa: string | null
  readonly upiPayee: string | null
  readonly brochureUrl: string | null
}

export function quoteSellerFrom(orgName: string, p: OrgProfile): QuoteSeller {
  return {
    name: orgName,
    legalName: p.legalName,
    address: p.address,
    phone: p.phone,
    email: p.email,
    website: p.website,
    gstin: p.gstin,
    upiVpa: p.upiVpa,
    upiPayee: p.upiPayee,
    brochureUrl: p.brochureUrl,
  }
}
