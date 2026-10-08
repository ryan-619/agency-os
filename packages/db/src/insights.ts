/**
 * What's working (2026-10-08): of the people the agency wrote to in a window,
 * who replied, who was interested, who asked to stop and whose company the
 * agency won — by kind of business, by city and by campaign, with which
 * message in a campaign drew the reply; how the links businesses are sent
 * get opened; and what quotes become.
 *
 * Counts only, from what was recorded: a message SENT (never a draft), a
 * reply's stored kind (an auto-reply is not a reply), a deal marked won. A
 * person counts once per kind and city, from their first message in the
 * window; once per campaign in a campaign's line. Answers to replies are not
 * outreach and are left out. A rate over fewer than `INSIGHTS_MIN` people is
 * shown as too few to tell — the reader decides by it, so it must not be
 * noise.
 */
import { sql } from 'drizzle-orm'
import type { AgencyDb } from './repository.js'

export const INSIGHTS_WINDOW_DAYS = 90
export const INSIGHTS_MIN = 5
const ROWS = 12

export interface ReachRow {
  readonly key: string
  readonly written: number
  readonly replied: number
  readonly interested: number
  readonly optedOut: number
  readonly won: number
}

export interface CampaignReach extends ReachRow {
  readonly name: string
  /** How many replied after their 1st, 2nd, 3rd… message in the campaign. */
  readonly afterMessage: readonly { readonly n: number; readonly replied: number }[]
}

export interface Insights {
  readonly since: Date
  readonly byKind: readonly ReachRow[]
  readonly byCity: readonly ReachRow[]
  readonly byCampaign: readonly CampaignReach[]
  readonly pages: readonly { readonly kind: string; readonly made: number; readonly opened: number }[]
  readonly quotes: { readonly sent: number; readonly accepted: number; readonly declined: number; readonly acceptedValue: number }
}

const rowsOf = (res: unknown): Record<string, unknown>[] =>
  (Array.isArray(res) ? res : ((res as { rows?: unknown[] } | null)?.rows ?? [])) as Record<string, unknown>[]
const n = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0)

