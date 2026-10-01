/**
 * What the team's list of buyer links says about each one (PROMPT.md §8.6,
 * under §2.2).
 *
 * The buyer's page answers "being re-verified" — and Accept answers 410 —
 * for a link whose evidence has aged out OR been superseded by a newer
 * successful scan. The team's list read only the link's own columns, so a
 * superseded link was labelled "live" while the buyer holding it could see
 * nothing and accept nothing. The list must say what the buyer sees.
 *
 * `shareState` is pure and pinned directly; the slot that feeds it is a
 * server component with a database behind it, so the wiring is pinned by
 * its source; and the controls are rendered for real, with the router
 * stubbed, so the words a person reads are the ones asserted.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

import { shareState, shareStateLabel } from '../src/components/pipeline/proposal-share-copy'
import { ProposalShareControls, type ShareRowView } from '../src/components/pipeline/proposal-share-controls'

// The classic JSX runtime vitest compiles the app's .tsx with calls
// `React.createElement` on a global at render time.
;(globalThis as { React?: typeof React }).React = React

const HERE = dirname(fileURLToPath(import.meta.url))
const source = (rel: string): string =>
  readFileSync(resolve(HERE, '../src', rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const NOW = new Date('2026-09-10T00:00:00.000Z')
const BASE = { revokedAt: null, acceptedAt: null, expiresAt: '2026-09-15T08:00:00.000Z' }
const FRESH = { stale: false, superseded: false } as const

describe('a link’s state, as the team’s list shows it', () => {
  it('is live only while the buyer can read and accept it', () => {
    expect(shareState(BASE, NOW, FRESH)).toBe('live')
  })

  it('is superseded once a newer successful scan exists — the buyer is told it is being re-verified', () => {
    expect(shareState(BASE, NOW, { stale: false, superseded: true })).toBe('superseded')
    expect(shareStateLabel('superseded')).toBe('superseded — the buyer sees “being re-verified”')
  })

  it('is stale once the evidence ages out under a live link (the threshold lowered after minting)', () => {
    expect(shareState(BASE, NOW, { stale: true, superseded: false })).toBe('stale')
    expect(shareState(BASE, NOW, { stale: true, superseded: true })).toBe('stale')
    expect(shareStateLabel('stale')).toBe('stale — the buyer sees “being re-verified”')
  })

  it('lets the link’s own facts outrank the evidence: accepted, revoked and expired say what happened to the link', () => {
    const both = { stale: true, superseded: true }
    expect(shareState({ ...BASE, acceptedAt: '2026-09-08T00:00:00.000Z' }, NOW, both)).toBe('accepted')
    expect(shareState({ ...BASE, revokedAt: '2026-09-09T00:00:00.000Z' }, NOW, both)).toBe('revoked')
    expect(shareState({ ...BASE, expiresAt: '2026-09-10T00:00:00.000Z' }, NOW, both)).toBe('expired')
  })

  it('labels the link’s own states by their name', () => {
    for (const s of ['live', 'accepted', 'revoked', 'expired'] as const) expect(shareStateLabel(s)).toBe(s)
  })
})

describe('the slot hands the evidence to every row', () => {
  it('passes both the stale and the superseded flag into each row’s state', () => {
    const slot = source('components/pipeline/proposal-share.tsx')
    expect(slot).toMatch(/shareState\(iso, now, \{ stale: evidenceStale, superseded: evidenceSuperseded \}\)/)
  })
})

describe('the rendered list', () => {
  const row = (state: ShareRowView['state']): ShareRowView => ({
    id: '00000000-0000-4000-8000-0000000000bb',
    createdAt: '2026-09-02T08:00:00.000Z',
    expiresAt: '2026-09-15T08:00:00.000Z',
    revokedAt: null,
    acceptedAt: null,
    acceptedByName: null,
    state,
    viewCount: 2,
    firstViewedAt: null,
    lastViewedAt: null,
  })
  const render = (state: ShareRowView['state']): string =>
    renderToStaticMarkup(React.createElement(ProposalShareControls, {
      proposalId: '00000000-0000-4000-8000-0000000000aa',
      shares: [row(state)],
      canWrite: true,
      blocked: 'A newer scan exists — regenerate the proposal.',
    }))

  it('never calls a superseded link live, and says what the buyer sees', () => {
    const html = render('superseded')
    expect(html).not.toMatch(/>live</)
    expect(html).toContain('superseded — the buyer sees “being re-verified”')
    // Still revocable: the token works, and withdrawing it is the team's call.
    expect(html).toContain('Revoke')
  })

  it('renders a live link as live', () => {
    expect(render('live')).toMatch(/>live</)
  })
})
