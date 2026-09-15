'use client'

import { useEffect, useState } from 'react'
import { BOOKING_CONSENT_CHANNELS, BOOKING_CONSENT_WORDING } from '@/lib/booking-copy'
import { detectTimeZone, knownTimeZones, wallClockToInstant } from '@/lib/wall-clock'

/**
 * The public booking form (PROMPT.md §8.6, §2.1).
 *
 * The visitor picks a wall-clock time and their zone; the zone is what the
 * send path will later check quiet hours against, so it is asked for
 * explicitly and defaulted from the browser rather than guessed from a
 * country. The consent boxes are unticked, each names a channel, and the
 * wording beside them is the wording the server records — from the same
 * constant, so the evidence is what was on the screen.
 */
export function BookingForm({ slug, orgName }: { slug: string; orgName: string }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [phone, setPhone] = useState('')
  const [local, setLocal] = useState('')
  // The zone and the list of zones are the BROWSER's, and the browser is not
  // the server: Node names the same zone 'Asia/Kolkata' where Chrome says
  // 'Asia/Calcutta', and its list is a different length. Rendering either
  // on the server produced a hydration error on the first live check, so
  // the first render is 'UTC' on both sides and the effect fills in.
  const [zone, setZone] = useState('UTC')
  const [zones, setZones] = useState<string[]>(['UTC'])
  useEffect(() => {
    setZones(knownTimeZones())
    setZone(detectTimeZone())
  }, [])
  const [notes, setNotes] = useState('')
  const [consent, setConsent] = useState<Record<string, boolean>>({ sms: false, voice: false, whatsapp: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const submit = async (): Promise<void> => {
    const startsAt = wallClockToInstant(local, zone)
    if (!startsAt) {
      setError('Please pick a date and time.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/book/${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name, email, company, phone,
          startsAt: startsAt.toISOString(),
          timeZone: zone,
          notes,
          consent,
        }),
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        setError(b.error ?? 'That did not go through. Please try again.')
        return
      }
      setDone(true)
    } catch {
      setError('That did not go through. Please check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="auth book">
        <h1>Thanks, {name.trim().split(/\s+/)[0] || 'there'}.</h1>
        <p>
          {orgName} has your request for <strong>{local.replace('T', ' at ')}</strong> ({zone}). A person will confirm by email
          — nothing is booked automatically, and nobody will call or text unless you ticked the box for it.
        </p>
      </div>
    )
  }

  return (
    <form
      className="auth book"
      onSubmit={(e) => { e.preventDefault(); void submit() }}
    >
      <h1>Book a conversation with {orgName}</h1>
      <p>A short call about your application&apos;s security posture. Pick a time that suits you; a person confirms it.</p>
      {error ? <p className="err" role="alert">{error}</p> : null}

      <label>
        Your name
        <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
      </label>
      <label>
        Work email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
      </label>
      <label>
        Company (optional)
        <input value={company} onChange={(e) => setCompany(e.target.value)} autoComplete="organization" />
      </label>
      <div className="two-up">
        <label>
          When
          <input type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} required />
        </label>
        <label>
          Your timezone
          <select value={zone} onChange={(e) => setZone(e.target.value)}>
            {zones.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </label>
      </div>
      <label>
        Anything you would like to cover (optional)
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      <fieldset className="consent-box">
        <legend>Staying in touch</legend>
        <p className="wording">{BOOKING_CONSENT_WORDING}</p>
        <label>
          Phone number, with country code (optional)
          <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 415 555 0100" autoComplete="tel" />
        </label>
        {BOOKING_CONSENT_CHANNELS.map((c) => (
          <label key={c.key} className="tool-check">
            <input
              type="checkbox"
              checked={consent[c.key] ?? false}
              onChange={(e) => setConsent((k) => ({ ...k, [c.key]: e.target.checked }))}
            />
            {c.label}
          </label>
        ))}
      </fieldset>

      <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Request this time'}</button>
      <p className="fine">
        Nothing here is used for anything but arranging this conversation. You can ask us to stop at any time by replying to any message.
      </p>
    </form>
  )
}
