/**
 * Scan companies and record what was observed.
 *
 *   npm run scan                    every company that has never been scanned
 *   npm run scan -- --all           re-scan everything
 *   npm run scan -- rentman.io      one domain
 *   npm run scan -- --stale         never scanned, or the newest scan has aged out
 *   npm run scan -- --import FILE   import a domain,name CSV first, then scan
 *
 * Reads the active ICP from the database, so weights and thresholds are
 * whatever the profile row says (§8.3) — nothing here hard-codes them.
 */
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { isStale, parseIcpDefinition, staleAfterDaysOf } from '@agency/core'
import { scanDomain } from '@agency/scanner'
import {
  activeIcpProfile, companyList, importCompanies, markStaleFindings,
  parseCompanySeeds, recordScan, safeTarget, schema, type AgencyDb,
} from '@agency/db'

/** How many sites to have in flight at once. Polite, not fast. */
const CONCURRENCY = 4

interface Args {
  readonly all: boolean
  readonly staleOnly: boolean
  readonly importPath: string | null
  readonly domains: readonly string[]
}

function parseArgs(argv: readonly string[]): Args {
  const domains: string[] = []
  let all = false
  let staleOnly = false
  let importPath: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--all') all = true
    else if (a === '--stale') staleOnly = true
    else if (a === '--import') { importPath = argv[++i] ?? null }
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`)
    else domains.push(a.toLowerCase())
  }
  if (importPath === null && argv.includes('--import')) throw new Error('--import needs a file path')
  return { all, staleOnly, importPath, domains }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set.')
    process.exit(1)
  }

  // A POOL, not a Client. `recordScan` wraps its writes in a transaction, and
  // a transaction on a single connection is not isolated from anything else
  // using that connection: with CONCURRENCY workers sharing one, worker B's
  // INSERTs land between worker A's BEGIN and COMMIT, so a failure in A rolls
  // back B's scan as well — and a second BEGIN on an open transaction is a
  // warning Postgres logs and then ignores, silently merging the two. One
  // connection per worker is what makes each scan atomic on its own.
  const pool = new Pool({ connectionString: url, max: CONCURRENCY })
  const db = drizzle(pool, { schema }) as unknown as AgencyDb
  console.log(`database: ${safeTarget(url)}`)

  try {
    const [org] = await db.select({ id: schema.orgs.id }).from(schema.orgs).limit(1)
    if (!org) {
      console.error('No organisation. Run `npm run db:seed` first.')
      process.exit(1)
    }
    const profileRow = await activeIcpProfile(db, org.id)
    if (!profileRow) {
      console.error('No active ICP profile. Run `npm run db:seed` first.')
      process.exit(1)
    }
    const icp = parseIcpDefinition(profileRow.definition)
    console.log(`ICP     : ${icp.label} — qualify at ${icp.scoring.qualify_at}/100`)

    if (args.importPath) {
      const rows = parseCompanySeeds(readFileSync(args.importPath, 'utf8'))
      const r = await importCompanies(db, org.id, rows)
      console.log(`import  : ${r.inserted} new, ${r.alreadyPresent} already present`)
    }

    // Findings age out before anything is scanned, so --stale sees the truth.
    const staleDays = staleAfterDaysOf(icp)
    const marked = await markStaleFindings(db, org.id, staleDays)
    if (marked) console.log(`stale   : marked ${marked} finding(s) older than ${staleDays} days`)

    const all = await companyList(db, org.id)
    const neverScanned = (c: { lastScanAt: Date | null }): boolean => c.lastScanAt === null
    // §2.2: a finding older than the threshold must be RE-VERIFIED, and this is
    // the command that re-verifies it. Measured against the scan's own time,
    // the same way markStaleFindings and quotableFindings measure it — asking
    // `findings.stale` would ask a cache this run has just rewritten.
    const agedOut = (c: { lastScanAt: Date | null }): boolean =>
      c.lastScanAt !== null && isStale(c.lastScanAt, staleDays)

    let targets = all
    if (args.domains.length) targets = all.filter((c) => args.domains.includes(c.domain))
    else if (args.staleOnly) targets = all.filter((c) => neverScanned(c) || agedOut(c))
    else if (!args.all) targets = all.filter(neverScanned)

    if (!targets.length) {
      console.log(
        args.staleOnly
          ? `\nnothing older than ${staleDays} days (use --all to re-scan everything)`
          : '\nnothing to scan (use --all to re-scan)',
      )
      return
    }
    console.log(`\nscanning ${targets.length} of ${all.length} companies, ${CONCURRENCY} at a time\n`)

    const queue = [...targets]
    let done = 0
    const failures: string[] = []

    const worker = async (): Promise<void> => {
      for (;;) {
        const target = queue.shift()
        if (!target) return
        const started = Date.now()
        try {
          const { raw, profile } = await scanDomain(target.domain, icp, {
            company: target.name ?? undefined,
          })
          // The score is computed inside recordScan, from the same profile row
          // it stamps, so what is printed here is what was written.
          const { result } = await recordScan(db, {
            orgId: org.id,
            companyId: target.companyId,
            icpProfile: { id: profileRow.id, definition: icp },
            raw,
            profile,
          })
          done++
          const tag = result.disqualified
            ? `DQ: ${result.disqualified.slice(0, 30)}`
            : result.tier || 'below threshold'
          const unobserved = Object.values(profile.observations).filter((o) => !o.observed).length
          console.log(
            `  ${target.domain.padEnd(26)} ${String(result.score).padStart(3)}  ${tag.padEnd(18)}` +
              `${unobserved ? ` (${unobserved} not observed)` : ''}  ${Date.now() - started}ms`,
          )
        } catch (err) {
          failures.push(target.domain)
          console.log(`  ${target.domain.padEnd(26)} FAILED  ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    console.log(`\n${done} scanned${failures.length ? `, ${failures.length} failed: ${failures.join(', ')}` : ''}`)

    const after = await companyList(db, org.id)
    const scored = after.filter((c) => c.score !== null)
    console.log(
      `${scored.filter((c) => c.qualified).length} qualified of ${scored.length} scored  |  ` +
        `${scored.filter((c) => c.tier?.startsWith('A')).length} tier-A  |  ` +
        `${scored.filter((c) => c.disqualifiedReason).length} disqualified`,
    )
  } finally {
    await pool.end()
  }
}

main().catch((err: unknown) => {
  console.error(`scan failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
