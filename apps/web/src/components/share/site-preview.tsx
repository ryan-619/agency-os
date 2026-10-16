import type { ReactNode } from 'react'
import { phoneForDisplay, siteTagline, siteTemplateFor, whatsappLink } from '@agency/core'

/**
 * The website preview's page (2026-10-08): one page for a business, from its
 * Google listing and a template for its kind of business
 * (`packages/core/src/site-preview.ts`), under a banner that says whose
 * preview it is and that it is not a live website.
 *
 * Plain data in, markup out — no database, no `server-only`, no `@/` import
 * — so a test renders it. Every fact on it is the listing's (name, city,
 * rating and reviews, address, phone, map link); the template's services are
 * examples of what such a business offers, and nothing claims anything about
 * this one that the listing does not.
 */
export interface SitePreviewBusiness {
  readonly name: string
  readonly category: string | null
  readonly city: string | null
  /** E.164, or null. */
  readonly phone: string | null
  readonly address: string | null
  readonly mapsUrl: string | null
  readonly rating: number | null
  readonly reviews: number | null
  readonly listingCheckedAt: Date | null
}

export function SitePreview({
  business,
  agency,
  talkToAgency,
  year,
  notice,
}: {
  readonly business: SitePreviewBusiness
  readonly agency: string
  /** Where "Like it? Talk to us" goes — the agency's WhatsApp, mail or booking page — or null. */
  readonly talkToAgency: string | null
  readonly year: number
  /** Rendered first: the teammate's note, or the view beacon. */
  readonly notice?: ReactNode
}) {
  const b = business
  const t = siteTemplateFor(b.category)
  const [deep, light] = t.colours
  const tagline = siteTagline(t, b.city)
  const call = b.phone ? `tel:${b.phone}` : null
  const wa = whatsappLink(b.phone, `Hi ${b.name}, I found you online.`)
  const maps = b.mapsUrl && b.mapsUrl.startsWith('https://') ? b.mapsUrl : null
  const rating = b.rating !== null && Number.isFinite(b.rating) ? b.rating : null
  const reviews = b.reviews !== null && b.reviews > 0 ? b.reviews : null
  const main = wa ?? call

  return (
    <div className="sp" style={{ ['--deep' as string]: deep, ['--light' as string]: light }}>
      <style>{CSS}</style>
      {notice}
      <div className="sp-banner" role="note">
        <span>
          A preview made by <strong>{agency}</strong> for {b.name} — not a live website.
        </span>
        {talkToAgency ? (
          <a href={talkToAgency} target="_blank" rel="noreferrer noopener">
            Like it? Talk to us
          </a>
        ) : null}
      </div>

      <nav className="sp-nav">
        <div className="sp-brand">{b.name}</div>
        {call ? <a className="sp-btn primary sp-small" href={call}>Call now</a> : null}
      </nav>

      <header className="sp-hero">
        {/* Shapes behind the hero, which drift as the page scrolls (preview-motion.tsx). */}
        <span className="sp-blob sp-blob-1" aria-hidden="true" />
        <span className="sp-blob sp-blob-2" aria-hidden="true" />
        <div className="sp-hero-in">
          <div className="sp-kind">{t.kind}{b.city ? ` · ${b.city}` : ''}</div>
          <h1>{b.name}</h1>
          <p className="sp-tag">{tagline}</p>
          {rating !== null ? (
            <div className="sp-rating">
              <b>★ {rating.toFixed(1)}</b>
              <span>{reviews ? `${reviews.toLocaleString('en-IN')} reviews on Google` : 'on Google'}</span>
            </div>
          ) : null}
          <div className="sp-ctas">
            {main ? (
              <a className="sp-btn primary" href={main} {...(wa ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>{t.action}</a>
            ) : null}
            {wa && call ? <a className="sp-btn ghost" href={call}>Call</a> : null}
            {maps ? <a className="sp-btn ghost" href={maps} target="_blank" rel="noreferrer noopener">Directions</a> : null}
          </div>
        </div>
      </header>

      <section className="sp-sec">
        <h2>What we offer</h2>
        <div className="sp-grid sp-services">
          {t.services.map((s) => (
            <div key={s} className="sp-card">
              <div className="sp-dot" aria-hidden />
              <b>{s}</b>
              <span className="sp-muted">Ask us for details and prices.</span>
            </div>
          ))}
        </div>
      </section>

      <section className="sp-band">
        <div className="sp-sec">
          <h2>Why customers choose {b.name}</h2>
          <div className="sp-grid">
            {rating !== null && reviews ? (
              <div className="sp-card"><b>Rated {rating.toFixed(1)} on Google</b><span className="sp-muted">by {reviews.toLocaleString('en-IN')} customers</span></div>
            ) : null}
            <div className="sp-card"><b>Easy to reach</b><span className="sp-muted">{wa ? 'Message us on WhatsApp, or call.' : call ? 'Call us during opening hours.' : 'Visit us, or write to us.'}</span></div>
            <div className="sp-card"><b>{b.city ? `Here in ${b.city}` : 'Close to you'}</b><span className="sp-muted">{maps ? 'Find us on Google Maps.' : 'Ask us for directions.'}</span></div>
          </div>
        </div>
      </section>

      <section className="sp-sec">
        <h2>Visit us</h2>
        <div className="sp-visit">
          <div className="sp-card">
            {b.address ? <p style={{ marginTop: 0 }}>{b.address}</p> : null}
            {b.phone && call ? <p><a href={call}>{phoneForDisplay(b.phone)}</a></p> : null}
            <div className="sp-ctas">
              {maps ? <a className="sp-btn primary" href={maps} target="_blank" rel="noreferrer noopener">Open in Google Maps</a> : null}
              {wa ? <a className="sp-btn ghost" href={wa} target="_blank" rel="noreferrer noopener">WhatsApp</a> : null}
            </div>
          </div>
          <div className="sp-card sp-hours">
            <b>Opening hours</b>
            <span className="sp-muted">Shown here once you share them with us.</span>
          </div>
        </div>
      </section>

      <footer className="sp-foot">
        © {year} {b.name} · Website preview by {agency}, from your public Google listing
        {b.listingCheckedAt ? ` (read ${b.listingCheckedAt.toISOString().slice(0, 10)})` : ''}.
      </footer>
    </div>
  )
}

const CSS = `
.sp { font-family: var(--font-geist-sans, -apple-system), -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1c1c1e; background: #fff; min-height: 100vh; overflow-x: clip; }
.motion-ok .sp:not(.sp-ready) { visibility: hidden; animation: sp-shown-anyway 0s linear 1.2s forwards; }
@keyframes sp-shown-anyway { to { visibility: visible; } }
.sp a { color: inherit; }
.sp-banner { position: sticky; top: 0; z-index: 10; background: #111; color: #fff; font-size: 13px; padding: 8px 16px; display: flex; gap: 10px; justify-content: center; align-items: center; flex-wrap: wrap; text-align: center; }
.sp-banner a { background: #fff; color: #111 !important; border-radius: 999px; padding: 4px 12px; text-decoration: none; font-weight: 600; }
.sp-nav { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 20px; max-width: 1040px; margin: 0 auto; }
.sp-brand { font-weight: 800; font-size: 18px; color: var(--deep); }
.sp-btn { display: inline-block; position: relative; overflow: hidden; isolation: isolate; border-radius: 999px; padding: 11px 20px; font-weight: 600; text-decoration: none; border: 2px solid var(--deep); white-space: nowrap; transition: transform .25s cubic-bezier(.22,1,.36,1), box-shadow .25s cubic-bezier(.22,1,.36,1), background-color .2s; }
.sp-btn:active { transform: scale(.97); }
.sp-btn.sp-small { padding: 7px 14px; font-size: 14px; }
.sp-btn.primary { background: var(--deep); color: #fff !important; }
.sp-btn.ghost { background: #fff; color: var(--deep) !important; }
.sp-hero { position: relative; overflow: hidden; background: linear-gradient(135deg, var(--light), #fff 70%); padding: 56px 20px 64px; }
.sp-blob { position: absolute; border-radius: 50%; pointer-events: none; background: var(--deep); }
.sp-blob-1 { right: -90px; top: -90px; width: 340px; height: 340px; opacity: .08; }
.sp-blob-2 { left: -140px; bottom: -170px; width: 320px; height: 320px; opacity: .05; }
.sp-hero-in { position: relative; max-width: 1040px; margin: 0 auto; }
.sp-kind { text-transform: uppercase; letter-spacing: .12em; font-size: 12px; color: var(--deep); font-weight: 700; }
.sp-hero h1 { font-size: clamp(32px, 6vw, 56px); line-height: 1.05; margin: 10px 0 12px; color: #111; }
.sp-tag { font-size: clamp(17px, 2.4vw, 21px); color: #444; max-width: 640px; margin: 0 0 22px; }
.sp-rating { display: inline-flex; gap: 8px; align-items: center; background: #fff; border: 1px solid #e5e5ea; border-radius: 999px; padding: 6px 14px; font-size: 14px; margin-bottom: 22px; }
.sp-rating b { color: #c98500; }
.sp-ctas { display: flex; gap: 10px; flex-wrap: wrap; }
.sp-sec { max-width: 1040px; margin: 0 auto; padding: 48px 20px; }
.sp-sec h2 { font-size: 26px; margin: 0 0 18px; color: #111; }
.sp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
.sp-card { border: 1px solid #ececf0; border-radius: 14px; padding: 18px; background: #fff; color: #1c1c1e; box-shadow: 0 1px 2px rgba(0,0,0,.04); transition: transform .3s cubic-bezier(.22,1,.36,1), box-shadow .3s cubic-bezier(.22,1,.36,1); }
@media (hover: hover) {
  .sp-btn:hover { transform: translateY(-2px); box-shadow: 0 12px 24px -12px var(--deep); }
  .sp-card:hover { transform: translateY(-4px); box-shadow: 0 20px 40px -20px rgba(0,0,0,.28); }
}
.sp-card b { display: block; font-size: 16px; margin-bottom: 4px; }
.sp-muted { color: #666; font-size: 14px; }
.sp-dot { width: 34px; height: 34px; border-radius: 10px; background: linear-gradient(135deg, var(--light), #fff); border: 1px solid var(--deep); margin-bottom: 10px; }
.sp-band { background: var(--deep); }
.sp-band h2 { color: #fff; }
.sp-services { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
.sp-visit { display: grid; grid-template-columns: 1fr; gap: 14px; }
.sp-hours { background: var(--light); }
.sp-foot { text-align: center; color: #888; font-size: 13px; padding: 28px 20px 40px; }
@media (min-width: 720px) { .sp-visit { grid-template-columns: 1.2fr 1fr; } }
`
