/**
 * A meeting's time, in the MEETING's zone.
 *
 * `<When>` renders in the viewer's zone, which is right for "when did this
 * happen" and wrong for "when is the call": a 15:00 London meeting shown as
 * 19:30 with "(Europe/London)" beside it is a wrong statement, and it was on
 * the first live brief. So a meeting is formatted with `Intl` in its own
 * zone, with a fixed locale so the server and the browser agree byte for
 * byte. Server components only — nothing here depends on the viewer.
 */
export function inZone(at: Date | string, zone: string): string {
  const d = typeof at === 'string' ? new Date(at) : at
  try {
    const text = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(d)
    return `${text} (${zone})`
  } catch {
    return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
  }
}
