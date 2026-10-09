/**
 * What counts as somebody reading a business's link (2026-10-08): the robot
 * filter the view route applies behind the page's own script, against user
 * agents as they arrive.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LINK_KINDS, VIEW_AFTER_MS, isRobotAgent, linkKindOf } from '../src/lib/link-view'

const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

describe('a link view', () => {
  it('is a person’s browser, and never a robot or a preview fetcher', () => {
    const people = [
      'Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
      'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36 Instagram 350.0.0.0',
    ]
    for (const ua of people) expect(isRobotAgent(ua), ua).toBe(false)
    const robots = [
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'TelegramBot (like TwitterBot)',
      'Twitterbot/1.0',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/129.0.0.0 Safari/537.36',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) BingPreview/1.0b',
      'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
      'curl/8.7.1',
      'python-requests/2.32.3',
      'Go-http-client/1.1',
      '',
    ]
    for (const ua of robots) expect(isRobotAgent(ua), ua).toBe(true)
    expect(isRobotAgent(null)).toBe(true)
  })

  it('names one of the three kinds of link, or nothing', () => {
    expect(LINK_KINDS).toEqual(['quote', 'report', 'preview'])
    for (const k of LINK_KINDS) expect(linkKindOf(k)).toBe(k)
    for (const v of ['proposal', '', null, 3, 'Quote']) expect(linkKindOf(v)).toBeNull()
    expect(VIEW_AFTER_MS).toBeGreaterThanOrEqual(1_000)
  })

  it('is counted by the page’s script and never by the page’s GET, and never for a teammate', () => {
    // Every page a business opens hands the count to the beacon, and none counts on render.
    for (const page of ['app/q/[token]/page.tsx', 'app/r/[token]/page.tsx', 'app/w/[token]/page.tsx']) {
      const text = source(page)
      expect(text, page).not.toContain('shareLinkCountView')
      expect(text, page).toMatch(/team \? <TeamNote[^]*<ViewBeacon token=\{token\} kind="(quote|report|preview)" \/>/)
    }
    const route = source('app/api/l/[token]/view/route.ts')
    expect(route).toContain('isRobotAgent(request.headers.get(\'user-agent\'))')
    expect(route).toMatch(/if \(await viewerIsTeam\(link\.orgId\)\) return NONE\(204\)/)
    expect(route.indexOf('viewerIsTeam(link.orgId)')).toBeLessThan(route.indexOf('shareLinkCountView('))
    // A teammate cannot answer a quote in the buyer's name.
    expect(source('app/api/q/[token]/answer.ts')).toMatch(/if \(await viewerIsTeam\(link\.orgId\)\) return answer\(409/)
  })
})
