/**
 * The harness that verifies everything, verified.
 *
 * `migratedDb()` shares the WORK of migrating — done once per process — and
 * must not share the STATE. If it ever did, a row written by one test would
 * be visible to the next, and the failure would not look like a harness bug:
 * it would look like the product doing something strange, intermittently,
 * depending on file order. That is the specific way a suite starts passing
 * vacuously, so it gets its own test rather than an argument in a comment.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { schema, type AgencyDb } from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

describe('the migrated-database harness', () => {
  let test: TestDb
  let db: AgencyDb

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /**
   * These two run in order and are deliberately coupled: the first writes a
   * row with a name the second looks for. If the snapshot were shared rather
   * than copied, the second would find it.
   */
  it('starts empty, and writes a row', async () => {
    expect(await db.select().from(schema.orgs)).toHaveLength(0)
    await db.insert(schema.orgs).values({ name: 'LEAKED FROM THE PREVIOUS TEST' })
    expect(await db.select().from(schema.orgs)).toHaveLength(1)
  })

  it('does not see what the previous test wrote', async () => {
    const orgs = await db.select().from(schema.orgs)
    expect(orgs).toHaveLength(0)
    expect(orgs.map((o) => o.name)).not.toContain('LEAKED FROM THE PREVIOUS TEST')
  })

  /** The migrations really are applied — the shortcut has to be a shortcut. */
  it('arrives with every migration already applied', async () => {
    const tables = await test.driver.select<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = current_schema()",
    )
    const names = tables.map((t) => t.table_name)
    for (const expected of ['orgs', 'users', 'companies', 'deals', 'touches', 'calls', 'suppressions']) {
      expect(names, expected).toContain(expected)
    }
    // 0023's tables and columns, the most recent things a migration added.
    // This assertion has to name the NEWEST: a snapshot built from an older
    // set of migrations would still carry every earlier one.
    expect(names).toContain('quotes')
    expect(names).toContain('share_links')
    expect(names).toContain('org_profiles')
    const companyCols = await test.driver.select<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'companies'",
    )
    expect(companyCols.map((c) => c.column_name)).toContain('latitude')
    // 0022's, as further lines.
    expect(names).toContain('services')
    expect(names).toContain('site_audits')
    expect(companyCols.map((c) => c.column_name)).toContain('google_place_id')
    expect(companyCols.map((c) => c.column_name)).toContain('listing_checked_at')
    // 0021's column and index, as further lines.
    expect(companyCols.map((c) => c.column_name)).toContain('headcount_source')
    const indexes = await test.driver.select<{ indexname: string }>(
      "select indexname from pg_indexes where tablename = 'icp_profiles'",
    )
    expect(indexes.map((i) => i.indexname)).toContain('icp_profiles_one_active_per_org')
    // 0020's table, as a further line.
    expect(names).toContain('assistant_settings')
    // 0019's table and columns, as further lines.
    expect(names).toContain('message_templates')
    const cols = await test.driver.select<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'touches'",
    )
    expect(cols.map((c) => c.column_name)).toContain('template_id')
    expect(cols.map((c) => c.column_name)).toContain('delivery_status')
    // And 0018's and 0017's, as further lines — one column is one migration.
    const findingCols = await test.driver.select<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'findings'",
    )
    expect(findingCols.map((c) => c.column_name)).toContain('scored')
    expect(cols.map((c) => c.column_name)).toContain('reply_kind')
  })

  /**
   * UTC, for the same reason freshDb pins it: PGlite otherwise derives an
   * Etc/GMT±N zone from the host clock and truncates to whole hours, so a
   * developer at +05:30 silently tests at +05:00. The snapshot must not have
   * lost that.
   */
  it('is still pinned to UTC', async () => {
    // `show timezone` names the column TimeZone; current_setting lets it be
    // aliased to something a typed select can read.
    const rows = await test.driver.select<{ tz: string }>("select current_setting('TimeZone') as tz")
    expect(rows[0]?.tz).toBe('UTC')
  })
})
