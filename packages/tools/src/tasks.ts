// STUB — filled in wave 3 by reporting-and-task-tools
/**
 * The notes and tasks tools (0018's two tables).
 *
 * `add_note` and `create_task` write internal state (`medium`); `list_tasks`
 * is a READ (`low`). A note is a teammate's words and is never evidence —
 * nothing that writes a proposal or a brief may read it. A task is a thing
 * for a person to do; creating one sends nothing to anybody. Every write's
 * summary ends "Nothing was sent." The shapes below are final; the owner
 * above fills in the handlers and keeps them.
 */
import { z } from 'zod'
import { fail, type AgencyToolSpec, type ToolOutcome } from './spec.js'

const NOT_YET = 'This tool is not available in this revision.'

const addNoteShape = {
  domain: z.string().min(1).max(253).describe('The company the note is about.'),
  body: z.string().min(1).max(4000).describe('The note, in the person’s own words.'),
  contactEmail: z.email().optional().describe('A person at the company the note is about, if one.'),
}

export const addNote: AgencyToolSpec<typeof addNoteShape> = {
  name: 'add_note',
  description:
    'Write a note on a company, optionally about one of its contacts, as the person you are helping ' +
    'would. A note is what somebody thinks; it is never evidence, and no proposal or brief reads it. ' +
    'It changes the CRM only — nothing leaves the building and nothing is sent.',
  shape: addNoteShape,
  handler: async (): Promise<ToolOutcome<unknown>> => fail('invalid_state', NOT_YET),
}

const createTaskShape = {
  domain: z.string().optional().describe('The company the task is about, if one.'),
  title: z.string().min(1).max(200).describe('What needs doing, in one line.'),
  detail: z.string().max(2000).optional().describe('Anything the person doing it needs to know.'),
  dueAt: z.iso.datetime().optional().describe('When it is due, as an ISO 8601 instant.'),
  assigneeEmail: z.email().optional().describe('The teammate to assign it to, by their sign-in address.'),
}

export const createTask: AgencyToolSpec<typeof createTaskShape> = {
  name: 'create_task',
  description:
    'Create a task for a teammate — optionally about a company, with a due date and an assignee. It ' +
    'appears on their task list and nowhere else: no email, no message, no calendar event. Nothing is ' +
    'sent to anyone inside or outside the company.',
  shape: createTaskShape,
  handler: async (): Promise<ToolOutcome<unknown>> => fail('invalid_state', NOT_YET),
}

const listTasksShape = {
  open: z.boolean().optional().describe('Only tasks not yet done. Default true.'),
  assigneeEmail: z.email().optional().describe('Only one teammate’s tasks.'),
  domain: z.string().optional().describe('Only tasks about one company.'),
  limit: z.number().int().min(1).max(100).optional().describe('How many, soonest due first. Default 50.'),
}

export const listTasks: AgencyToolSpec<typeof listTasksShape> = {
  name: 'list_tasks',
  description:
    'Read the task list: open tasks by default, soonest due first, with their company, assignee and ' +
    'due date — optionally one teammate’s or one company’s, or including done ones. A read; it ' +
    'changes nothing and sends nothing.',
  shape: listTasksShape,
  handler: async (): Promise<ToolOutcome<unknown>> => fail('invalid_state', NOT_YET),
}
