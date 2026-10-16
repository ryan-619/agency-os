/**
 * An ISO 8601 instant WITH its offset, as the meeting tools take one — and a
 * date that exists.
 *
 * V8's `new Date()` reads "Thursday at 2" as a real, wrong instant, and rolls
 * 30 February forward to 2 March without complaint, so `book_meeting`
 * recorded a meeting on a day nobody typed. The meetings route refuses that
 * with `isRealWallClock`; this is the same check on the fields as typed. A
 * time with no offset is refused rather than read in the worker's zone.
 */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/

export function instantFrom(raw: string): Date | null {
  const text = raw.trim()
  const m = ISO_INSTANT.exec(text)
  if (!m) return null
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [
    number, number, number, number, number, number,
  ]
  // The fields as typed must name a moment that exists: Date.UTC rolls an
  // impossible one over, and a roll-over is a date nobody wrote.
  const typed = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  if (
    typed.getUTCFullYear() !== y || typed.getUTCMonth() !== mo - 1 || typed.getUTCDate() !== d ||
    typed.getUTCHours() !== h || typed.getUTCMinutes() !== mi || typed.getUTCSeconds() !== s
  ) {
    return null
  }
  const at = new Date(text)
  return Number.isNaN(at.getTime()) ? null : at
}
