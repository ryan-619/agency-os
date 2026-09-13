import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { freshDb, migrations, expectRejection, type TestDb } from './helpers.js'
import { migrateUp } from '../src/migrator.js'

/**
 * PROMPT.md §2 calls its constraints "not preferences" — violating them
 * "creates legal exposure or destroys the product's value".
 *
 * Rules that can be expressed in the schema are expressed in the schema, so
 * that a bug in application code cannot produce a row that breaks them. These
 * tests assert the DATABASE rejects the bad row, not that some function does.
 *
 * The rules that cannot live in the schema — the ordered send path, quiet
 * hours in the recipient's timezone, the approval gate — land in
 * packages/core in Phases 2 and 4 with their own tests.
 */
describe('§2 invariants are enforced by the schema', () => {
  let db: TestDb
  let orgId: string
  let companyId: string
  let contactId: string
  let scanId: string

  beforeAll(async () => {
    db = await freshDb()
    await migrateUp(db.driver, migrations())
    ;[{ id: orgId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ('Test Agency') RETURNING id`,
    )
    ;[{ id: companyId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO companies (org_id, domain, name) VALUES ($1, 'example.com', 'Example') RETURNING id`,
      [orgId],
    )
    ;[{ id: contactId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO contacts (org_id, company_id, email) VALUES ($1, $2, 'a@example.com') RETURNING id`,
      [orgId, companyId],
    )
    ;[{ id: scanId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO scans (org_id, company_id, ok) VALUES ($1, $2, true) RETURNING id`,
      [orgId, companyId],
    )
  })
  afterAll(async () => { await db.close() })

  // -------------------------------------------------------------------------
  // §2.2 Evidence integrity
  // -------------------------------------------------------------------------
  describe('§2.2 evidence integrity', () => {
    it('accepts an observed finding that IS a gap, when it carries its evidence', async () => {
      const rows = await db.driver.select<{ id: string }>(
        `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight, evidence)
         VALUES ($1, $2, $3, 'csp', true, true, 15,
                 '{"url":"https://example.com/","header":"content-security-policy","seen":"absent"}'::jsonb)
         RETURNING id`,
        [orgId, scanId, companyId],
      )
      expect(rows).toHaveLength(1)
    })

    it('accepts an observed finding that is NOT a gap', async () => {
      const rows = await db.driver.select<{ id: string }>(
        `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight)
         VALUES ($1, $2, $3, 'hsts', true, false, 10) RETURNING id`,
        [orgId, scanId, companyId],
      )
      expect(rows).toHaveLength(1)
    })

    it('accepts an UNOBSERVED finding only when it claims nothing', async () => {
      const rows = await db.driver.select<{ id: string }>(
        `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight)
         VALUES ($1, $2, $3, 'tls', false, NULL, 0) RETURNING id`,
        [orgId, scanId, companyId],
      )
      expect(rows).toHaveLength(1)
    })

    // The rule the whole product's credibility rests on: a fetch failure,
    // timeout, WAF block or CDN quirk must never become "they are missing X".
    it('REFUSES an unobserved finding that claims a gap', async () => {
      // Evidence is supplied so that findings_a_claimed_gap_carries_evidence is
      // satisfied and the observed/gap constraint is the one under test.
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight, evidence)
           VALUES ($1, $2, $3, 'server_banner', false, true, 7, '{"seen":"something"}'::jsonb)`,
          [orgId, scanId, companyId],
        ),
      )
      expect(msg).toContain('findings_unobserved_has_no_gap')
    })

    it('REFUSES an unobserved finding that claims the absence of a gap', async () => {
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight)
           VALUES ($1, $2, $3, 'referrer_policy', false, false, 4)`,
          [orgId, scanId, companyId],
        ),
      )
      expect(msg).toContain('findings_unobserved_has_no_gap')
    })

    it('REFUSES an observed finding that says nothing either way', async () => {
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight)
           VALUES ($1, $2, $3, 'permissions_policy', true, NULL, 3)`,
          [orgId, scanId, companyId],
        ),
      )
      expect(msg).toContain('findings_unobserved_has_no_gap')
    })

    // The CHECK above only makes `observed` and `gap` agree with each other.
    // These three cover the gap that actually mattered: a finding that agrees
    // with itself but is still a fabrication.
    it('REFUSES a finding that claims to have observed something on a FAILED scan', async () => {
      const [failed] = await db.driver.select<{ id: string }>(
        `INSERT INTO scans (org_id, company_id, ok, error) VALUES ($1, $2, false, 'ETIMEDOUT')
         RETURNING id`,
        [orgId, companyId],
      )
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight, evidence)
           VALUES ($1, $2, $3, 'csp', true, true, 15, '{"header":"absent"}'::jsonb)`,
          [orgId, failed.id, companyId],
        ),
      )
      expect(msg).toContain('findings_observed_requires_a_successful_scan')
    })

    it('allows an UNOBSERVED finding on a failed scan — that row claims nothing', async () => {
      const [failed] = await db.driver.select<{ id: string }>(
        `INSERT INTO scans (org_id, company_id, ok, error) VALUES ($1, $2, false, 'WAF block')
         RETURNING id`,
        [orgId, companyId],
      )
      const rows = await db.driver.select(
        `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight)
         VALUES ($1, $2, $3, 'csp', false, NULL, 0) RETURNING id`,
        [orgId, failed.id, companyId],
      )
      expect(rows).toHaveLength(1)
    })

    it('REFUSES an honest row being UPDATED into a dishonest one', async () => {
      const [failed] = await db.driver.select<{ id: string }>(
        `INSERT INTO scans (org_id, company_id, ok, error) VALUES ($1, $2, false, 'ETIMEDOUT')
         RETURNING id`,
        [orgId, companyId],
      )
      await db.driver.select(
        `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight)
         VALUES ($1, $2, $3, 'hsts', false, NULL, 0)`,
        [orgId, failed.id, companyId],
      )
      const msg = await expectRejection(() =>
        db.driver.select(
          `UPDATE findings SET observed = true, gap = true, evidence = '{"x":1}'::jsonb
           WHERE scan_id = $1 AND signal_key = 'hsts'`,
          [failed.id],
        ),
      )
      expect(msg).toContain('findings_observed_requires_a_successful_scan')
    })

    // §2.2: "Findings carry the raw evidence that produced them."
    it('REFUSES a claimed gap with an empty evidence object', async () => {
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight, evidence)
           VALUES ($1, $2, $3, 'frame_protection', true, true, 8, '{}'::jsonb)`,
          [orgId, scanId, companyId],
        ),
      )
      expect(msg).toContain('findings_a_claimed_gap_carries_evidence')
    })

    it('allows a NON-gap with no evidence — nothing is being claimed', async () => {
      const rows = await db.driver.select(
        `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight, evidence)
         VALUES ($1, $2, $3, 'content_type_options', true, false, 5, '{}'::jsonb) RETURNING id`,
        [orgId, scanId, companyId],
      )
      expect(rows).toHaveLength(1)
    })

    // The denormalised company_id is what the UI reads; if it can disagree with
    // the scan, the app can show one company's evidence under another's name.
    it('REFUSES a finding filed against a company its scan never touched', async () => {
      const [other] = await db.driver.select<{ id: string }>(
        `INSERT INTO companies (org_id, domain) VALUES ($1, 'not-scanned.test') RETURNING id`,
        [orgId],
      )
      // A signal not already recorded on this scan, so the composite foreign
      // key is what rejects the row rather than the per-signal unique index.
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight, evidence)
           VALUES ($1, $2, $3, 'permissions_policy', true, true, 3, '{"header":"absent"}'::jsonb)`,
          [orgId, scanId, other.id],
        ),
      )
      expect(msg).toMatch(/findings_scan_matches_company_and_org|foreign key/i)
    })

    // Guarding only `findings` left the forbidden state reachable in two
    // statements: write honest findings, then demote the scan under them.
    it('REFUSES to demote a scan that already has observed findings', async () => {
      const [good] = await db.driver.select<{ id: string }>(
        `INSERT INTO scans (org_id, company_id, ok) VALUES ($1, $2, true) RETURNING id`,
        [orgId, companyId],
      )
      await db.driver.select(
        `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight, evidence)
         VALUES ($1, $2, $3, 'hsts', true, true, 10, '{"header":"absent"}'::jsonb)`,
        [orgId, good.id, companyId],
      )
      const msg = await expectRejection(() =>
        db.driver.select(`UPDATE scans SET ok = false WHERE id = $1`, [good.id]),
      )
      expect(msg).toContain('scans_cannot_be_demoted_with_observations')
    })

    it('allows demoting a scan that observed nothing', async () => {
      const [empty] = await db.driver.select<{ id: string }>(
        `INSERT INTO scans (org_id, company_id, ok) VALUES ($1, $2, true) RETURNING id`,
        [orgId, companyId],
      )
      await db.driver.select(`UPDATE scans SET ok = false, error = 'retro' WHERE id = $1`, [empty.id])
      const [row] = await db.driver.select<{ ok: boolean }>(
        `SELECT ok FROM scans WHERE id = $1`, [empty.id],
      )
      expect(row.ok).toBe(false)
    })

    // Phase 1's staleness sweep must be able to write to honest findings.
    it('lets an ordinary update through — the guard is not a freeze', async () => {
      const [good] = await db.driver.select<{ id: string }>(
        `INSERT INTO scans (org_id, company_id, ok) VALUES ($1, $2, true) RETURNING id`,
        [orgId, companyId],
      )
      await db.driver.select(
        `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight, evidence)
         VALUES ($1, $2, $3, 'tls', true, true, 8, '{"protocol":"TLSv1.2"}'::jsonb)`,
        [orgId, good.id, companyId],
      )
      await db.driver.select(`UPDATE findings SET stale = true WHERE scan_id = $1`, [good.id])
      const [row] = await db.driver.select<{ stale: boolean }>(
        `SELECT stale FROM findings WHERE scan_id = $1`, [good.id],
      )
      expect(row.stale).toBe(true)
    })

    // '{}' is not the only way to carry no evidence.
    it('REFUSES a claimed gap whose evidence is null, an array or a string', async () => {
      for (const empty of ["'null'::jsonb", "'[]'::jsonb", `'""'::jsonb`, "'[1,2]'::jsonb"]) {
        const msg = await expectRejection(() =>
          db.driver.select(
            `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight, evidence)
             VALUES ($1, $2, $3, 'referrer_policy', true, true, 4, ${empty})`,
            [orgId, scanId, companyId],
          ),
        )
        expect(msg, `evidence ${empty} should be rejected`)
          .toContain('findings_a_claimed_gap_carries_evidence')
      }
    })

    it('allows only one finding per signal per scan', async () => {
      // 'csp' was already recorded for this scan by the first test above.
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight)
           VALUES ($1, $2, $3, 'csp', true, false, 15)`,
          [orgId, scanId, companyId],
        ),
      )
      expect(msg).toMatch(/findings_scan_signal_key|duplicate key/)
    })
  })

  // -------------------------------------------------------------------------
  // §2.1 Outreach compliance
  // -------------------------------------------------------------------------
  describe('§2.1 outreach compliance', () => {
    it('stores sms and voice consent as separate rows so one cannot imply the other', async () => {
      await db.driver.select(
        `INSERT INTO consents (org_id, contact_id, channel, granted, source)
         VALUES ($1, $2, 'email', true, 'inbound form')`,
        [orgId, contactId],
      )
      const rows = await db.driver.select<{ channel: string }>(
        `SELECT channel FROM consents WHERE contact_id = $1`,
        [contactId],
      )
      // Email consent recorded; sms and voice remain absent, and absence means NO.
      expect(rows.map((r) => r.channel)).toEqual(['email'])
    })

    it('permits at most one consent row per channel per contact', async () => {
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO consents (org_id, contact_id, channel, granted, source)
           VALUES ($1, $2, 'email', false, 'contradictory second row')`,
          [orgId, contactId],
        ),
      )
      expect(msg).toMatch(/consents_contact_channel_key|duplicate key/)
    })

    it('rejects a consent channel outside the four the system knows', async () => {
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO consents (org_id, contact_id, channel, granted, source)
           VALUES ($1, $2, 'carrier pigeon', true, 'x')`,
          [orgId, contactId],
        ),
      )
      expect(msg).toMatch(/consents_channel_check|violates check constraint/)
    })

    it('requires a source on every consent row — a grant with no provenance is not evidence', async () => {
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO consents (org_id, contact_id, channel, granted, source)
           VALUES ($1, $2, 'sms', true, NULL)`,
          [orgId, contactId],
        ),
      )
      expect(msg).toMatch(/source/)
    })

    it('keeps suppressions unique per org, kind and value so the send-path lookup is exact', async () => {
      await db.driver.select(
        `INSERT INTO suppressions (org_id, kind, value, reason)
         VALUES ($1, 'email', 'stop@example.com', 'unsubscribed')`,
        [orgId],
      )
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO suppressions (org_id, kind, value, reason)
           VALUES ($1, 'email', 'stop@example.com', 'again')`,
          [orgId],
        ),
      )
      expect(msg).toMatch(/suppressions_org_kind_value_key|duplicate key/)
    })

    // The send path does one indexed equality lookup, so an unnormalised value
    // is a value that is no longer suppressed.
    it('REFUSES a suppression stored in mixed case, which would defeat the lookup', async () => {
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO suppressions (org_id, kind, value, reason)
           VALUES ($1, 'email', 'Unsub@Example.com', 'unsubscribed')`,
          [orgId],
        ),
      )
      expect(msg).toContain('suppressions_value_is_normalised')
    })

    it('REFUSES a suppression with untrimmed whitespace', async () => {
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO suppressions (org_id, kind, value, reason)
           VALUES ($1, 'email', ' spaced@example.com ', 'unsubscribed')`,
          [orgId],
        ),
      )
      expect(msg).toContain('suppressions_value_is_normalised')
    })

    /**
     * The constraint must not strand a real opt-out. A suppression insert that
     * fails is an opt-out that was never recorded, which is far worse than the
     * case-sensitivity bug this replaced — so every geo the seeded ICP targets
     * is checked here explicitly.
     */
    it('accepts real numbers from every geo in the seeded ICP (§11)', async () => {
      const numbers: Array<[string, string]> = [
        ['US', '+14155550100'], ['CA', '+14165550100'],
        ['UK mobile', '+447911123456'], ['UK landline', '+442071234567'],
        ['DE mobile', '+4915112345678'], ['DE landline', '+493012345678'],
        ['NL', '+31612345678'], ['SE', '+46701234567'], ['IE', '+353851234567'],
        ['FR', '+33612345678'], ['ES', '+34612345678'], ['PT', '+351912345678'],
        ['PL', '+48512345678'],
        ['shortest valid E.164', '+1234567'], ['longest valid E.164', '+123456789012345'],
      ]
      for (const [geo, number] of numbers) {
        const rows = await db.driver.select(
          `INSERT INTO suppressions (org_id, kind, value, reason) VALUES ($1, 'phone', $2, 'opt-out')
           RETURNING id`,
          [orgId, number],
        )
        expect(rows, `${geo} (${number}) must be storable`).toHaveLength(1)
      }
    })

    it('REFUSES a phone number that is not in E.164', async () => {
      for (const bad of ['+1 (415) 555-0100', '4155550100', '+0155550100', '+1-415-555-0100']) {
        const msg = await expectRejection(() =>
          db.driver.select(
            `INSERT INTO suppressions (org_id, kind, value, reason) VALUES ($1, 'phone', $2, 'opt-out')`,
            [orgId, bad],
          ),
        )
        expect(msg, `"${bad}" should be rejected`).toContain('suppressions_value_is_normalised')
      }
    })

    it('accepts the normalised forms', async () => {
      // A number not used by the per-geo test above, which shares this org.
      const ok = await db.driver.select(
        `INSERT INTO suppressions (org_id, kind, value, reason)
         VALUES ($1, 'phone', '+14155559999', 'opt-out') RETURNING id`,
        [orgId],
      )
      expect(ok).toHaveLength(1)
      const ok2 = await db.driver.select(
        `INSERT INTO suppressions (org_id, kind, value, reason)
         VALUES ($1, 'domain', 'example.com', 'competitor') RETURNING id`,
        [orgId],
      )
      expect(ok2).toHaveLength(1)
    })

    it('REFUSES a granted consent whose source is an empty string', async () => {
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO consents (org_id, contact_id, channel, granted, source)
           VALUES ($1, $2, 'voice', true, '   ')`,
          [orgId, contactId],
        ),
      )
      expect(msg).toContain('consents_source_is_not_blank')
    })

    it('suppresses by email, domain or phone — and nothing else', async () => {
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO suppressions (org_id, kind, value, reason)
           VALUES ($1, 'linkedin', 'someone', 'x')`,
          [orgId],
        ),
      )
      expect(msg).toMatch(/suppressions_kind_check|violates check constraint/)
    })

    // §2.1 / §12: cold outreach is email and LinkedIn only. A campaign that
    // sends without a per-message human decision cannot exist on a voice or
    // SMS channel at all.
    it('REFUSES a campaign with auto-send enabled on a voice channel', async () => {
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO campaigns (org_id, name, channel, auto_send)
           VALUES ($1, 'cold calls', 'voice', true)`,
          [orgId],
        ),
      )
      expect(msg).toContain('campaigns_no_auto_send_on_voice_or_sms')
    })

    it('REFUSES a campaign with auto-send enabled on an SMS channel', async () => {
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO campaigns (org_id, name, channel, auto_send)
           VALUES ($1, 'cold texts', 'sms', true)`,
          [orgId],
        ),
      )
      expect(msg).toContain('campaigns_no_auto_send_on_voice_or_sms')
    })

    it('allows a voice campaign only with auto-send off, so every dial needs a human', async () => {
      const rows = await db.driver.select<{ auto_send: boolean }>(
        `INSERT INTO campaigns (org_id, name, channel, auto_send)
         VALUES ($1, 'inbound follow-up', 'voice', false) RETURNING auto_send`,
        [orgId],
      )
      expect(rows[0].auto_send).toBe(false)
    })

    it('defaults auto_send to off and the daily cap to 25 (§11)', async () => {
      const rows = await db.driver.select<{ auto_send: boolean; daily_cap: number }>(
        `INSERT INTO campaigns (org_id, name, channel) VALUES ($1, 'defaults', 'email')
         RETURNING auto_send, daily_cap`,
        [orgId],
      )
      expect(rows[0].auto_send).toBe(false)
      expect(Number(rows[0].daily_cap)).toBe(25)
    })
  })

  // -------------------------------------------------------------------------
  // §2.4 Irreversible actions need a human
  // -------------------------------------------------------------------------
  describe('§2.4 the approval gate', () => {
    /**
     * An approval the AGENT raised has to name the tool call it gates — the
     * chat thread, the turn, the SDK's tool_use_id and a hash of the payload
     * the human was shown (0007). Every test below therefore builds a
     * traceable row; a row without those columns is not a gate, it is a note,
     * and the constraint at the end of this block proves the database says so.
     */
    // Both unique indexes are org-scoped and these tests share one org, so
    // every call gets its own turn, tool_use_id and payload hash. A test that
    // wants a COLLISION asks for it explicitly by reusing the returned object.
    let gateSeq = 0
    const traceable = async () => {
      const n = ++gateSeq
      const [user] = await db.driver.select<{ id: string }>(
        `INSERT INTO users (org_id, email, role) VALUES ($1, $2, 'owner') RETURNING id`,
        [orgId, `gate-${n}@example.com`],
      )
      const [session] = await db.driver.select<{ id: string }>(
        `INSERT INTO chat_sessions (org_id, user_id) VALUES ($1, $2) RETURNING id`,
        [orgId, user!.id],
      )
      return {
        userId: user!.id,
        sessionId: session!.id,
        turnId: `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`,
        toolUseId: `toolu_${n}`,
        payloadSha256: String(n).padStart(64, '0'),
      }
    }

    const insertAgentApproval = (
      t: { sessionId: string; turnId: string; toolUseId: string; payloadSha256: string },
      columns: string,
      values: string,
      params: readonly unknown[] = [],
    ) =>
      db.driver.select<{ status: string }>(
        `INSERT INTO approvals (org_id, requested_by, tool_name, risk, expires_at,
                                chat_session_id, turn_id, tool_use_id, payload_sha256${columns})
         VALUES ($1, 'agent', 'send_email', 'high', now() + interval '30 minutes',
                 $2, $3, $4, $5${values})
         RETURNING status`,
        [orgId, t.sessionId, t.turnId, t.toolUseId, t.payloadSha256, ...params],
      )

    it('REFUSES to mark an approval approved without naming who approved it', async () => {
      const t = await traceable()
      const msg = await expectRejection(() =>
        insertAgentApproval(t, ', status', `, 'approved'`),
      )
      expect(msg).toContain('approvals_decided_has_decider')
    })

    it('accepts an approval decided by a real user', async () => {
      const t = await traceable()
      const rows = await insertAgentApproval(
        t,
        ', status, decided_by, decided_at',
        `, 'approved', $6, now()`,
        [t.userId],
      )
      expect(rows[0]!.status).toBe('approved')
    })

    it('leaves a pending approval undecided without complaint', async () => {
      const t = await traceable()
      const rows = await insertAgentApproval(t, '', '')
      expect(rows[0]!.status).toBe('pending')
    })

    it('rejects a risk level outside low / medium / high', async () => {
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO approvals (org_id, requested_by, tool_name, risk, expires_at)
           VALUES ($1, 'human', 'x', 'catastrophic', now())`,
          [orgId],
        ),
      )
      expect(msg).toMatch(/approvals_risk_check|violates check constraint/)
    })

    // --- what 0007 added ---------------------------------------------------

    it('REFUSES an agent approval that does not name the tool call it gates', async () => {
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO approvals (org_id, requested_by, tool_name, risk, expires_at)
           VALUES ($1, 'agent', 'send_email', 'high', now() + interval '30 minutes')`,
          [orgId],
        ),
      )
      expect(msg).toContain('approvals_agent_request_is_traceable')
    })

    /**
     * The SDK redelivers a pending permission request after a transport gap —
     * its own doc says callbacks must be idempotent because "a request whose
     * response was lost in the gap will be dispatched again". Two rows would
     * mean two cards and two humans for one action.
     */
    it('REFUSES a second approval for the same tool_use_id', async () => {
      const t = await traceable()
      await insertAgentApproval(t, '', '')
      const msg = await expectRejection(() => insertAgentApproval(t, '', ''))
      expect(msg).toMatch(/approvals_org_tool_use_key|approvals_org_turn_payload_key/)
    })

    /**
     * And a call the SDK denied-and-retried arrives with a NEW tool_use_id, so
     * the key above misses it. The payload hash, scoped to the turn, catches
     * the same human intent asked twice.
     */
    it('REFUSES a retry of the same call under a new tool_use_id', async () => {
      const t = await traceable()
      await insertAgentApproval(t, '', '')
      const retry = { ...t, toolUseId: 'toolu_02_retry' }
      const msg = await expectRejection(() => insertAgentApproval(retry, '', ''))
      expect(msg).toContain('approvals_org_turn_payload_key')
    })

    it('REFUSES an expired approval that names a decider — expiry is a lapse, not an answer', async () => {
      const t = await traceable()
      const msg = await expectRejection(() =>
        insertAgentApproval(
          t,
          ', status, decided_by, decided_at',
          `, 'expired', $6, now()`,
          [t.userId],
        ),
      )
      expect(msg).toContain('approvals_expired_has_no_decider')
    })

    it('REFUSES a reason on a row nobody has decided', async () => {
      const t = await traceable()
      const msg = await expectRejection(() =>
        insertAgentApproval(t, ', decided_reason', `, 'looks fine to me'`),
      )
      expect(msg).toContain('approvals_reason_belongs_to_a_decision')
    })
  })

  /**
   * §2.4: "Approval decides; the audit log remembers." A memory that can be
   * edited is not one. audit_log is the only table with an updated_at and no
   * set_updated_at trigger — which looks like an oversight and invites a fix,
   * so 0007 makes the append-only rule explicit and enforced.
   */
  describe('the audit log cannot be rewritten', () => {
    it('REFUSES an UPDATE', async () => {
      const [row] = await db.driver.select<{ id: string }>(
        `INSERT INTO audit_log (org_id, actor, action) VALUES ($1, 'agent', 'agent.tool_pre') RETURNING id`,
        [orgId],
      )
      const msg = await expectRejection(() =>
        db.driver.select(`UPDATE audit_log SET action = 'nothing.happened' WHERE id = $1`, [row!.id]),
      )
      expect(msg).toContain('append-only')
    })

    it('still permits a DELETE, so deleting an org does not fail', async () => {
      const [row] = await db.driver.select<{ id: string }>(
        `INSERT INTO audit_log (org_id, actor, action) VALUES ($1, 'agent', 'agent.tool_post') RETURNING id`,
        [orgId],
      )
      await db.driver.select(`DELETE FROM audit_log WHERE id = $1`, [row!.id])
      const left = await db.driver.select(`SELECT id FROM audit_log WHERE id = $1`, [row!.id])
      expect(left).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // §6 connector registry
  // -------------------------------------------------------------------------
  describe('§6 connector registry', () => {
    it('rejects a connector name that would break the mcp__server__tool namespace', async () => {
      for (const bad of ['Has Spaces', 'UPPER', 'under_score', '-leading']) {
        const msg = await expectRejection(() =>
          db.driver.select(
            `INSERT INTO connectors (org_id, name, kind) VALUES ($1, $2, 'stdio')`,
            [orgId, bad],
          ),
        )
        expect(msg, `"${bad}" should be rejected`).toMatch(
          /connectors_name_is_a_valid_mcp_server_name|violates check constraint/,
        )
      }
    })

    it('accepts a kebab-case connector name and defaults it to disabled', async () => {
      const rows = await db.driver.select<{ enabled: boolean }>(
        `INSERT INTO connectors (org_id, name, kind) VALUES ($1, 'google-calendar', 'http')
         RETURNING enabled`,
        [orgId],
      )
      // A newly added connector is off until someone tests and enables it (§6).
      expect(rows[0].enabled).toBe(false)
    })

    it('rejects a transport the SDK does not support', async () => {
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO connectors (org_id, name, kind) VALUES ($1, 'websocket-thing', 'ws')`,
          [orgId],
        ),
      )
      expect(msg).toMatch(/connectors_kind_check|violates check constraint/)
    })
  })

  // -------------------------------------------------------------------------
  // Deletion behaviour — what survives, and what must not
  // -------------------------------------------------------------------------
  describe('deleting a contact', () => {
    let localOrg: string
    let localCompany: string
    let localContact: string

    beforeAll(async () => {
      ;[{ id: localOrg }] = await db.driver.select<{ id: string }>(
        `INSERT INTO orgs (name) VALUES ('Deletion Test') RETURNING id`,
      )
      ;[{ id: localCompany }] = await db.driver.select<{ id: string }>(
        `INSERT INTO companies (org_id, domain) VALUES ($1, 'deletion.test') RETURNING id`,
        [localOrg],
      )
      ;[{ id: localContact }] = await db.driver.select<{ id: string }>(
        `INSERT INTO contacts (org_id, company_id, email) VALUES ($1, $2, 'gone@deletion.test') RETURNING id`,
        [localOrg, localCompany],
      )
      const [{ id: campaign }] = await db.driver.select<{ id: string }>(
        `INSERT INTO campaigns (org_id, name, channel) VALUES ($1, 'deletion', 'email') RETURNING id`,
        [localOrg],
      )
      await db.driver.select(
        `INSERT INTO touches (org_id, campaign_id, contact_id, channel, direction, status, subject, sent_at)
         VALUES ($1, $2, $3, 'email', 'out', 'sent', 'we emailed you', now())`,
        [localOrg, campaign, localContact],
      )
      await db.driver.select(
        `INSERT INTO consents (org_id, contact_id, channel, granted, source)
         VALUES ($1, $2, 'email', true, 'inbound form')`,
        [localOrg, localContact],
      )
      await db.driver.select(`DELETE FROM contacts WHERE id = $1`, [localContact])
    })

    // §4 calls touches "the single log of every message in either direction".
    // Deleting a person must not erase the record of what was sent to them —
    // that record is what answers a complaint.
    it('KEEPS the message in the touch log, with the contact link cleared', async () => {
      const rows = await db.driver.select<{ subject: string; contact_id: string | null }>(
        `SELECT subject, contact_id FROM touches WHERE org_id = $1`,
        [localOrg],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].subject).toBe('we emailed you')
      expect(rows[0].contact_id).toBeNull()
    })

    // Consent is meaningful only in relation to a contact, and the send path
    // looks it up by contact. A re-imported contact must start from NO.
    it('REMOVES the consent row, so a re-imported contact starts from no consent', async () => {
      const rows = await db.driver.select(`SELECT id FROM consents WHERE org_id = $1`, [localOrg])
      expect(rows).toEqual([])

      const [{ id: reimported }] = await db.driver.select<{ id: string }>(
        `INSERT INTO contacts (org_id, company_id, email) VALUES ($1, $2, 'gone@deletion.test') RETURNING id`,
        [localOrg, localCompany],
      )
      const consent = await db.driver.select(
        `SELECT granted FROM consents WHERE contact_id = $1 AND channel = 'email'`,
        [reimported],
      )
      // Absence means NO (§2.1).
      expect(consent).toEqual([])
    })
  })

  describe('deleting a user who has decided an approval', () => {
    it('is REFUSED, so the approval never loses the name of its decider (§2.4)', async () => {
      const [{ id: decider }] = await db.driver.select<{ id: string }>(
        `INSERT INTO users (org_id, email, role) VALUES ($1, 'decider@example.com', 'member') RETURNING id`,
        [orgId],
      )
      // 'human' rather than 'agent': this test is about the decider link, and
      // an agent-raised row would need the whole traceability chain (0007).
      await db.driver.select(
        `INSERT INTO approvals (org_id, requested_by, tool_name, risk, status, decided_by, decided_at, expires_at)
         VALUES ($1, 'human', 'send_email', 'high', 'approved', $2, now(), now() + interval '1 hour')`,
        [orgId, decider],
      )

      const msg = await expectRejection(() =>
        db.driver.select(`DELETE FROM users WHERE id = $1`, [decider]),
      )
      // A foreign-key error naming users/approvals — NOT a confusing check
      // constraint violation, which is what ON DELETE SET NULL produced.
      expect(msg).toMatch(/foreign key|still referenced/i)
      expect(msg).not.toMatch(/approvals_decided_has_decider/)

      const still = await db.driver.select(`SELECT decided_by FROM approvals WHERE decided_by = $1`, [decider])
      expect(still).toHaveLength(1)
    })

    it('still allows deleting a user who has decided nothing', async () => {
      const [{ id: innocent }] = await db.driver.select<{ id: string }>(
        `INSERT INTO users (org_id, email, role) VALUES ($1, 'innocent@example.com', 'member') RETURNING id`,
        [orgId],
      )
      await db.driver.select(`DELETE FROM users WHERE id = $1`, [innocent])
      const gone = await db.driver.select(`SELECT id FROM users WHERE id = $1`, [innocent])
      expect(gone).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // Sign-in depends on the stored address matching what Auth.js looks up
  // -------------------------------------------------------------------------
  describe('users.email is stored normalised', () => {
    it('REFUSES an address with uppercase, which the adapter could never find', async () => {
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO users (org_id, email, role) VALUES ($1, 'Priya@Agency.com', 'member')`,
          [orgId],
        ),
      )
      expect(msg).toContain('users_email_is_normalised')
    })

    it('REFUSES an address with surrounding whitespace', async () => {
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO users (org_id, email, role) VALUES ($1, ' priya@agency.com ', 'member')`,
          [orgId],
        ),
      )
      expect(msg).toContain('users_email_is_normalised')
    })

    it('accepts the normalised form and keeps it unique', async () => {
      const rows = await db.driver.select(
        `INSERT INTO users (org_id, email, role) VALUES ($1, 'priya@agency.com', 'member') RETURNING id`,
        [orgId],
      )
      expect(rows).toHaveLength(1)
      const msg = await expectRejection(() =>
        db.driver.select(
          `INSERT INTO users (org_id, email, role) VALUES ($1, 'priya@agency.com', 'member')`,
          [orgId],
        ),
      )
      expect(msg).toMatch(/users_email_key|duplicate key/)
    })
  })

  // -------------------------------------------------------------------------
  // §4 org scoping
  // -------------------------------------------------------------------------
  describe('§4 org scoping', () => {
    it('scopes company uniqueness to the org rather than globally', async () => {
      const [{ id: otherOrg }] = await db.driver.select<{ id: string }>(
        `INSERT INTO orgs (name) VALUES ('Second Agency') RETURNING id`,
      )
      // The same domain in a different org is fine — this is what org_id buys.
      const rows = await db.driver.select<{ id: string }>(
        `INSERT INTO companies (org_id, domain) VALUES ($1, 'example.com') RETURNING id`,
        [otherOrg],
      )
      expect(rows).toHaveLength(1)

      // ...but a duplicate within one org is not.
      const msg = await expectRejection(() =>
        db.driver.select(`INSERT INTO companies (org_id, domain) VALUES ($1, 'example.com')`, [orgId]),
      )
      expect(msg).toMatch(/companies_org_domain_key|duplicate key/)
    })

    /**
     * 0010. §2.1 evaluates quiet hours in the RECIPIENT's timezone, and until
     * 0010 there was nothing on any row to read. `companies.country` is not
     * it — the United States has six zones and Australia's differ from each
     * other by half an hour.
     */
    describe('a recipient’s timezone (0010)', () => {
      it.each(['Europe/London', 'America/New_York', 'Asia/Kolkata', 'UTC', 'America/Argentina/Salta'])(
        'accepts the IANA zone %j',
        async (zone) => {
          const [{ id }] = await db.driver.select<{ id: string }>(
            `INSERT INTO contacts (org_id, company_id, email, time_zone) VALUES ($1, $2, $3, $4) RETURNING id`,
            [orgId, companyId, `tz-${zone.replace(/\W/g, '')}@example.com`, zone],
          )
          expect(id).toBeTruthy()
        },
      )

      /**
       * The CHECK is loose on purpose — the authoritative zone list lives in
       * the runtime's ICU data and changes with it, so a database that
       * enumerated them would reject a zone that had just been added. It stops
       * the shapes that are obviously not zones, so a country name typed into
       * the field fails where somebody typed it.
       */
      it.each(['United States', 'GMT+5', 'Pacific Time', '', 'Europe London'])(
        'refuses %j, which is not a zone name',
        async (bad) => {
          const msg = await expectRejection(() =>
            db.driver.select(
              `INSERT INTO contacts (org_id, company_id, email, time_zone) VALUES ($1, $2, 'bad-tz@example.com', $3)`,
              [orgId, companyId, bad],
            ),
          )
          expect(msg).toContain('contacts_time_zone_looks_like_iana')
        },
      )

      it('allows null, because not knowing is a refusal the send path makes', async () => {
        const [{ id }] = await db.driver.select<{ id: string }>(
          `INSERT INTO contacts (org_id, company_id, email) VALUES ($1, $2, 'no-tz@example.com') RETURNING id`,
          [orgId, companyId],
        )
        expect(id).toBeTruthy()
      })
    })

    /**
     * 0010. §8.4: "an inbound reply flips the deal to `replied` and pauses the
     * sequence for that contact immediately." A pause with no cause is
     * indistinguishable from a bug and gets cleared by whoever finds it.
     */
    describe('pausing a contact (0010)', () => {
      it('refuses a pause with no reason', async () => {
        const msg = await expectRejection(() =>
          db.driver.select(
            `INSERT INTO contacts (org_id, company_id, email, paused_at)
             VALUES ($1, $2, 'paused@example.com', now())`,
            [orgId, companyId],
          ),
        )
        expect(msg).toContain('contacts_pause_has_a_reason')
      })

      it('refuses a reason with no pause', async () => {
        const msg = await expectRejection(() =>
          db.driver.select(
            `INSERT INTO contacts (org_id, company_id, email, paused_reason)
             VALUES ($1, $2, 'reason@example.com', 'they replied')`,
            [orgId, companyId],
          ),
        )
        expect(msg).toContain('contacts_pause_has_a_reason')
      })

      it('accepts the two together', async () => {
        const [{ id }] = await db.driver.select<{ id: string }>(
          `INSERT INTO contacts (org_id, company_id, email, paused_at, paused_reason)
           VALUES ($1, $2, 'both@example.com', now(), 'replied 2026-09-15') RETURNING id`,
          [orgId, companyId],
        )
        expect(id).toBeTruthy()
      })
    })

    /**
     * 0010. A refusal is the system working, not something going wrong, and it
     * is what somebody reads when they ask why a campaign of 40 sent 12.
     */
    describe('a refused touch (0010)', () => {
      it('must say why it was refused', async () => {
        const msg = await expectRejection(() =>
          db.driver.select(
            `INSERT INTO touches (org_id, company_id, channel, direction, status)
             VALUES ($1, $2, 'email', 'out', 'refused')`,
            [orgId, companyId],
          ),
        )
        expect(msg).toContain('touches_refusal_is_explained')
      })

      it('may not carry a refusal code unless it was refused', async () => {
        const msg = await expectRejection(() =>
          db.driver.select(
            `INSERT INTO touches (org_id, company_id, channel, direction, status, refusal_code)
             VALUES ($1, $2, 'email', 'out', 'queued', 'suppressed')`,
            [orgId, companyId],
          ),
        )
        expect(msg).toContain('touches_refusal_is_explained')
      })

      /**
       * The one that matters. Without it a bug in the sender could write a row
       * that reads as both refused and delivered — and `touches` is the record
       * anyone would consult to find out which.
       */
      it('may never also claim it was sent', async () => {
        const msg = await expectRejection(() =>
          db.driver.select(
            `INSERT INTO touches (org_id, company_id, channel, direction, status, refusal_code, sent_at)
             VALUES ($1, $2, 'email', 'out', 'refused', 'suppressed', now())`,
            [orgId, companyId],
          ),
        )
        expect(msg).toContain('touches_refused_was_not_sent')
      })

      it('records a refusal that names its code and nothing else', async () => {
        const [{ id }] = await db.driver.select<{ id: string }>(
          `INSERT INTO touches (org_id, company_id, channel, direction, status, refusal_code)
           VALUES ($1, $2, 'email', 'out', 'refused', 'quiet_hours') RETURNING id`,
          [orgId, companyId],
        )
        expect(id).toBeTruthy()
      })
    })

    it('cascades a deleted org to its business rows rather than orphaning them', async () => {
      const [{ id: doomed }] = await db.driver.select<{ id: string }>(
        `INSERT INTO orgs (name) VALUES ('Doomed') RETURNING id`,
      )
      await db.driver.select(`INSERT INTO companies (org_id, domain) VALUES ($1, 'doomed.test')`, [doomed])
      await db.driver.select(`DELETE FROM orgs WHERE id = $1`, [doomed])
      const left = await db.driver.select(`SELECT id FROM companies WHERE org_id = $1`, [doomed])
      expect(left).toEqual([])
    })
  })
})
