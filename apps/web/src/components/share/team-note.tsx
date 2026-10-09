/**
 * Shown on a business's link to somebody signed in to the team that made it
 * (2026-10-08): this is the page as the business sees it, and their own
 * visit is not counted.
 */
export function TeamNote({ agency, quote = false }: { agency: string; quote?: boolean }) {
  return (
    <div className="team-note" role="note">
      You are signed in to {agency}, so this is the page as the business sees it — your visit is not counted and raises
      no follow-up task.{quote ? ' Their answer buttons are off for you: record their answer on the quote’s own page.' : ''}
    </div>
  )
}