export async function whatsWorking(db: AgencyDb, args: { readonly orgId: string; readonly now: Date; readonly days?: number }): Promise<Insights> {
  const since = new Date(args.now.getTime() - (args.days ?? INSIGHTS_WINDOW_DAYS) * 86_400_000)
  const org = sql`${args.orgId}::uuid`
  const from = sql`${since.toISOString()}::timestamptz`

  // One row per person: their first outreach in the window, and what came of it.
  const people = sql`
    WITH firsts AS (
      SELECT t.contact_id, min(t.sent_at) AS first_sent
        FROM touches t
       WHERE t.org_id = ${org} AND t.direction = 'out' AND t.status IN ('sent', 'delivered')
         AND t.sent_at >= ${from} AND t.contact_id IS NOT NULL AND t.answers_touch_id IS NULL
       GROUP BY t.contact_id
    )
    SELECT f.contact_id, ct.company_id, co.google_category, co.city,
           EXISTS (SELECT 1 FROM touches i WHERE i.contact_id = f.contact_id AND i.direction = 'in'
                     AND i.created_at >= f.first_sent AND i.reply_kind IS DISTINCT FROM 'auto_reply') AS replied,
           EXISTS (SELECT 1 FROM touches i WHERE i.contact_id = f.contact_id AND i.direction = 'in'
                     AND i.created_at >= f.first_sent AND i.reply_kind = 'interested') AS interested,
           EXISTS (SELECT 1 FROM touches i WHERE i.contact_id = f.contact_id AND i.direction = 'in'
                     AND i.created_at >= f.first_sent AND i.reply_kind = 'opted_out') AS opted_out,
           EXISTS (SELECT 1 FROM deals d WHERE d.org_id = ${org} AND d.company_id = ct.company_id AND d.stage = 'won') AS won
      FROM firsts f
      JOIN contacts ct ON ct.id = f.contact_id
      LEFT JOIN companies co ON co.id = ct.company_id`

  const grouped = async (key: ReturnType<typeof sql>) =>
    rowsOf(await db.execute(sql`
      WITH p AS (${people})
      SELECT ${key} AS key,
             count(*)::int AS written,
             count(*) FILTER (WHERE replied)::int AS replied,
             count(*) FILTER (WHERE interested)::int AS interested,
             count(*) FILTER (WHERE opted_out)::int AS opted_out,
             count(DISTINCT company_id) FILTER (WHERE won)::int AS won
        FROM p
       GROUP BY 1
       ORDER BY written DESC, key
       LIMIT ${ROWS}`)).map((r) => ({
      key: String(r.key ?? ''),
      written: n(r.written), replied: n(r.replied), interested: n(r.interested), optedOut: n(r.opted_out), won: n(r.won),
    }))

  const [byKind, byCity, campaigns, steps, pages, quotes] = await Promise.all([
    grouped(sql`coalesce(google_category, '')`),
    grouped(sql`coalesce(initcap(btrim(city)), '')`),
    db.execute(sql`
      WITH firsts AS (
        SELECT t.campaign_id, t.contact_id, min(t.sent_at) AS first_sent
          FROM touches t
         WHERE t.org_id = ${org} AND t.direction = 'out' AND t.status IN ('sent', 'delivered') AND t.sent_at >= ${from}
           AND t.contact_id IS NOT NULL AND t.campaign_id IS NOT NULL AND t.answers_touch_id IS NULL
         GROUP BY t.campaign_id, t.contact_id
      ), p AS (
        SELECT f.campaign_id, f.contact_id, ct.company_id,
               EXISTS (SELECT 1 FROM touches i WHERE i.contact_id = f.contact_id AND i.direction = 'in'
                         AND i.created_at >= f.first_sent AND i.reply_kind IS DISTINCT FROM 'auto_reply') AS replied,
               EXISTS (SELECT 1 FROM touches i WHERE i.contact_id = f.contact_id AND i.direction = 'in'
                         AND i.created_at >= f.first_sent AND i.reply_kind = 'interested') AS interested,
               EXISTS (SELECT 1 FROM touches i WHERE i.contact_id = f.contact_id AND i.direction = 'in'
                         AND i.created_at >= f.first_sent AND i.reply_kind = 'opted_out') AS opted_out,
               EXISTS (SELECT 1 FROM deals d WHERE d.org_id = ${org} AND d.company_id = ct.company_id AND d.stage = 'won') AS won
          FROM firsts f JOIN contacts ct ON ct.id = f.contact_id
      )
      SELECT p.campaign_id AS key, c.name,
             count(*)::int AS written,
             count(*) FILTER (WHERE replied)::int AS replied,
             count(*) FILTER (WHERE interested)::int AS interested,
             count(*) FILTER (WHERE opted_out)::int AS opted_out,
             count(DISTINCT company_id) FILTER (WHERE won)::int AS won
        FROM p JOIN campaigns c ON c.id = p.campaign_id
       GROUP BY p.campaign_id, c.name
       ORDER BY written DESC
       LIMIT ${ROWS}`),
    // For each person who replied in a campaign: how many of its messages had gone to them before the reply.
    db.execute(sql`
      WITH firsts AS (
        SELECT t.campaign_id, t.contact_id, min(t.sent_at) AS first_sent
          FROM touches t
         WHERE t.org_id = ${org} AND t.direction = 'out' AND t.status IN ('sent', 'delivered') AND t.sent_at >= ${from}
           AND t.contact_id IS NOT NULL AND t.campaign_id IS NOT NULL AND t.answers_touch_id IS NULL
         GROUP BY t.campaign_id, t.contact_id
      ), first_reply AS (
        SELECT f.campaign_id, f.contact_id,
               (SELECT min(i.created_at) FROM touches i WHERE i.contact_id = f.contact_id AND i.direction = 'in'
                  AND i.created_at >= f.first_sent AND i.reply_kind IS DISTINCT FROM 'auto_reply') AS replied_at
          FROM firsts f
      )
      SELECT r.campaign_id AS key,
             (SELECT count(*) FROM touches o WHERE o.campaign_id = r.campaign_id AND o.contact_id = r.contact_id
                AND o.direction = 'out' AND o.status IN ('sent', 'delivered') AND o.answers_touch_id IS NULL
                AND o.sent_at <= r.replied_at)::int AS before
        FROM first_reply r
       WHERE r.replied_at IS NOT NULL`),
    db.execute(sql`
      SELECT kind, count(*)::int AS made, count(*) FILTER (WHERE view_count > 0)::int AS opened
        FROM share_links WHERE org_id = ${org} AND created_at >= ${from}
       GROUP BY kind ORDER BY kind`),
    db.execute(sql`
      SELECT count(*)::int AS sent,
             count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
             count(*) FILTER (WHERE status = 'declined')::int AS declined,
             coalesce(sum(total) FILTER (WHERE status = 'accepted'), 0)::bigint AS accepted_value
        FROM quotes WHERE org_id = ${org} AND sent_at >= ${from}`),
  ])

  const afterBy = new Map<string, Map<number, number>>()
  for (const r of rowsOf(steps)) {
    const key = String(r.key)
    const before = Math.max(1, n(r.before))
    const m = afterBy.get(key) ?? new Map<number, number>()
    m.set(before, (m.get(before) ?? 0) + 1)
    afterBy.set(key, m)
  }
  const q = rowsOf(quotes)[0] ?? {}
  return {
    since,
    byKind,
    byCity,
    byCampaign: rowsOf(campaigns).map((r) => ({
      key: String(r.key),
      name: String(r.name ?? ''),
      written: n(r.written), replied: n(r.replied), interested: n(r.interested), optedOut: n(r.opted_out), won: n(r.won),
      afterMessage: [...(afterBy.get(String(r.key)) ?? new Map<number, number>()).entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([k, v]) => ({ n: k, replied: v })),
    })),
    pages: rowsOf(pages).map((r) => ({ kind: String(r.kind), made: n(r.made), opened: n(r.opened) })),
    quotes: { sent: n(q.sent), accepted: n(q.accepted), declined: n(q.declined), acceptedValue: n(q.accepted_value) },
  }
}

