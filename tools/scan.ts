/**
 * Scan companies and record what was observed.
 *
 *   npm run scan                    every company that has never been scanned
 *   npm run scan -- --all           re-scan everything
 *   npm run scan -- rentman.io      one domain
 *   npm run scan -- --stale         only those whose findings have gone stale
 *   npm run scan -- --import FILE   import a domain,name CSV first, then scan
 *
 * Reads the active ICP from the database, so weights and thresholds are
 * whatever the profile row says (§8.3) — nothing here hard-codes them.
 */
import { readFileSync } from 'node:fs'
import { Client } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { parseIcpDefinition } from '@agency/core'
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

  const client = new Client({ connectionString: url })
  await client.connect()
  const db = drizzle(client, { schema }) as unknown as AgencyDb
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
    const staleDays = icp.freshness?.stale_after_days ?? 14
    const marked = await markStaleFindings(db, org.id, staleDays)
    if (marked) console.log(`stale   : marked ${marked} finding(s) older than ${staleDays} days`)

    const all = await companyList(db, org.id)
    let targets = all
    if (args.domains.length) targets = all.filter((c) => args.domains.includes(c.domain))
    else if (args.staleOnly) targets = all.filter((c) => c.lastScanAt === null)
    else if (!args.all) targets = all.filter((c) => c.lastScanAt === null)

    if (!targets.length) {
      console.log('\nnothing to scan (use --all to re-scan)')
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
          const { raw, profile, result } = await scanDomain(target.domain, icp, {
            company: target.name ?? undefined,
          })
          await recordScan(db, {
            orgId: org.id,
            companyId: target.companyId,
            icpProfileId: profileRow.id,
            raw,
            profile,
            result,
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
    await client.end()
  }
}

main().catch((err: unknown) => {
  console.error(`scan failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
