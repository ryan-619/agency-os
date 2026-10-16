/**
 * Where the scanner may CONNECT, as distinct from what it may be ASKED for.
 *
 * `isScannableHost` judges the name a caller typed; it cannot see what the
 * name resolves to. A public name that points at a private address
 * (`127.0.0.1.nip.io`, or a company's own DNS turned hostile) passed it, and
 * the scanner would request whatever answered there — the machine it runs
 * on, its home or office network, cloud metadata. That stopped being
 * hypothetical when a public form began to hand the scanner domains typed by
 * strangers (the free website check, 2026-10-08), as CLAUDE.md §2 said it
 * would need to. So every connection the scanner makes resolves the name
 * through `publicOnlyLookup`, which refuses the connection when ANY address
 * the name resolves to is not public unicast: one private address among
 * public ones is the shape a rebinding attack takes, and no company's
 * marketing site needs it.
 *
 * `isPublicAddress` is pure; `publicOnlyLookup` is a drop-in `lookup` for
 * `http.request`, `https.request` and `tls.connect`.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns'
import { isIP, type LookupFunction } from 'node:net'

function v4Octets(address: string): [number, number, number, number] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  return n.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? (n as [number, number, number, number]) : null
}

function publicV4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127) return false // "this network", private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false // carrier-grade NAT
  if (a === 169 && b === 254) return false // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false // IETF protocol assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false // 6to4 relay anycast
  if (a === 192 && b === 168) return false // private
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
  if (a === 198 && b === 51 && c === 100) return false // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false // TEST-NET-3
  if (a >= 224) return false // multicast, reserved, broadcast
  return true
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function v6Groups(address: string): number[] | null {
  let s = address.toLowerCase()
  const zone = s.indexOf('%')
  if (zone !== -1) s = s.slice(0, zone)
  // An IPv4 tail ("::ffff:127.0.0.1") becomes its two groups.
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (tail) {
    const o = v4Octets(tail[1]!)
    if (!o) return null
    s = `${s.slice(0, -tail[1]!.length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const read = (h: string) => (h === '' ? [] : h.split(':'))
  const head = read(halves[0]!)
  const rest = halves.length === 2 ? read(halves[1]!) : []
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
  const groups = [...head, ...Array(fill).fill('0'), ...rest].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null
}

function publicV6(g: number[]): boolean {
  const v4 = (hi: number, lo: number): [number, number, number, number] => [hi >> 8, hi & 255, lo >> 8, lo & 255]
  if (g.slice(0, 6).every((x) => x === 0)) return false // ::, ::1, and the deprecated IPv4-compatible block
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return publicV4(v4(g[6]!, g[7]!)) // IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return publicV4(v4(g[6]!, g[7]!)) // NAT64
  if (g[0] === 0x2002) return publicV4(v4(g[1]!, g[2]!)) // 6to4 carries an IPv4 address
  if (g[0] === 0x2001 && g[1] === 0) return false // Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false // documentation
  if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) return false // discard-only
  if ((g[0]! & 0xfe00) === 0xfc00) return false // unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return false // link-local
  if ((g[0]! & 0xff00) === 0xff00) return false // multicast
  return true
}

/** Is this IP address a public unicast address the scanner may connect to? */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) {
    const o = v4Octets(address)
    return o !== null && publicV4(o)
  }
  if (kind === 6) {
    const g = v6Groups(address)
    return g !== null && publicV6(g)
  }
  return false
}

export class NonPublicAddressError extends Error {
  readonly code = 'ENOTPUBLIC'
  constructor(readonly hostname: string) {
    super(`${hostname} resolves to an address that is not public; the scanner connects only to public addresses`)
    this.name = 'NonPublicAddressError'
  }
}

/**
 * `dns.lookup`, refusing a name any of whose addresses is not public. Answers
 * in the shape the caller asked for — one address, or every address when
 * `all` is set, as Node's own connection code asks.
 */
export const publicOnlyLookup = ((hostname: string, options: LookupOptions, callback: (...args: unknown[]) => void) => {
  const opts = typeof options === 'object' && options !== null ? options : {}
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) {
      callback(err, opts.all ? [] : '', 0)
      return
    }
    const list = addresses as LookupAddress[]
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      callback(new NonPublicAddressError(hostname), opts.all ? [] : '', 0)
      return
    }
    if (opts.all) callback(null, list)
    else callback(null, list[0]!.address, list[0]!.family)
  })
}) as unknown as LookupFunction
