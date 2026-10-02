import { SHARED_NUMBER_HOLDER_WORDS } from '@/lib/shared-number-pause'

/**
 * What a shared number's holder is told beside Resume (review round 9):
 * `SHARED_NUMBER_HOLDER_WORDS`, with the suppression list as a link. Used by
 * every screen that renders that pause with a Resume button — /contacts, the
 * company page's People, /suppressions' paused list and /inbox — so the four
 * say one thing.
 */
export function SharedNumberHolderNote() {
  return (
    <>
      {SHARED_NUMBER_HOLDER_WORDS.lead}
      <a href="/suppressions">{SHARED_NUMBER_HOLDER_WORDS.link}</a>
      {SHARED_NUMBER_HOLDER_WORDS.tail}
    </>
  )
}
