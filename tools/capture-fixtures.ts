/**
 * Record the public surface of every seed domain, once, to a fixture.
 *
 * The fixtures are what make the parity test in packages/scanner deterministic
 * and offline: the TypeScript engine and the original Python engine are fed
 * the SAME recorded bytes, so any difference in their findings is a difference
 * in the engines, not in the internet.
 *
 *   npm run fixtures:capture              # every seed domain
 *   npm run fixtures:capture -- acme.com  # just one
 *
 * Re-running rewrites them. Bodies are gzipped, because a raw capture of
 * sixteen marketing sites is several megabytes of HTML.
 */
import { gzipSync } from 'node:zlib'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { capture } from '@agency/scanner'
import { parseCompanySeeds, SEED_DIR } from '@agency/db'

const OUT = new URL('../packages/scanner/fixtures/', import.meta.url).pathname

async function main(): Promise<void> {
  const only = process.argv.slice(2)
  const seeds = parseCompanySeeds(readFileSync(join(SEED_DIR, 'companies-security-gap-saas.csv'), 'utf8'))
  const targets = only.length ? seeds.filter((s) => only.includes(s.domain)) : seeds

  if (!targets.length) {
    console.error(`no matching seed domains for: ${only.join(', ')}`)
    process.exit(1)
  }

  mkdirSync(OUT, { recursive: true })
  console.log(`capturing ${targets.length} domain(s) into packages/scanner/fixtures/\n`)

  let ok = 0
  let failed = 0
  for (const { domain, name } of targets) {
    const started = Date.now()
    const raw = await capture(domain)
    const json = JSON.stringify({ company: name, ...raw })
    writeFileSync(join(OUT, `${domain}.json.gz`), gzipSync(json, { level: 9 }))

    const kb = Math.round(json.length / 1024)
    const gz = Math.round(gzipSync(json, { level: 9 }).length / 1024)
    if (raw.home.ok) {
      ok++
      const probed = Object.values(raw.paths).filter((p) => p.status !== null).length
      console.log(
        `  ok   ${domain.padEnd(26)} ${String(raw.home.status).padEnd(4)} ` +
          `${probed}/${Object.keys(raw.paths).length} paths  tls:${raw.tls.ok ? 'ok' : 'fail'}  ` +
          `${kb}KB (${gz}KB gz)  ${Date.now() - started}ms`,
      )
    } else {
      failed++
      console.log(`  FAIL ${domain.padEnd(26)} ${raw.home.error}`)
    }
  }
  console.log(`\n${ok} reachable, ${failed} not. Fixtures are a snapshot — never regenerate them`)
  console.log('to make a failing parity test pass; regenerate only when re-recording on purpose.')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
