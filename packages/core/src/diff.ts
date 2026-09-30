/**
 * The signal-by-signal diff between two scans' findings, as pure data.
 *
 * PROMPT.md §2.2: "The app must never state a finding it did not observe."
 * A diff is where that rule is easiest to break by accident, because the
 * natural reading of "it was a gap last time and is not a gap this time" is
 * "they fixed it" — and "not a gap this time" includes "we could not see it
 * this time". A timeout, a WAF block or a CDN quirk on the newer scan is not
 * evidence that anything was fixed; it is evidence of nothing.
 *
 * So the state machine reads each side as one of four things — a gap, clear,
 * NOT APPLICABLE, or UNOBSERVED — and checks the newer side first:
 *
 *   older       newer        change
 *   (absent)    anything     new_signal
 *   anything    unobserved   not_assessed_this_time   (never `fixed`)
 *   unobserved  observed     now_observed             (never `fixed` or `regressed`)
 *   same        same         unchanged                (both OBSERVED)
 *   gap/clear   n/a          no_longer_applicable     (never `fixed`)
 *   n/a         gap/clear    now_applicable           (never `regressed`)
 *   gap         clear        fixed
 *   clear       gap          regressed
 *
 * `unchanged` is a comparison, and a comparison needs an observation on both
 * sides: a signal neither scan could see is `not_assessed_this_time`, not
 * `unchanged` — "we looked twice and saw nothing" is not "nothing changed".
 *
 * "Not applicable" is the scanner's convention for a question the page gave
 * no occasion to ask — no CSP to judge the script sources of, no HSTS header
 * to read a max-age from (`isNotApplicable`). It is stored `observed, gap =
 * false`, which a two-way reading takes for "clear", and that turned a CSP
 * with 'unsafe-inline' that was later REMOVED into "fixed". Nothing was fixed:
 * the thing being judged went away. So it is its own reading, and a move into
 * or out of it is its own change, counted apart from `fixed` and `regressed`.
 *
 * Every row carries BOTH inputs, evidence objects included, so a reader can
 * check the claim against what each scan actually recorded rather than take
 * the label on trust.
 *
 * Pure, like everything in packages/core. The rows come from
 * `latestTwoOkScans` in packages/db, which only ever pairs two SUCCESSFUL
 * scans; a scan that never reached the site has no findings to diff.
 */
import { isNotApplicable } from './informational.js'

/** One finding, as the diff reads it. A `findings` row fits through `diffInputOf`. */
export interface DiffInput {
  readonly signalKey: string
  readonly observed: boolean
  /** NULL whenever `observed` is false — the database enforces it. */
  readonly gap: boolean | null
  readonly detail: string | null
  readonly evidence: Readonly<Record<string, unknown>>
  /** The weight stamped on the row when it was written, not the current ICP's. */
  readonly weight: number
  /** False for an informational signal. Absent means scored (the column's default). */
  readonly scored?: boolean
}

/** Every change the diff can report — the list a renderer must have words for. */
export const SIGNAL_CHANGES = Object.freeze([
  'fixed',
  'regressed',
  'not_assessed_this_time',
  'now_observed',
  'no_longer_applicable',
  'now_applicable',
  'new_signal',
  'unchanged',
] as const)

export type SignalChange = (typeof SIGNAL_CHANGES)[number]

export interface FindingDiffRow {
  readonly signalKey: string
  readonly change: SignalChange
  /** NULL only for `new_signal`. */
  readonly older: DiffInput | null
  readonly newer: DiffInput
  /** From the newer row: whether the signal counts towards the score NOW. */
  readonly scored: boolean
  /**
   * The larger of the two stamped weights — what the signal counted for on
   * whichever scan it counted. A `fixed` row's newer weight is 0 (a finding
   * carries weight only while it is a gap), so ordering by the newer side
   * alone would sink every fix to the bottom beneath the unchanged rows. The
   * per-scan weights stay on `older` and `newer` for anyone showing them.
   */
  readonly weight: number
}

export interface FindingDiff {
  /** Weight descending, then signal key — deterministic for equal weights. */
  readonly rows: FindingDiffRow[]
  readonly summary: {
    readonly fixed: number
    readonly regressed: number
    readonly notAssessed: number
    readonly nowObserved: number
    /** Judged on the older scan, nothing to judge on the newer. Never in `fixed`. */
    readonly noLongerApplicable: number
    /** Nothing to judge on the older scan, judged on the newer. Never in `regressed`. */
    readonly nowApplicable: number
  }
}

