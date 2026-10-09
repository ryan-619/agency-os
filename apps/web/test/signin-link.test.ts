/**
 * The sign-in link a person pastes into the app on their phone (2026-10-09):
 * only this app's own magic-link callback is ever opened.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SIGN_IN_CALLBACK_PATH, signInLinkFrom } from '../src/lib/signin-link'

const ORIGIN = 'https://myagencyos.in'
const LINK = `${ORIGIN}${SIGN_IN_CALLBACK_PATH}?callbackUrl=https%3A%2F%2Fmyagencyos.in%2F&token=abc123&email=ryan%40myagencyos.in`
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

describe('signInLinkFrom', () => {
  it('opens this app’s own sign-in link, pasted alone or in a line of the email', () => {
    expect(signInLinkFrom(LINK, ORIGIN)).toBe(LINK)
    expect(signInLinkFrom(`  ${LINK}\n`, ORIGIN)).toBe(LINK)
    expect(signInLinkFrom(`Sign in to Agency OS: ${LINK}`, ORIGIN)).toBe(LINK)
    expect(signInLinkFrom(`<${LINK}>.`, ORIGIN)).toBe(LINK)
    expect(signInLinkFrom(`(${LINK})`, ORIGIN)).toBe(LINK)
  })

  it('refuses another site, another path here, and a link with no token or address', () => {
    expect(signInLinkFrom(LINK.replace(ORIGIN, 'https://evil.example'), ORIGIN)).toBeNull()
    expect(signInLinkFrom(LINK.replace(ORIGIN, 'http://myagencyos.in'), ORIGIN)).toBeNull()
    expect(signInLinkFrom(LINK.replace(ORIGIN, 'https://www.myagencyos.in'), ORIGIN)).toBeNull()
    expect(signInLinkFrom(`${ORIGIN}/api/auth/signout?token=abc&email=x%40y.z`, ORIGIN)).toBeNull()
    expect(signInLinkFrom(`${ORIGIN}${SIGN_IN_CALLBACK_PATH}/../../companies?token=a&email=b`, ORIGIN)).toBeNull()
    expect(signInLinkFrom(LINK.replace('token=abc123&', ''), ORIGIN)).toBeNull()
    expect(signInLinkFrom(LINK.replace('&email=ryan%40myagencyos.in', ''), ORIGIN)).toBeNull()
    expect(signInLinkFrom(LINK.replace('https://', 'https://user:pw@'), ORIGIN)).toBeNull()
  })

  it('refuses what is not a link at all', () => {
    for (const pasted of ['', '   ', 'abc123', 'javascript:alert(1)', 'myagencyos.in/api/auth/callback/nodemailer?token=a&email=b']) {
      expect(signInLinkFrom(pasted, ORIGIN), pasted).toBeNull()
    }
    expect(signInLinkFrom(LINK, 'not an origin')).toBeNull()
  })

  it('is on the sign-in page and the page after it, and logs nothing', () => {
    expect(read('app/signin/page.tsx')).toContain('<PasteSignInLink />')
    expect(read('app/signin/check-email/page.tsx')).toContain('<PasteSignInLink />')
    const box = read('components/paste-signin-link.tsx')
    expect(box).toMatch(/window\.location\.assign\(link\)/)
    expect(box).not.toMatch(/console\.|fetch\(/)
  })
})
