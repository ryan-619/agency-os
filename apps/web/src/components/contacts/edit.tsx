'use client'

import { useState } from 'react'

/**
 * Editing a person, and recording what they said about a channel (§2.1).
 *
 * The edit form sends only the fields that changed. The server folds the
 * email, stores a phone in E.164, refuses a duplicate with a sentence, and
 * refuses to edit away an address the suppression list matches — so the
 * error line below the form is where most of the rules show up.
 *
 * The consent form asks for two things every time: where the answer came
 * from (the source), and the words the person was shown or told when they
 * gave it (the wording). Both are kept with the record as its evidence —
 * a consent whose wording nobody can produce is a claim, not a record.
 *
 * A recorded refusal is final against a grant: the grant choice is disabled
 * and says why. The way back is an owner LIFTING the refusal, with a reason,
 * which returns the person to never-asked — not to granted.
 */

export interface EditableContact {
  readonly id: string
  readonly firstName: string | null
  readonly lastName: string | null
  readonly title: string | null
  readonly email: string | null
  readonly phone: string | null
  readonly linkedinUrl: string | null
}

type Channel = 'email' | 'sms' | 'voice' | 'whatsapp'
type Field = 'firstName' | 'lastName' | 'title' | 'email' | 'phone' | 'linkedinUrl'

const FIELDS: readonly { key: Field; label: string; placeholder: string; max: number }[] = [
  { key: 'firstName', label: 'First name', placeholder: '', max: 80 },
  { key: 'lastName', label: 'Last name', placeholder: '', max: 80 },
  { key: 'title', label: 'Title', placeholder: 'Head of Engineering', max: 120 },
  { key: 'email', label: 'Email', placeholder: 'priya@rentman.io', max: 254 },
  { key: 'phone', label: 'Phone', placeholder: '+44 20 7946 0000', max: 40 },
  { key: 'linkedinUrl', label: 'LinkedIn', placeholder: 'https://www.linkedin.com/in/priya-shah', max: 500 },
]

const MAX_WORDING = 600

async function post(url: string, method: 'PATCH' | 'POST', body: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (res.ok) return null
    const b = (await res.json().catch(() => ({}))) as { error?: string }
    return b.error ?? 'That did not work.'
  } catch {
    return 'The request did not complete. Try again.'
  }
}

export function ContactEdit({
  contact,
  channels,
  isOwner,
  onCancel,
}: {
  contact: EditableContact
  channels: readonly { readonly channel: Channel; readonly state: 'granted' | 'refused' | 'never_asked' }[]
  isOwner: boolean
  onCancel: () => void
}) {
  return (
    <div className="two-up" style={{ gap: '0 24px', alignItems: 'start' }}>
      <DetailsForm contact={contact} onCancel={onCancel} />
      <ConsentForm contactId={contact.id} channels={channels} isOwner={isOwner} />
    </div>
  )
}

function DetailsForm({ contact, onCancel }: { contact: EditableContact; onCancel: () => void }) {
  const [values, setValues] = useState<Record<Field, string>>(() => ({
    firstName: contact.firstName ?? '',
    lastName: contact.lastName ?? '',
    title: contact.title ?? '',
    email: contact.email ?? '',
    phone: contact.phone ?? '',
    linkedinUrl: contact.linkedinUrl ?? '',
  }))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const changed = FIELDS.filter((f) => values[f.key].trim() !== (contact[f.key] ?? ''))

  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    const body: Record<string, unknown> = { action: 'update' }
    // Only what moved: a field left alone is not re-validated, so a person
    // imported with a local phone number can still have a title corrected.
    for (const f of changed) body[f.key] = values[f.key].trim() || null
    const err = await post(`/api/contacts/${contact.id}`, 'PATCH', body)
    setBusy(false)
    if (err) {
      setError(err)
      return
    }
    window.location.reload()
  }

  return (
    <div className="row-card slim">
      <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Details</h3>
      <div className="two-up">
        {FIELDS.slice(0, 2).map((f) => (
          <label key={f.key}>
            {f.label}
            <input
              value={values[f.key]}
              maxLength={f.max}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              autoComplete="off"
            />
          </label>
        ))}
      </div>
      {FIELDS.slice(2).map((f) => (
        <label key={f.key}>
          {f.label}
          <input
            value={values[f.key]}
            maxLength={f.max}
            placeholder={f.placeholder}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            autoComplete="off"
          />
        </label>
      ))}
      <span className="hint">
        A phone number needs its country code, and a LinkedIn profile its full URL — a value the suppression list
        could never match is refused rather than stored. An address that is on the suppression list cannot be
        changed here; the opt-out stays with it.
      </span>
      {error ? <div className="err-line">{error}</div> : null}
      <div className="row-actions" style={{ marginTop: 10 }}>
        <button type="button" disabled={busy || changed.length === 0} onClick={() => void save()}>
          {busy ? 'Saving…' : changed.length === 0 ? 'No changes' : `Save ${changed.length === 1 ? 'the change' : `${changed.length} changes`}`}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Close
        </button>
      </div>
    </div>
  )
}

