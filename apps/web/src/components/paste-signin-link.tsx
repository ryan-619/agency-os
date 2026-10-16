'use client'

import { useEffect, useState } from 'react'
import { signInLinkFrom } from '../lib/signin-link'

/**
 * "Signing in from the app on your phone?" (2026-10-09). On an iPhone the
 * app installed to the home screen keeps its own cookies, and the link in
 * the email opens in Safari instead — signed in there, and not here. So the
 * person copies the link from the email (press and hold, Copy) and pastes it
 * here, and the app opens it in its own window. `signInLinkFrom` refuses
 * anything but this app's own sign-in link.
 *
 * Open from the start inside the installed app, where it is the way in, and
 * a line to open elsewhere, where the link in the email just works.
 */
export function PasteSignInLink() {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    if (standalone) setOpen(true)
  }, [])

  const go = () => {
    const link = signInLinkFrom(value, window.location.origin)
    if (!link) {
      setError('That is not a sign-in link for this app. Copy the whole link from the email, then paste it here.')
      return
    }
    setError('')
    window.location.assign(link)
  }

  return (
    <details className="paste-link" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Signing in from the app on your phone?</summary>
      <p>
        The link in the email opens in your browser, not in the app. In the email, press and hold the link, tap Copy,
        then paste it here.
      </p>
      {/* Its own check below: the browser's would refuse a line of the email around the link. */}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          go()
        }}
      >
        <input
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Paste the sign-in link"
          aria-label="Sign-in link from the email"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError('')
          }}
        />
        {error ? <p className="err" role="alert">{error}</p> : null}
        <button type="submit" disabled={!value.trim()}>
          Sign in here
        </button>
      </form>
    </details>
  )
}