/** "18% (9 of 50)", or "too few to tell (3)" under `INSIGHTS_MIN`. */
export function rateWords(part: number, of: number): string {
  if (of < INSIGHTS_MIN) return `too few to tell (${part} of ${of})`
  return `${Math.round((100 * part) / of)}% (${part} of ${of})`
}

/**
 * Lookalikes (2026-10-08): Google Maps searches for more businesses like the
 * ones the agency has WON — the same kind, in the same city — most wins
 * first, leaving out a search the night shift already has saved. Only a win
 * whose company was found on the map carries both, so only those count.
 */
export async function lookalikeSearches(db: AgencyDb, orgId: string, limit = 5): Promise<{ readonly query: string; readonly city: string; readonly won: number }[]> {
  const rows = rowsOf(await db.execute(sql`
    SELECT co.google_category AS kind, initcap(btrim(co.city)) AS city, count(DISTINCT co.id)::int AS won
      FROM deals d JOIN companies co ON co.id = d.company_id
     WHERE d.org_id = ${orgId}::uuid AND d.stage = 'won' AND co.google_category IS NOT NULL AND co.city IS NOT NULL
       AND btrim(co.city) <> ''
     GROUP BY 1, 2
     ORDER BY won DESC, kind, city
     LIMIT 20`))
  const saved = new Set(
    rowsOf(await db.execute(sql`SELECT lower(btrim(query)) AS q FROM night_searches WHERE org_id = ${orgId}::uuid`)).map((r) => String(r.q)),
  )
  return rows
    .map((r) => ({ query: `${String(r.kind).replace(/_/g, ' ')} in ${String(r.city)}`, city: String(r.city), won: n(r.won) }))
    .filter((r) => !saved.has(r.query.toLowerCase()))
    .slice(0, limit)
}