type Reading = 'gap' | 'clear' | 'not_applicable' | 'unobserved'

/**
 * What one side of the diff says. A row claiming `observed` with no `gap`
 * value contradicts `findings_unobserved_has_no_gap` and cannot come out of
 * the database; if one is ever handed in, it supports no claim either way and
 * is read as unobserved — the direction that can never produce a `fixed`.
 */
function reading(d: DiffInput): Reading {
  if (!d.observed || d.gap === null) return 'unobserved'
  if (d.gap) return 'gap'
  return isNotApplicable(d) ? 'not_applicable' : 'clear'
}

function changeOf(older: DiffInput | undefined, newer: DiffInput): SignalChange {
  if (!older) return 'new_signal'
  const was = reading(older)
  const now = reading(newer)
  // First, and on its own: whatever the older scan said, a newer scan that
  // could not observe the signal cannot say it changed.
  if (now === 'unobserved') return 'not_assessed_this_time'
  if (was === 'unobserved') return 'now_observed'
  if (was === now) return 'unchanged'
  // Before gap/clear, so a policy that went away is never `fixed` and one
  // that appeared is never `regressed`: one side had nothing to judge.
  if (now === 'not_applicable') return 'no_longer_applicable'
  if (was === 'not_applicable') return 'now_applicable'
  return was === 'gap' ? 'fixed' : 'regressed'
}

/** Code-unit order, so the result does not depend on the runtime's locale. */
function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Diff the findings of an OLDER scan against a NEWER one, signal by signal.
 *
 * A key present only in `older` is dropped, not reported. The newer scan did
 * not produce that signal at all — the ICP or the scanner changed between the
 * two — so there is no newer observation to compare against, and anything
 * said about it ("gone", "fixed") would be a statement nobody observed.
 *
 * Keys are unique per scan (`findings_scan_signal_key`); should a caller pass
 * a repeated key anyway, its first row is the one used.
 */
export function diffFindings(older: readonly DiffInput[], newer: readonly DiffInput[]): FindingDiff {
  const before = new Map<string, DiffInput>()
  for (const d of older) if (!before.has(d.signalKey)) before.set(d.signalKey, d)

  const seen = new Set<string>()
  const rows: FindingDiffRow[] = []
  for (const n of newer) {
    if (seen.has(n.signalKey)) continue
    seen.add(n.signalKey)
    const o = before.get(n.signalKey)
    rows.push({
      signalKey: n.signalKey,
      change: changeOf(o, n),
      older: o ?? null,
      newer: n,
      scored: n.scored ?? true,
      weight: Math.max(o?.weight ?? 0, n.weight),
    })
  }

  rows.sort((a, b) => b.weight - a.weight || byKey(a.signalKey, b.signalKey))

  const count = (c: SignalChange): number => rows.filter((r) => r.change === c).length
  return {
    rows,
    summary: {
      fixed: count('fixed'),
      regressed: count('regressed'),
      notAssessed: count('not_assessed_this_time'),
      nowObserved: count('now_observed'),
      noLongerApplicable: count('no_longer_applicable'),
      nowApplicable: count('now_applicable'),
    },
  }
}

/** The columns of a `findings` row the diff reads; `evidence` is jsonb, so unknown. */
export interface DiffSource {
  readonly signalKey: string
  readonly observed: boolean
  readonly gap: boolean | null
  readonly detail: string | null
  readonly evidence: unknown
  readonly weight: number
  readonly scored?: boolean
}

/**
 * A stored finding as a `DiffInput`. `findings.evidence` is jsonb and comes
 * back typed `unknown`; every row `recordScan` writes holds an object, and a
 * claimed gap is CHECKed to hold a non-empty one. Anything else is wrapped
 * rather than dropped, so the diff still shows exactly what was stored.
 */
export function diffInputOf(row: DiffSource): DiffInput {
  const e = row.evidence
  const evidence: Readonly<Record<string, unknown>> =
    e === null || e === undefined
      ? {}
      : typeof e === 'object' && !Array.isArray(e)
        ? (e as Record<string, unknown>)
        : { value: e }
  return {
    signalKey: row.signalKey,
    observed: row.observed,
    gap: row.gap,
    detail: row.detail,
    evidence,
    weight: row.weight,
    scored: row.scored ?? true,
  }
}
