'use client'

import { useEffect, useId, useState } from 'react'
import type { SearchHit, SearchKind } from '@agency/db/queries'

/**
 * The search box above the sidebar navigation, on every signed-in page.
 *
 * It asks `GET /api/search`, which answers only from the caller's org and
 * only from the sections their role may read — this component decides
 * nothing about access, and an empty answer says so in those words ("in
 * what you can see") rather than implying the CRM holds nothing.
 *
 * Driveable from the keyboard, the way the pipeline board is: arrow keys
 * move through the hits, Enter opens the highlighted one (or the only one),
 * Escape clears. Every hit is a real link, so a click, a middle-click and a
 * screen reader all get what they expect.
 *
 * The pure parts — how the box reads what was typed, how hits are grouped,
 * where the arrow keys go and what Enter opens — are exported and tested in
 * `apps/web/test/search-source.test.ts`; there is no DOM test environment
 * here, so logic left inside the component would be untested by construction.
 */

/**
 * The route refuses fewer, and one character on `%x%` would match nearly
 * every row. Mirrors `SEARCH_MIN_CHARS` in `packages/db/src/search.ts`
 * (a client bundle cannot import that module); the source test keeps the
 * two equal.
 */
export const SEARCH_BOX_MIN_CHARS = 2
const DEBOUNCE_MS = 200

const HEADINGS: Readonly<Record<SearchKind, string>> = {
  company: 'Companies',
  contact: 'People',
  deal: 'Deals',
  meeting: 'Meetings',
  proposal: 'Proposals',
  campaign: 'Campaigns',
  touch: 'Messages',
}

/** What was typed, read the way the route reads it: trimmed, runs of whitespace as one space. */
export function searchBoxQuery(typed: string): string {
  return typed.replace(/\s+/g, ' ').trim()
}

export interface SearchGroup {
  readonly kind: SearchKind
  readonly heading: string
  readonly hits: readonly SearchHit[]
}

/**
 * Hits grouped under a heading per kind, in the order the route sent them
 * (it merges its sections in a fixed order, so the same query draws the same
 * list). The arrow keys walk `searchBoxFlat` of these groups, so the
 * highlighted hit is always the one on screen at that position.
 */
export function searchBoxGroups(hits: readonly SearchHit[]): SearchGroup[] {
  const groups = new Map<SearchKind, SearchHit[]>()
  for (const hit of hits) {
    const list = groups.get(hit.kind)
    if (list) list.push(hit)
    else groups.set(hit.kind, [hit])
  }
  return [...groups].map(([kind, list]) => ({ kind, heading: HEADINGS[kind] ?? kind, hits: list }))
}

/** The hits in the order they are drawn. */
export function searchBoxFlat(groups: readonly SearchGroup[]): SearchHit[] {
  return groups.flatMap((g) => [...g.hits])
}

/**
 * Where a key moves the highlight. `-1` is "nothing highlighted" — the
 * caret is in the box. Down from the last hit and up from the first wrap,
 * and up from the box goes to the last hit, as a list box does.
 */
export function searchBoxMove(active: number, key: string, count: number): number {
  if (count <= 0) return -1
  switch (key) {
    case 'ArrowDown':
      return active < 0 || active >= count - 1 ? 0 : active + 1
    case 'ArrowUp':
      return active <= 0 ? count - 1 : active - 1
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return active
  }
}

/**
 * What Enter opens: the highlighted hit, or — with nothing highlighted —
 * the only hit when there is exactly one. With several and none chosen,
 * Enter does nothing rather than guess.
 */
export function searchBoxEnter(hits: readonly SearchHit[], active: number): string | null {
  const chosen = active >= 0 ? hits[active] : hits.length === 1 ? hits[0] : undefined
  return chosen ? chosen.href : null
}

type Answer =
  | { readonly state: 'none' }
  | { readonly state: 'done'; readonly q: string; readonly hits: readonly SearchHit[]; readonly truncated: boolean }
  | { readonly state: 'error'; readonly q: string; readonly message: string }

/** A refusal in words a person can act on. The route's own sentence where it has one. */
function refusal(status: number, error: unknown): string {
  if (status === 401) return 'Your session has ended. Sign in again to search.'
  if (status === 403) return 'Your role cannot read any of what search covers.'
  return typeof error === 'string' && error !== 'forbidden' ? error : 'The search did not complete. Try again.'
}

