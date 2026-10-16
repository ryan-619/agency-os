/**
 * A business's own pages, from chat (2026-10-08): the link to its audit page
 * — what we noticed about its presence online, beside its nearest
 * competitors — or to a preview of the website the agency would build it.
 *
 * Making a link SENDS nothing: a person pastes it into a message they write,
 * or presses Draft email on the company page, and that email waits on
 * /approvals like every other. So this changes only the agency's own records
 * and runs without a card. The link is printed in the chat — the database
 * keeps only its hash — so the summary says how to revoke it if it goes
 * astray. The first time the business reads it, the person whose chat this
 * is gets a task to follow up.
 */
import { z } from 'zod'
import { can, isNoSiteDomain } from '@agency/core'
import { SHARE_LINK_TTL_DAYS, findCompanyByDomain, shareLinkMint } from '@agency/db'
import { normaliseDomain } from '@agency/scanner'
import { bounded, fail, ok, type AgencyToolSpec, type ToolOutcome } from './spec.js'

export const SHARE_PATHS = { report: '/r/', preview: '/w/' } as const
const WORDS = { report: 'audit page', preview: 'website preview' } as const

const shape = {
  domain: z
    .string()
    .min(1)
    .max(253)
    .describe('The company, by its domain as the CRM has it — a business with no website has a placeholder domain, as get_company and search_companies print it.'),
  kind: z.enum(['report', 'preview']).describe('report: its own audit page; preview: a preview of a website for it, made from its Google listing.'),
}

export const createShareLink: AgencyToolSpec<typeof shape> = {
  name: 'create_share_link',
  description:
    'Make a link to a business’s own audit page (report: what we noticed about its presence online, dated, how it ' +
    'compares with similar businesses near it — never named — and what we would do, at catalogue prices) or to a ' +
    'preview of a website for it (preview: a one-page site from its Google listing, under a banner saying it is a ' +
    'preview by us). It opens for 30 days. It SENDS nothing: give the link to the person to paste into a message they ' +
    'write, or tell them Draft email on the company page drafts one for /approvals. The first time the business reads ' +
    'it, the person you are helping gets a task to call them.',
  shape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'companies:write')) return fail('not_permitted', 'The person you are helping cannot make links for companies.')
    const company = await findCompanyByDomain(ctx.db, ctx.orgId, normaliseDomain(input.domain))
    if (!company) return fail('not_found', `No company with domain "${input.domain}" is in the CRM. Nothing was made.`)
    const name = company.name || company.domain
    if (input.kind === 'preview' && company.listingCheckedAt === null) {
      return fail(
        'invalid_state',
        `${name} has no Google listing on record, and a preview is built from one: find it with find_businesses and file ` +
          'it with add_businesses first. Nothing was made.',
      )
    }
    const now = ctx.now()
    const expiresAt = new Date(now.getTime() + SHARE_LINK_TTL_DAYS * 86_400_000)
    const { token, link } = await shareLinkMint(ctx.db, {
      orgId: ctx.orgId,
      kind: input.kind,
      companyId: company.id,
      // The link is the chat owner's to send, so the first view's task is theirs; the audit row says the agent made it.
      createdBy: ctx.principal.id,
      actor: 'agent',
      expiresAt,
    })
    await ctx.audit('agent.create_share_link', { kind: input.kind, companyId: company.id, linkId: link.id })
    const path = `${SHARE_PATHS[input.kind]}${token}`
    const url = ctx.webOrigin ? new URL(path, ctx.webOrigin).toString() : null
    const what = WORDS[input.kind]
    return ok(
      { linkId: link.id, kind: input.kind, expiresAt: expiresAt.toISOString() },
      bounded([
        `Made the ${what} link for ${name}, open until ${expiresAt.toISOString().slice(0, 10)}:`,
        url ?? `  <the app's own address>${path}  (this worker was not told the app's address — WEB_PUBLIC_URL — so put the site's address in front)`,
        ...(input.kind === 'preview' && !isNoSiteDomain(company.domain)
          ? [`  ${name} has a website of its own (${company.domain}), so present this as a fresh design, not a first website.`]
          : []),
        'Nothing was sent. Give the link to the person to paste into a message they write, or say that Draft email on ' +
          `the company page drafts one, which waits on /approvals. Anyone with the link can open it; revoke it on the company page if it goes astray. ` +
          'The first time the business reads it, the person you are helping gets a task to call them.',
      ]),
    )
  },
}
