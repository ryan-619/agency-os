// STUB — filled in wave 3 by evidence-and-reply-tools
/**
 * The reply tools: reading the inbox, and recording what kind of reply a
 * message was or that a person has dealt with it.
 *
 * `get_replies` is a READ (`low`). `classify_reply` writes internal state
 * (`medium`), and its `kind` enum deliberately has no `opted_out`: that one
 * is decided by a pure function over the person's own words, in
 * `packages/core`, before any model sees the reply (§2.1) — and a tool
 * cannot record it, change it, or take it back. The shapes below are final;
 * the owner above fills in the handlers and keeps them.
 */
import { z } from 'zod'
import { fail, type AgencyToolSpec, type ToolOutcome } from './spec.js'

const NOT_YET = 'This tool is not available in this revision.'

const getRepliesShape = {
  kind: z
    .enum(['opted_out', 'interested', 'not_now', 'wrong_person', 'auto_reply', 'other', 'unclassified'])
    .optional()
    .describe('Only replies of this kind. "unclassified" is a reply nobody has classified yet.'),
  unhandledOnly: z.boolean().optional().describe('Only replies no teammate has dealt with.'),
  sinceDays: z.number().int().min(1).max(90).optional().describe('Only replies from the last N days.'),
  limit: z.number().int().min(1).max(50).optional().describe('How many, newest first. Default 20.'),
}

export const getReplies: AgencyToolSpec<typeof getRepliesShape> = {
  name: 'get_replies',
  description:
    'Read inbound replies, newest first: who wrote, their company, the kind of reply (interested, ' +
    'not now, wrong person, auto-reply, opted out, other, or not yet classified), whether a teammate ' +
    'has handled it, and which outbound message it answered. A read; nothing is sent.',
  shape: getRepliesShape,
  handler: async (): Promise<ToolOutcome<unknown>> => fail('invalid_state', NOT_YET),
}

const classifyReplyShape = {
  touchId: z.uuid().describe('The inbound reply, from get_replies.'),
  /** No `opted_out` here, on purpose: §2.1 keeps that decision out of every model's hands. */
  kind: z
    .enum(['interested', 'not_now', 'wrong_person', 'auto_reply', 'other'])
    .optional()
    .describe('What kind of reply it was.'),
  handled: z.literal(true).optional().describe('Mark it as dealt with by the person you are helping.'),
}

export const classifyReply: AgencyToolSpec<typeof classifyReplyShape> = {
  name: 'classify_reply',
  description:
    'Record what kind of reply an inbound message was, or that the person you are helping has dealt ' +
    'with it. It can never record or remove an opt-out — that is decided from the person’s own words ' +
    'before any model reads them. Changes the inbox only; nothing leaves the building.',
  shape: classifyReplyShape,
  handler: async (): Promise<ToolOutcome<unknown>> => fail('invalid_state', NOT_YET),
}
