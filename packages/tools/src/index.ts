/**
 * The agency's own tools — how the agent reaches the CRM (PROMPT.md §6).
 *
 * Exported as plain data. `apps/agent/src/mcp/agency.ts` is the only file that
 * knows about the Agent SDK; see spec.ts for why that split exists.
 */
export * from './spec.js'
export { getIcp, searchCompanies, getCompany } from './read.js'
export { scanCompany, scoreCompanyTool, queueTouch } from './write.js'
export { getPipeline, updateDeal, bookMeeting } from './pipeline.js'
export { checkSend, getConsent } from './consent.js'
export { getScanHistory, getEvidenceChanges, getStaleCompanies } from './evidence.js'
export { getReplies, classifyReply } from './replies.js'
export { getPipelineMetrics, getCompanyTimeline, getComplianceSummary, searchCrm } from './reporting.js'
export { addNote, createTask, listTasks } from './tasks.js'
export { listContacts, addCompany, updateCompany, importCompanies, addContact, updateContact, pauseContact, resumeContact, addSuppression } from './records.js'
export { listCampaigns, createCampaign, updateCampaign, enrolContacts, listDrafts, getDraft, editDraftTool } from './campaigns.js'
export { generateProposalTool, getProposal, listMeetings, rescheduleMeetingTool, cancelMeetingTool, recordMeetingOutcome, setDealOwnerTool, completeTask } from './proposals.js'
export { workerStatus, recentErrors, queueStatus, rescanStale } from './ops.js'
export { listIcps, createIcp, activateIcp } from './profiles.js'

import { AGENCY_TOOL_NAMES } from '@agency/core'
import type { AgencyToolSpec } from './spec.js'
import { getCompany, getIcp, searchCompanies } from './read.js'
import { queueTouch, scanCompany, scoreCompanyTool } from './write.js'
import { getPipeline, updateDeal, bookMeeting } from './pipeline.js'
import { checkSend, getConsent } from './consent.js'
import { getScanHistory, getEvidenceChanges, getStaleCompanies } from './evidence.js'
import { getReplies, classifyReply } from './replies.js'
import { getPipelineMetrics, getCompanyTimeline, getComplianceSummary, searchCrm } from './reporting.js'
import { addNote, createTask, listTasks } from './tasks.js'
import { listContacts, addCompany, updateCompany, importCompanies, addContact, updateContact, pauseContact, resumeContact, addSuppression } from './records.js'
import { listCampaigns, createCampaign, updateCampaign, enrolContacts, listDrafts, getDraft, editDraftTool } from './campaigns.js'
import { generateProposalTool, getProposal, listMeetings, rescheduleMeetingTool, cancelMeetingTool, recordMeetingOutcome, setDealOwnerTool, completeTask } from './proposals.js'
import { workerStatus, recentErrors, queueStatus, rescanStale } from './ops.js'
import { listIcps, createIcp, activateIcp } from './profiles.js'

/**
 * Every tool the `agency` MCP server exposes.
 *
 * `tools.test.ts` asserts this list is exactly the keys of
 * `AGENCY_TOOL_RISK`, in both directions: a tool with no risk classification
 * cannot be reachable, and a classified tool with no implementation is a
 * registry entry that lies about what exists. The wave-1 stubs answer
 * `invalid_state` until their owners replace them, which keeps both
 * directions true from the day the registry names them.
 */
// Typed through `unknown`: each spec has its own zod shape, so the array's
// element type is a union no single AgencyToolSpec<S> instantiation matches.
// The adapter narrows per tool; tools.test.ts checks the list is complete.
export const AGENCY_TOOLS: readonly AgencyToolSpec[] = [
  getIcp,
  searchCompanies,
  getCompany,
  scanCompany,
  scoreCompanyTool,
  queueTouch,
  getPipeline,
  updateDeal,
  bookMeeting,
  checkSend,
  getConsent,
  getReplies,
  classifyReply,
  getScanHistory,
  getEvidenceChanges,
  getStaleCompanies,
  getPipelineMetrics,
  getCompanyTimeline,
  getComplianceSummary,
  searchCrm,
  addNote,
  createTask,
  listTasks,
  listContacts,
  addCompany,
  updateCompany,
  importCompanies,
  addContact,
  updateContact,
  pauseContact,
  resumeContact,
  addSuppression,
  listCampaigns,
  createCampaign,
  updateCampaign,
  enrolContacts,
  listDrafts,
  getDraft,
  editDraftTool,
  generateProposalTool,
  getProposal,
  listMeetings,
  rescheduleMeetingTool,
  cancelMeetingTool,
  recordMeetingOutcome,
  setDealOwnerTool,
  completeTask,
  workerStatus,
  recentErrors,
  queueStatus,
  rescanStale,
  listIcps,
  createIcp,
  activateIcp,
] as unknown as readonly AgencyToolSpec[]

export { AGENCY_TOOL_NAMES }
