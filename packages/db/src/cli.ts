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
 * `down` and `reset` refuse to revert 0018 while any user has revoked access:
 * its down drops `users.revoked_at`, and older code would let each of them
 * sign in again. `--restores-revoked-access` reverts anyway, and says so.
 *
 * Reads DATABASE_URL from the environment. The URL contains a password, so it
 * is never printed, not even on error (PROMPT.md §2.3).
 */
import { Client } from 'pg'
import { pgConnectionString } from './connection-string.js'
import { pgDriver } from './driver.js'
import { MIGRATIONS_DIR } from './paths.js'
import {
  RESTORES_REVOKED_ACCESS_FLAG, readMigrations, migrateUp, migrateDown, migrationStatus,
} from './migrator.js'
import { safeTarget } from './safe-target.js'



async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.')
    process.exit(1)
  }

  const argv = process.argv.slice(2)
  const flags = argv.filter((a) => a.startsWith('--'))
  const unknown = flags.filter((f) => f !== RESTORES_REVOKED_ACCESS_FLAG)
  if (unknown.length > 0) {
    console.error(`unknown option ${unknown.join(', ')}. The one option is ${RESTORES_REVOKED_ACCESS_FLAG} (down and reset).`)
    process.exit(1)
  }
  const downOptions = { restoresRevokedAccess: flags.includes(RESTORES_REVOKED_ACCESS_FLAG) }
  const [command = 'up', arg] = argv.filter((a) => !a.startsWith('--'))
  const migrations = readMigrations(MIGRATIONS_DIR)

  // A Client, not a Pool — the migrator issues BEGIN/COMMIT as separate
  // statements and they must land on one connection.
  const client = new Client({ connectionString: pgConnectionString(url) })
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
        const undone = await migrateDown(driver, migrations, steps, log, downOptions)
        console.log(undone.length ? `reverted ${undone.join(', ')}` : 'nothing to revert')
        if (downOptions.restoresRevokedAccess && undone.includes('0018')) {
          console.log('users.revoked_at is gone: every revoked user can sign in again with the code this database now matches')
        }
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
        // All the way down drops the users table too, so the 0018 guard has
        // nothing to refuse here; the options are passed for the day it does.
        await migrateDown(driver, migrations, 'all', log, downOptions)
        await migrateUp(driver, migrations, log)
        console.log('reset complete')
        break
      }
      default:
        console.error(`unknown command "${command}". Use: up | down [n|all] | status | reset [${RESTORES_REVOKED_ACCESS_FLAG}]`)
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