export function SearchBox(): React.ReactNode {
  const listId = useId()
  const [typed, setTyped] = useState('')
  const [answer, setAnswer] = useState<Answer>({ state: 'none' })
  const [active, setActive] = useState(-1)
  const [open, setOpen] = useState(false)

  const q = searchBoxQuery(typed)

  useEffect(() => {
    if (q.length < SEARCH_BOX_MIN_CHARS) {
      setAnswer({ state: 'none' })
      setActive(-1)
      return
    }
    // Aborted when the query changes, so an answer to something the person
    // has typed past can never land on top of the one they are waiting for.
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
            headers: { accept: 'application/json' },
            signal: controller.signal,
          })
          const out = (await res.json().catch(() => ({}))) as { hits?: unknown; truncated?: unknown; error?: unknown }
          if (controller.signal.aborted) return
          if (!res.ok) {
            setAnswer({ state: 'error', q, message: refusal(res.status, out.error) })
          } else {
            setAnswer({ state: 'done', q, hits: Array.isArray(out.hits) ? (out.hits as SearchHit[]) : [], truncated: out.truncated === true })
          }
          setActive(-1)
        } catch {
          if (controller.signal.aborted) return
          setAnswer({ state: 'error', q, message: 'The search did not complete. Try again.' })
        }
      })()
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [q])

  // Only an answer to what is in the box NOW is acted on. The previous
  // answer stays drawn while the next is on its way (no flicker between
  // keystrokes), but Enter never opens a hit from it.
  const current = answer.state !== 'none' && answer.q === q
  const groups = answer.state === 'done' ? searchBoxGroups(answer.hits) : []
  const flat = searchBoxFlat(groups)
  const optionId = (i: number): string => `${listId}-hit-${i}`

  useEffect(() => {
    if (active < 0) return
    document.getElementById(`${listId}-hit-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, listId])

  const clear = (): void => {
    setTyped('')
    setAnswer({ state: 'none' })
    setActive(-1)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      clear()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
      setActive((a) => searchBoxMove(a, e.key, flat.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!current) return
      const href = searchBoxEnter(flat, active)
      if (href) window.location.assign(href)
    }
  }

  const showing = open && typed.trim() !== ''
  let status: React.ReactNode = null
  if (q.length < SEARCH_BOX_MIN_CHARS) status = <>Type at least {SEARCH_BOX_MIN_CHARS} characters.</>
  else if (answer.state === 'none') status = 'Searching…'
  else if (answer.state === 'error') {
    status = current ? <span className="err-line" role="alert" style={{ margin: 0 }}>{answer.message}</span> : 'Searching…'
  } else if (flat.length === 0) status = current ? 'Nothing matches in what you can see.' : 'Searching…'

  return (
    <div
      className="search-box"
      onBlur={(e) => {
        // Closed when focus leaves the box entirely, not when it moves to a hit.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <input
        type="search"
        placeholder="Search companies, people, deals…"
        aria-label="Search"
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showing && flat.length > 0}
        aria-controls={listId}
        aria-activedescendant={showing && active >= 0 ? optionId(active) : undefined}
        value={typed}
        onChange={(e) => {
          setTyped(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {showing ? (
        // mousedown would move focus off the input before the click lands, and
        // some browsers do not focus a link on click at all — so the list
        // would close under the pointer. Keeping focus in the input avoids it.
        <div className="search-results" onMouseDown={(e) => e.preventDefault()}>
          {status !== null ? (
            <div className="muted" role="status" style={{ padding: '6px 10px', fontSize: 12.5 }}>{status}</div>
          ) : null}
          <div id={listId} role="listbox" aria-label="Search results">
            {groups.map((group) => {
              const headingId = `${listId}-${group.kind}`
              return (
                <div key={group.kind} role="group" aria-labelledby={headingId}>
                  <div
                    id={headingId}
                    style={{ padding: '6px 10px 2px', fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.03em' }}
                  >
                    {group.heading}
                  </div>
                  {group.hits.map((hit) => {
                    const i = flat.indexOf(hit)
                    return (
                      <a
                        key={`${hit.kind}:${hit.id}`}
                        id={optionId(i)}
                        role="option"
                        aria-selected={i === active}
                        href={hit.href}
                        className={i === active ? 'search-hit on' : 'search-hit'}
                        style={{ overflowWrap: 'anywhere' }}
                        onMouseEnter={() => setActive(i)}
                      >
                        {hit.label}
                        {hit.sub ? <span className="k">· {hit.sub}</span> : null}
                      </a>
                    )
                  })}
                </div>
              )
            })}
          </div>
          {answer.state === 'done' && answer.truncated && flat.length > 0 ? (
            <div className="muted" style={{ padding: '6px 10px', fontSize: 12, borderTop: '1px solid var(--line)' }}>
              More matched than is shown. Type more to narrow it.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
