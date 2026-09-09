/**
 * Role-based capabilities for the agency's own team.
 *
 * PROMPT.md §4: "role gates: only owner can edit connectors and credentials".
 *
 * A pure function over (role, capability). No I/O, no framework, no database —
 * so it is testable in isolation and cannot drift from the UI that consumes it.
 * The UI uses this to decide what to render; the API routes use the SAME
 * function to decide what to permit. Hiding a button is not access control.
 */

export type Role = 'owner' | 'member'

export const ROLES = ['owner', 'member'] as const

/**
 * Every distinct thing a team member can attempt. Add a capability here before
 * adding the screen that needs it — an unlisted capability fails closed.
 */
export type Capability =
  // --- owner only ---------------------------------------------------------
  /** Create, edit, enable or delete an MCP connector (§6). */
  | 'connectors:write'
  /** Read or write a third-party credential (§2.3). */
  | 'credentials:write'
  /** Create, edit or delete a subagent definition (§7). */
  | 'agents:write'
  /** Invite a teammate or change someone's role. */
  | 'users:write'
  /** Turn auto_send on for a campaign — the switch that lets mail leave
   *  the building without a per-message human decision (§2.4). */
  | 'campaigns:set_auto_send'
  // --- any signed-in team member -----------------------------------------
  | 'connectors:read'
  | 'agents:read'
  | 'companies:read'
  | 'companies:write'
  | 'contacts:read'
  | 'contacts:write'
  | 'campaigns:read'
  | 'campaigns:write'
  | 'deals:read'
  | 'deals:write'
  /** Approve or deny a queued high-risk action (§5.4). Any member may decide;
   *  the audit log records which one did. */
  | 'approvals:decide'
  | 'chat:use'
  | 'audit:read'

const OWNER_ONLY: ReadonlySet<Capability> = new Set<Capability>([
  'connectors:write',
  'credentials:write',
  'agents:write',
  'users:write',
  'campaigns:set_auto_send',
])

const MEMBER_ALLOWED: ReadonlySet<Capability> = new Set<Capability>([
  'connectors:read',
  'agents:read',
  'companies:read',
  'companies:write',
  'contacts:read',
  'contacts:write',
  'campaigns:read',
  'campaigns:write',
  'deals:read',
  'deals:write',
  'approvals:decide',
  'chat:use',
  'audit:read',
])

/** The principal an authorisation decision is made about. */
export interface Principal {
  readonly id: string
  readonly orgId: string
  readonly role: Role
}

/**
 * Can this principal perform this capability?
 *
 * Fails closed: an unknown role or an unknown capability returns false rather
 * than throwing, so a typo in a call site denies access instead of granting it.
 */
export function can(principal: Principal | null | undefined, capability: Capability): boolean {
  if (!principal) return false
  if (principal.role === 'owner') {
    return OWNER_ONLY.has(capability) || MEMBER_ALLOWED.has(capability)
  }
  if (principal.role === 'member') {
    return MEMBER_ALLOWED.has(capability)
  }
  return false
}

/**
 * Same decision, but throws. Use at the top of an API route or server action
 * so the failure is impossible to forget to handle.
 */
export class NotPermittedError extends Error {
  readonly capability: Capability
  constructor(capability: Capability) {
    super(`Not permitted: ${capability}`)
    this.name = 'NotPermittedError'
    this.capability = capability
  }
}

export function assertCan(
  principal: Principal | null | undefined,
  capability: Capability,
): asserts principal is Principal {
  if (!can(principal, capability)) throw new NotPermittedError(capability)
}

/**
 * Two principals are in the same organisation. Every query in the app is
 * org-scoped (§4); this is the guard for anything that crosses a row boundary.
 */
export function sameOrg(principal: Principal | null | undefined, orgId: string): boolean {
  return !!principal && principal.orgId === orgId
}
