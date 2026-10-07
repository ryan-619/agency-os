import { z } from 'zod'
import { can, type Principal } from '@agency/core'

/**
 * Settings → Assistant's routes, the pure half (0020): who may read and change
 * the playbook and the morning brief, and what a request may carry.
 *
 * Kept beside the routes, with no `server-only` and no `@/` import, so
 * `apps/web/test/assistant-settings.test.ts` runs the routes' OWN rules
 * rather than a copy of them.
 *
 * Both are the agent's configuration, so they take the agent definitions'
 * capabilities: every member reads them (`agents:read`), and only an owner
 * changes them (`agents:write`). The playbook is appended to the AI's
 * instructions on every turn, as a subagent's prompt is; the brief spends the
 * agency's model budget every day with nobody watching. A role `can()` does
 * not know gets neither.
 */
export const ASSISTANT_READ = 'agents:read' as const
export const ASSISTANT_WRITE = 'agents:write' as const

export function mayReadAssistant(principal: Principal | null | undefined): boolean {
  return can(principal, ASSISTANT_READ)
}

export function mayWriteAssistant(principal: Principal | null | undefined): boolean {
  return can(principal, ASSISTANT_WRITE)
}

/**
 * The largest body either route reads. The playbook is at most 20,000
 * characters (`PLAYBOOK_MAX_CHARS`), which JSON can spell in up to six times
 * as many as `\uXXXX` escapes; anything past this is not a playbook.
 */
export const ASSISTANT_MAX_REQUEST_BYTES = 256_000

/**
 * The playbook as typed. Its bound and its NUL are `savePlaybook`'s, which
 * answers each with a sentence that counts characters as Postgres does; this
 * only stops a body no playbook could be.
 */
export const playbookSchema = z.object({
  playbook: z.string('Send the playbook as text.').max(120_000, 'That playbook is far too long.'),
})

/** The brief's switch and schedule. Whether the time and zone read is `saveBrief`'s. */
export const briefSchema = z.object({
  enabled: z.boolean('Say whether the morning brief is on or off.'),
  at: z.string('Choose a time.').max(16, 'Choose a time such as 08:30.'),
  timeZone: z.string('Choose a time zone.').max(64, 'Choose a time zone such as Asia/Kolkata.'),
})

/** A zod failure as one sentence for the person who pressed the button. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'That request could not be read.'
}
