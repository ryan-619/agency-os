#!/usr/bin/env node
/**
 * Migration CLI.
 *
 *   npm run db:migrate            apply every pending migration
 *   npm run db:migrate -- status  show what is applied
 *   npm run db:migrate -- down    revert the most recent migration
 *   npm run db:migrate -- down 3  revert the last three
 *   npm run db:migrate -- reset   revert everything, then re-apply from zero
 *
 * Reads DATABASE_URL from the environment. The URL contains a password, so it
 * is never printed, not even on error (PROMPT.md §2.3).
 */
import { Client } from 'pg'
import { pgDriver } from './driver.js'
import { MIGRATIONS_DIR } from './paths.js'
import { readMigrations, migrateUp, migrateDown, migrationStatus } from './migrator.js'

/** Strip credentials so a connection target can be shown in a log line. */
function safeTarget(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`
  } catch {
    return '(unparseable DATABASE_URL)'
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.')
    process.exit(1)
  }

  const [command = 'up', arg] = process.argv.slice(2)
  const migrations = readMigrations(MIGRATIONS_DIR)

  // A Client, not a Pool — the migrator issues BEGIN/COMMIT as separate
  // statements and they must land on one connection.
  const client = new Client({ connectionString: url })
  await client.connect()
  const driver = pgDriver(client)
  const log = (m: string) => console.log(`  ${m}`)

  try {
    console.log(`database: ${safeTarget(url)}`)
    switch (command) {
      case 'up': {
        const res = await migrateUp(driver, migrations, log)
        console.log(
          res.applied.length
            ? `applied ${res.applied.length} migration(s): ${res.applied.join(', ')}`
            : 'already up to date',
        )
        break
      }
      case 'down': {
        const steps = arg === 'all' ? 'all' : Number.parseInt(arg ?? '1', 10)
        if (steps !== 'all' && (!Number.isInteger(steps) || steps < 1)) {
          console.error(`down expects a positive integer or "all", got "${arg}"`)
          process.exit(1)
        }
        const undone = await migrateDown(driver, migrations, steps, log)
        console.log(undone.length ? `reverted ${undone.join(', ')}` : 'nothing to revert')
        break
      }
      case 'status': {
        const rows = await migrationStatus(driver, migrations)
        for (const r of rows) {
          console.log(`  ${r.applied ? '[x]' : '[ ]'} ${r.version}_${r.name}`)
        }
        const pending = rows.filter((r) => !r.applied).length
        console.log(pending ? `${pending} pending` : 'up to date')
        break
      }
      case 'reset': {
        if (process.env.NODE_ENV === 'production') {
          console.error('refusing to reset in production')
          process.exit(1)
        }
        await migrateDown(driver, migrations, 'all', log)
        await migrateUp(driver, migrations, log)
        console.log('reset complete')
        break
      }
      default:
        console.error(`unknown command "${command}". Use: up | down [n|all] | status | reset`)
        process.exit(1)
    }
  } finally {
    await client.end()
  }
}

main().catch((err: unknown) => {
  // Print the message only. A driver error can carry the connection string.
  console.error(`migration failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