function ConsentForm({
  contactId,
  channels,
  isOwner,
}: {
  contactId: string
  channels: readonly { readonly channel: Channel; readonly state: 'granted' | 'refused' | 'never_asked' }[]
  isOwner: boolean
}) {
  const [channel, setChannel] = useState<Channel>('email')
  const [decision, setDecision] = useState<'granted' | 'refused'>('granted')
  const [source, setSource] = useState('')
  const [wording, setWording] = useState('')
  const [liftReason, setLiftReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const current = channels.find((c) => c.channel === channel)?.state ?? 'never_asked'
  const refused = current === 'refused'
  // A refusal is final against a grant; the form cannot offer one.
  const effective = refused ? 'refused' : decision

  const record = async (): Promise<void> => {
    setBusy(true)
    setError('')
    const err = await post(`/api/contacts/${contactId}/consent`, 'POST', {
      action: 'record',
      channel,
      granted: effective === 'granted',
      source,
      wording,
    })
    setBusy(false)
    if (err) {
      setError(err)
      return
    }
    window.location.reload()
  }

  const lift = async (): Promise<void> => {
    if (!window.confirm(`Lift ${channel} refusal? They go back to never asked — nobody may contact them on ${channel} until a new consent is recorded.`)) return
    setBusy(true)
    setError('')
    const err = await post(`/api/contacts/${contactId}/consent`, 'POST', { action: 'lift', channel, reason: liftReason })
    setBusy(false)
    if (err) {
      setError(err)
      return
    }
    window.location.reload()
  }

  const ready = source.trim().length > 0 && wording.trim().length > 0 && wording.length <= MAX_WORDING

  return (
    <div className="row-card slim">
      <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Record what they said</h3>
      <label>
        Channel
        <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
          {channels.map((c) => (
            <option key={c.channel} value={c.channel}>
              {c.channel} — now {c.state.replace('_', ' ')}
            </option>
          ))}
        </select>
      </label>
      <div style={{ display: 'flex', gap: 16, margin: '8px 0 2px', fontSize: 13 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
          <input
            type="radio"
            name={`decision-${contactId}`}
            checked={effective === 'granted'}
            disabled={refused}
            onChange={() => setDecision('granted')}
          />
          They agreed
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
          <input
            type="radio"
            name={`decision-${contactId}`}
            checked={effective === 'refused'}
            onChange={() => setDecision('refused')}
          />
          They refused
        </label>
      </div>
      {refused ? (
        <div className="hint" style={{ color: 'var(--warn)' }}>
          They refused {channel}, and a refusal is not overwritten by a grant — somebody who said no is not asked
          again. {isOwner
            ? 'As an owner you can lift the refusal below; that returns them to never asked, not to agreed, and a new consent is then recorded on its own.'
            : 'Only an owner can lift it.'}{' '}
          Another refusal can still be recorded, with its own evidence.
        </div>
      ) : null}
      <label>
        Where it came from
        <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="a call on 14 Sep, their reply of 2 Sep" maxLength={200} autoComplete="off" />
      </label>
      <label>
        The wording they were shown or told
        <textarea
          value={wording}
          onChange={(e) => setWording(e.target.value)}
          rows={3}
          maxLength={MAX_WORDING}
          placeholder="Can we text you about the proposal? Reply STOP at any time."
        />
        <span className="hint">
          What they answered, in the words they saw or heard — kept with the record as its evidence.
          {` ${wording.length}/${MAX_WORDING}.`}
        </span>
      </label>
      <div className="row-actions" style={{ marginTop: 8 }}>
        <button type="button" disabled={busy || !ready} onClick={() => void record()}>
          {busy ? 'Recording…' : effective === 'granted' ? `Record ${channel} consent` : `Record ${channel} refusal`}
        </button>
      </div>

      {refused && isOwner ? (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <label>
            Why lift the {channel} refusal? (goes in the audit log)
            <input value={liftReason} onChange={(e) => setLiftReason(e.target.value)} maxLength={500} autoComplete="off" />
          </label>
          <div className="row-actions" style={{ marginTop: 8 }}>
            <button type="button" disabled={busy || !liftReason.trim()} onClick={() => void lift()}>
              Lift refusal
            </button>
          </div>
        </div>
      ) : null}
      {error ? <div className="err-line">{error}</div> : null}
    </div>
  )
}
