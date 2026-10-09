'use client'

import { useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { MOTION_OK, gsap, useGSAP } from '@/components/motion/gsap'
import { CHECK_THANKS } from '@/lib/check-copy'

/**
 * What the check reads, shown in turn while it runs (2026-10-09). Each line
 * is something the scan really does to the homepage it fetches; the turns are
 * paced by the clock, not by the scan, so none of them says it has finished
 * or what it found.
 */
const CHECK_STEPS = [
  'Opening your homepage',
  'Checking how it looks on a phone',
  'Looking for ways customers can reach you',
  'Reading what search engines and browsers see',
] as const

/** The steps above, one after another while the check runs — or all at once where motion is unwelcome. */
function CheckProgress() {
  const root = useRef<HTMLDivElement>(null)
  useGSAP(
    () => {
      const mm = gsap.matchMedia()
      mm.add(MOTION_OK, () => {
        const steps = gsap.utils.toArray<HTMLElement>('.check-step')
        gsap.set(steps, { opacity: 0.35 })
        gsap.fromTo('.check-meter > span', { scaleX: 0 }, { scaleX: 0.94, duration: 26, ease: 'power2.out' })
        const tl = gsap.timeline()
        steps.forEach((step, i) => {
          tl.to(step, { opacity: 1, duration: 0.45, onStart: () => step.classList.add('now') }, i * 5.5)
          if (i > 0) tl.call(() => steps[i - 1]?.classList.replace('now', 'done'), undefined, i * 5.5)
        })
      })
    },
    { scope: root },
  )
  return (
    <div ref={root} className="check-progress" role="status" aria-live="polite">
      <div className="check-meter" aria-hidden="true"><span /></div>
      <ol>
        {CHECK_STEPS.map((step) => (
          <li key={step} className="check-step">
            <span className="check-step-mark" aria-hidden="true"><Check /></span>
            {step}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** The free website check's form (2026-10-08). On success the visitor goes straight to their own page. */
export function CheckForm({ slug, consentWording }: { readonly slug: string; readonly consentWording: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/check/${slug}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          website: f.get('website'),
          business: f.get('business'),
          name: f.get('name'),
          email: f.get('email'),
          consent: f.get('consent') === 'on',
          website_confirm: f.get('website_confirm'),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { url?: string | null; error?: string }
      if (!res.ok) {
        setError(data.error ?? 'That did not work. Please try again.')
        return
      }
      if (data.url) window.location.href = data.url
      else setDone(true)
    } finally {
      setBusy(false)
    }
  }

  if (done) return <p className="note check-done">{CHECK_THANKS}</p>
  return (
    <form onSubmit={(e) => void submit(e)} className="check-form">
      <label>
        Your website
        <input name="website" type="text" inputMode="url" placeholder="yourbusiness.com" required maxLength={300} autoComplete="url" />
      </label>
      <label>
        <span>Business name <span className="muted">(optional)</span></span>
        <input name="business" type="text" maxLength={120} autoComplete="organization" />
      </label>
      <label>
        Your name
        <input name="name" type="text" required maxLength={120} autoComplete="name" />
      </label>
      <label>
        Your email
        <input name="email" type="email" required maxLength={254} autoComplete="email" />
      </label>
      {/* Hidden from people; a form-filling robot fills it, and its request is quietly ignored. */}
      <label className="check-trap" aria-hidden="true">
        Leave this empty
        <input name="website_confirm" type="text" tabIndex={-1} autoComplete="off" />
      </label>
      <label className="check-consent">
        <input name="consent" type="checkbox" required /> <span>{consentWording}</span>
      </label>
      <button type="submit" className="primary check-submit" disabled={busy}>
        {busy ? 'Checking your site — this takes up to half a minute…' : 'Check my website'}
      </button>
      {busy ? <CheckProgress /> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </form>
  )
}
