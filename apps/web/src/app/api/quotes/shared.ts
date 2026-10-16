import { NextResponse } from 'next/server'
import { can, type Capability } from '@agency/core'
import { auth } from '@/auth'

/**
 * What every quote route does first: a signed-in person who may do this,
 * and a body small enough to read. Sentences for every refusal.
 */
export async function principalFor(capability: Capability): Promise<
  | { readonly ok: true; readonly user: { readonly id: string; readonly orgId: string } }
  | { readonly ok: false; readonly response: NextResponse }
> {
  const session = await auth()
  const user = session?.user
  if (!user) return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, capability)) {
    return { ok: false, response: NextResponse.json({ error: 'You do not have permission to do that.' }, { status: 403 }) }
  }
  return { ok: true, user: { id: user.id, orgId: user.orgId } }
}

export async function bodyOf(request: Request, maxBytes: number): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  const raw = await request.text()
  if (raw.length > maxBytes) return { ok: false, response: NextResponse.json({ error: 'That is far too long.' }, { status: 413 }) }
  if (raw.trim() === '') return { ok: true, body: {} }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, response: NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }
    }
    return { ok: true, body: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }
  }
}

/** A refusal's HTTP status, by reason. */
export function statusFor(reason: string): number {
  switch (reason) {
    case 'not_found':
    case 'no_company':
      return 404
    case 'invalid':
    case 'no_lines':
      return 400
    case 'lapsed':
      return 410
    default:
      return 409
  }
}
