#!/usr/bin/env node
/**
 * Seed CLI — creates the single org, the owner user, the ICP profile and the
 * 16 seed companies. Safe to run repeatedly.
 *
 *   npm run db:seed
 */
import { Client } from 'pg'
import { pgDriver } from './driver.js'
import { seed } from './seed.js'

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.')
    process.exit(1)
  }
  const ownerEmail = process.env.SEED_OWNER_EMAIL
  if (!ownerEmail) {
    console.error('SEED_OWNER_EMAIL is not set — there would be nobody who can sign in.')
    process.exit(1)
  }

  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const result = await seed(
      pgDriver(client),
      {
        orgName: process.env.SEED_ORG_NAME ?? 'Agency',
        ownerEmail,
        ownerName: process.env.SEED_OWNER_NAME,
      },
      (m) => console.log(`  ${m}`),
    )
    console.log(
      `seed complete — org ${result.orgId}, owner ${result.ownerUserId}, ` +
        `${result.companiesInserted} new companies`,
    )
  } finally {
    await client.end()
  }
}

main().catch((err: unknown) => {
  console.error(`seed failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
