'use client'

import { useEffect, useRef, useState } from 'react'
import { useFormStatus } from 'react-dom'

/**
 * The sign-in form, as a client component purely for comfort.
 *
 * Everything that MATTERS still happens on the server: the action is passed
 * in, the membership check and the mail live in `auth.ts`, and this file
 * cannot learn whether an address is on the team — it gets the same answer
 * either way, which is the property the whole flow is built around.
 *
 * So the rules here are narrow. It may make typing an address easier. It may
 * not reveal anything, and it may not become a second place where sign-in
 * decisions are made.
 */

const REMEMBERED = 'agency-os:last-sign-in-address'

/** Deliberately loose. The server decides; this only stops empty submits. */
function plausible(value: string): boolean {
  const v = value.trim()
  return v.length > 3 && v.includes('@') && !v.startsWith('@') && !v.endsWith('@')
}

function Submit({ disabled }: { disabled: boolean }) {
  // `useFormStatus` reads the enclosing form's state, so this has to be a
  // child of the <form> rather than a sibling.
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={disabled || pending} aria-busy={pending}>
      {pending ? 'Sending the link…' : 'Email me a sign-in link'}
    </button>
  )
}

export function SignInForm({ action }: { action: (formData: FormData) => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [touched, setTouched] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  /**
   * The address this browser used last, put back so a returning member types
   * nothing. It is the viewer's OWN address in their OWN browser — never a
   * roster, never anything about who else has access.
   *
   * In an effect rather than the first render: reading storage during render
   * makes the server and client markup disagree, which is a hydration error
   * on the one page a person sees before anything else works. Wrapped
   * because storage throws in a private window and comes back empty when
   * site data is cleared.
   */
  useEffect(() => {
    let remembered = ''
    try {
      remembered = window.localStorage.getItem(REMEMBERED) ?? ''
    } catch {
      // No storage is a normal state, not an error worth showing anybody.
    }
    if (remembered) setEmail(remembered)
    // Focus only. `setSelectionRange` throws InvalidStateError on
    // `type="email"` — the platform does not support selection on the
    // address-shaped inputs, which is not obvious until the page white-
    // screens on the one screen a person sees before anything else works.
    input.current?.focus()
  }, [])

  const valid = plausible(email)
  const showProblem = touched && email.trim().length > 0 && !valid

  return (
    <form
      action={action}
      onSubmit={() => {
        try {
          window.localStorage.setItem(REMEMBERED, email.trim())
        } catch {
          // Not remembering is a worse experience, never a failed sign-in.
        }
      }}
      noValidate
    >
      <label htmlFor="email">Email address</label>
      <input
        id="email"
        name="email"
        type="email"
        ref={input}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={() => setTouched(true)}
        required
        autoComplete="email"
        // Addresses are case-insensitive here and stored folded, so a phone
        // capitalising the first letter is just a thing to undo.
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="send"
        inputMode="email"
        placeholder="you@agency.com"
        aria-describedby={showProblem ? 'email-problem' : undefined}
        aria-invalid={showProblem || undefined}
      />
      {showProblem ? (
        <p id="email-problem" className="err-line" role="alert">
          That does not look like an email address yet.
        </p>
      ) : null}
      <Submit disabled={!valid} />
    </form>
  )
}
