/**
 * The agency's own tools — how the agent reaches the CRM (PROMPT.md §6).
 *
 * Exported as plain data. `apps/agent/src/mcp/agency.ts` is the only file that
 * knows about the Agent SDK; see spec.ts for why that split exists.
 */
export * from './spec.js'
export { getIcp, searchCompanies, getCompany } from './read.js'
export { scanCompany, scoreCompanyTool, queueTouch } from './write.js'

import { AGENCY_TOOL_NAMES } from '@agency/core'
import type { AgencyToolSpec } from './spec.js'
import { getCompany, getIcp, searchCompanies } from './read.js'
import { queueTouch, scanCompany, scoreCompanyTool } from './write.js'

/**
 * Every tool the `agency` MCP server exposes.
 *
 * `registry.test.ts` asserts this list is exactly the keys of
 * `AGENCY_TOOL_RISK`, in both directions: a tool with no risk classification
 * cannot be reachable, and a classified tool with no implementation is a
 * registry entry that lies about what exists.
 */
// Typed through `unknown`: each spec has its own zod shape, so the array's
// element type is a union no single AgencyToolSpec<S> instantiation matches.
// The adapter narrows per tool; registry.test.ts checks the list is complete.
export const AGENCY_TOOLS: readonly AgencyToolSpec[] = [
  getIcp,
  searchCompanies,
  getCompany,
  scanCompany,
  scoreCompanyTool,
  queueTouch,
] as unknown as readonly AgencyToolSpec[]

export { AGENCY_TOOL_NAMES }
