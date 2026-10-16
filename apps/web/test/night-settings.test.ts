/** Settings → Night shift's words (`app/settings/night/words.ts`). */
import { describe, expect, it } from 'vitest'
import { lastNightLine, nightWorkerLine } from '../src/app/settings/night/words'

describe('the night shift settings', () => {
  it('says whether the running worker can run it, from its heartbeat', () => {
    expect(nightWorkerLine('live', 'on')).toMatchObject({ tone: 'ok' })
    expect(nightWorkerLine('live', 'off').text).toContain('./tools/run-worker.sh --google')
    expect(nightWorkerLine('live', null).text).toContain('Restart it')
    expect(nightWorkerLine('silent', 'on')).toMatchObject({ tone: 'warn' })
    expect(nightWorkerLine('never', null)).toMatchObject({ tone: 'warn' })
  })

  it('says what the last night did', () => {
    expect(lastNightLine(null)).toBeNull()
    expect(lastNightLine({ date: '2026-10-09', searches: 2, added: 7, scanned: 3, audited: 1, top: 5 })).toBe(
      'Last run (2026-10-09): 2 searches, 7 new businesses, 3 scanned, 1 measured. The best 5 are on the dashboard.',
    )
  })
})
