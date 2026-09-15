/**
 * A wall-clock time in a named zone, as an instant.
 *
 * A `<input type="datetime-local">` yields "2026-09-22T14:00" with no zone.
 * `new Date("2026-09-22T14:00")` reads it in the BROWSER's zone, which is the
 * wrong answer the moment somebody books for a colleague in another office
 * or a visitor picks their own zone from the list. So the zone is applied
 * explicitly, with the runtime's own tables (`Intl`), by asking what
 * wall-clock time the guess produces in that zone and correcting by the
 * difference. Two passes settle it across a DST boundary.
 *
 * Pure, and usable on either side of the wire; `apps/web/test` covers it.
 */
export function wallClockToInstant(local: string, zone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local)
  if (!m) return null
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [number, number, number, number, number, number]
  const wanted = Date.UTC(y, mo - 1, d, h, mi, s)
  if (Number.isNaN(wanted)) return null

  let fmt: Intl.DateTimeFormat
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  } catch {
    return null
  }
  const asUtcOfZone = (instant: number): number => {
    const parts: Record<string, number> = {}
    for (const p of fmt.formatToParts(new Date(instant))) {
      if (p.type !== 'literal') parts[p.type] = Number(p.value)
    }
    // Some engines print hour 24 for midnight under h23 on old ICU builds.
    const hour = parts.hour === 24 ? 0 : parts.hour ?? 0
    return Date.UTC(parts.year ?? 1970, (parts.month ?? 1) - 1, parts.day ?? 1, hour, parts.minute ?? 0, parts.second ?? 0)
  }

  let guess = wanted
  for (let i = 0; i < 2; i += 1) {
    guess = guess - (asUtcOfZone(guess) - wanted)
  }
  // If the wall-clock time does not exist in that zone (the spring-forward
  // gap), the two passes disagree by the gap; the later instant is taken,
  // which is what every calendar does.
  return new Date(guess)
}

/** The zones the runtime knows, for a picker. Falls back to the one zone we can detect. */
export function knownTimeZones(): string[] {
  try {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone')
    if (all && all.length > 0) return all
  } catch {
    /* fall through */
  }
  try {
    return [Intl.DateTimeFormat().resolvedOptions().timeZone]
  } catch {
    return ['UTC']
  }
}

export function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
