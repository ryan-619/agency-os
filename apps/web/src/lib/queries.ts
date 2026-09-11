import 'server-only'
import { getDb, schema } from '@/lib/db'
import {
  activeIcpProfile, companyList, findCompanyByDomain,
  latestScanWithFindings, latestScore, type AgencyDb, type CompanyListRow,
} from '@agency/db/repository'

/**
 * The web app's read side. Thin wrappers so a page never assembles a query
 * itself and every one of them is org-scoped.
 */
function db(): AgencyDb {
  return getDb() as unknown as AgencyDb
}

export type { CompanyListRow }

export function listCompaniesForOrg(orgId: string) {
  return companyList(db(), orgId)
}

export function icpForOrg(orgId: string) {
  return activeIcpProfile(db(), orgId)
}

export function companyByDomain(orgId: string, domain: string) {
  return findCompanyByDomain(db(), orgId, domain)
}

/** The latest scan, its findings, and the score computed FROM that scan. */
export function scanWithFindings(orgId: string, companyId: string) {
  return latestScanWithFindings(db(), orgId, companyId)
}

/**
 * The newest score row for a company, whichever scan produced it.
 *
 * Not for rendering beside findings — use `scanWithFindings` there, or the
 * page shows one scan's number above another scan's evidence.
 */
export function scoreFor(orgId: string, companyId: string) {
  return latestScore(db(), orgId, companyId)
}

export { schema }
