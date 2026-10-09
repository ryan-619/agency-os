/**
 * Research about a company, with its source (0028) — the pure checks.
 *
 * A research claim is something somebody read on a page and wrote down,
 * with the page. It is never evidence (§2.2): the scanner did not observe
 * it, and it is quoted in nothing outbound. What these functions check is
 * only that a claim is a claim and a source is a page a person can open:
 * https, a real host, no credentials in the address, bounded.
 */
export const RESEARCH_CLAIM_MAX = 500
export const RESEARCH_SOURCE_MAX = 2048
export const RESEARCH_TITLE_MAX = 300
/** Claims recorded in one call, at most. */
export const RESEARCH_PER_CALL = 10

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
const LOCAL_SUFFIX = /\.(?:local|localhost|internal|lan|home|corp|test|invalid|example)$/i

/** Why a source cannot be recorded, in a sentence — or null when it can. */
export function researchSourceProblem(url: string): string | null {
  const s = url.trim()
  if (!s) return 'A source is the address of the page the claim came from.'
  if ([...s].length > RESEARCH_SOURCE_MAX) return `A source address is at most ${RESEARCH_SOURCE_MAX} characters.`
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return 'That source is not an address a browser could open.'
  }
  if (u.protocol !== 'https:') return 'A source is an https address — a page anybody on the team can open.'
  if (u.username || u.password) return 'A source address must not carry a username or password.'
  const host = u.hostname.toLowerCase()
  if (host.startsWith('[') || IPV4.test(host) || !host.includes('.') || host === 'localhost' || LOCAL_SUFFIX.test(host)) {
    return 'A source is a page on the public web, named by a domain.'
  }
  return null
}

/** Why a claim cannot be recorded, in a sentence — or null when it can. */
export function researchClaimProblem(claim: string): string | null {
  const s = claim.trim()
  if (!s) return 'A claim says what was found, in a sentence.'
  if (s.includes('\u0000')) return 'A claim contains a character that cannot be stored.'
  if ([...s].length > RESEARCH_CLAIM_MAX) return `A claim is at most ${RESEARCH_CLAIM_MAX} characters; put the rest in a note.`
  if (/^https?:\/\/\S+$/i.test(s)) return 'A claim is what the page says, not the page’s address.'
  return null
}
