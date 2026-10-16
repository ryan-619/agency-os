/**
 * Settings → Night shift's words (0025), pure: no `server-only`, no `@/`
 * import, so `apps/web/test/night-settings.test.ts` reads them.
 */
export const NIGHT_LEDE =
  'While you sleep, the night shift runs your saved Google Maps searches, files the businesses that are new, scans ' +
  'the public pages of those with a website of their own and asks Google how each does on a phone — then leaves a ' +
  'ranked list of the best finds on the dashboard for the morning. It sends nothing and contacts nobody. Each search ' +
  'is a Google Places search, which counts against the same daily limit as searches from Chat.'

export interface Line {
  readonly tone: 'ok' | 'warn'
  readonly text: string
}

/** What the newest heartbeat says of the worker that would run it. */
export function nightWorkerLine(status: 'never' | 'live' | 'silent', night: 'on' | 'off' | null): Line {
  if (status === 'never') {
    return { tone: 'warn', text: 'No worker has run against this database, so nothing runs the night shift: the worker runs it.' }
  }
  if (status === 'silent') {
    return {
      tone: 'warn',
      text: 'The worker is not running now, so the night shift does not run. Once it starts again, it runs at its first look after the time.',
    }
  }
  if (night === 'on') return { tone: 'ok', text: 'The worker is running and holds the Google key, so it runs the night shift.' }
  if (night === 'off') {
    return {
      tone: 'warn',
      text: 'The worker is running without the Google key, so it runs no night shift. Add the key with ./tools/run-worker.sh --google.',
    }
  }
  return { tone: 'warn', text: 'The worker running now was started before the night shift existed. Restart it to run the night shift.' }
}

/** The last night, in a sentence; null before the first. */
export function lastNightLine(report: { readonly date: string | null; readonly searches: number; readonly added: number; readonly scanned: number; readonly audited: number; readonly top: number } | null): string | null {
  if (!report) return null
  const what = `${report.searches} ${report.searches === 1 ? 'search' : 'searches'}, ${report.added} new ${report.added === 1 ? 'business' : 'businesses'}, ${report.scanned} scanned, ${report.audited} measured`
  return `Last run${report.date ? ` (${report.date})` : ''}: ${what}. ${report.top > 0 ? `The best ${report.top} are on the dashboard.` : 'None needed anything we could see yet.'}`
}
