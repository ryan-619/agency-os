/**
 * While a page is being built on the server (2026-10-09): the shape of one,
 * not a spinner — a title line and a few rows — so the frame is there before
 * the words are. Static markup; the shimmer is the stylesheet's, and stops
 * for a visitor who asked their system for less motion.
 */
export default function Loading() {
  return (
    <div className="loading-page" aria-busy="true" aria-label="Loading">
      <div className="loading-bar loading-title" />
      <div className="loading-bar loading-lede" />
      <div className="loading-rows">
        <div className="loading-bar" />
        <div className="loading-bar" />
        <div className="loading-bar" />
      </div>
    </div>
  )
}
