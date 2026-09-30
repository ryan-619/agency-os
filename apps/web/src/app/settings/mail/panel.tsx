'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  MAIL_DNS_VERDICT_WORDS, type DkimSelectorResult, type MailDnsRecordAssessment, type MailDnsReport,
} from '@/lib/mail-dns'

/**
 * The live lookup for /settings/mail, run in the browser against
 * `GET /api/settings/mail-dns` so a slow nameserver never holds the page.
 *
 * Nothing here decides anything. The verdicts and their sentences are the
 * route's, computed by `lib/mail-dns.ts`; this renders them and offers to ask
 * again. A failed request is said to have failed — it is not rendered as
 * three verdicts.
 */

type State =
  | { readonly phase: 'loading' }
  | { readonly phase: 'done'; readonly report: MailDnsReport }
  | { readonly phase: 'error'; readonly message: string }

const SELECTOR_WORDS: Readonly<Record<DkimSelectorResult['state'], string>> = {
  found: 'key published',
  rsa1024: 'key published (1024-bit RSA)',
  short: 'RSA key shorter than 1024 bits',
  revoked: 'key revoked (empty p=)',
  none: 'TXT present, but not a DKIM key',
  absent: 'no record',
  unchecked: 'could not be checked',
}

export function MailDnsPanel({ dkim }: { dkim: string | null }) {
  const [state, setState] = useState<State>({ phase: 'loading' })

  const run = useCallback(async () => {
    setState({ phase: 'loading' })
    try {
      const res = await fetch(`/api/settings/mail-dns${dkim ? `?dkim=${encodeURIComponent(dkim)}` : ''}`, {
        cache: 'no-store',
      })
      const body = (await res.json().catch(() => null)) as
        | ({ checked: true } & MailDnsReport)
        | { checked: false; reason: string }
        | { error?: string }
        | null
      if (!res.ok || body === null || !('checked' in body)) {
        const message = body && 'error' in body && body.error ? body.error : `The check did not complete (${res.status}).`
        setState({ phase: 'error', message })
        return
      }
      if (!body.checked) {
        setState({ phase: 'error', message: 'MAIL_FROM has no public domain to check.' })
        return
      }
      setState({ phase: 'done', report: body })
    } catch {
      setState({ phase: 'error', message: 'The check did not complete. Try again.' })
    }
  }, [dkim])

  useEffect(() => {
    void run()
  }, [run])

  return (
    <div>
      <div className="row-actions" style={{ margin: '4px 0 12px' }}>
        <button type="button" onClick={() => void run()} disabled={state.phase === 'loading'}>
          {state.phase === 'loading' ? 'Checking…' : 'Check again'}
        </button>
      </div>
      {state.phase === 'error' ? <p className="err-line">{state.message}</p> : null}
      {state.phase === 'loading' ? <p className="muted">Asking DNS…</p> : null}
      {state.phase === 'done' ? (
        <>
          <Record title="SPF" name={state.report.domain} a={state.report.spf} />
          <Record title="DMARC" name={`_dmarc.${state.report.domain}`} a={state.report.dmarc} />
          <Record title="DKIM" name={`<selector>._domainkey.${state.report.domain}`} a={state.report.dkim}>
            <ul className="tools">
              {state.report.dkim.selectors.map((s) => (
                <li key={s.selector}>
                  <code>{s.selector}</code> — {SELECTOR_WORDS[s.state]}
                  {s.code ? ` (${s.code})` : ''}
                </li>
              ))}
            </ul>
          </Record>
        </>
      ) : null}
    </div>
  )
}

function Record({
  title, name, a, children,
}: {
  title: string
  name: string
  a: MailDnsRecordAssessment
  children?: React.ReactNode
}) {
  const tag = a.verdict === 'pass' ? 'tag on' : a.verdict === 'unchecked' ? 'tag' : 'tag warn'
  return (
    <div
      className={a.verdict === 'pass' ? 'probe ok' : 'probe'}
      style={a.verdict === 'weak' || a.verdict === 'missing' ? { borderLeftColor: 'var(--warn)' } : undefined}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong>{title}</strong>
        <span className={tag}>{MAIL_DNS_VERDICT_WORDS[a.verdict]}</span>
        <code className="muted" style={{ marginLeft: 'auto' }}>{name}</code>
      </div>
      <div style={{ marginTop: 6 }}>{a.detail}</div>
      {a.record ? (
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '6px 0 0', fontSize: 12 }}>{a.record}</pre>
      ) : null}
      {children}
    </div>
  )
}
