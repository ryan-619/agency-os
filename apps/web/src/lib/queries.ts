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

export function scanWithFindings(orgId: string, companyId: string) {
  return latestScanWithFindings(db(), orgId, companyId)
}

export function scoreFor(orgId: string, companyId: string) {
  return latestScore(db(), orgId, companyId)
}

export { schema }
