import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { migratedDb,expectRejection, type TestDb } from './helpers.js'

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
    db = await migratedDb()
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

    /**
     * 0016. LinkedIn is one of the two cold channels §2.1 permits, so before
     * this it was the one channel where somebody could ask to be left alone
     * and have nowhere to record it. The CHECK is the shape
     * `normaliseLinkedIn()` produces, so a value that did not come through
     * it cannot be stored.
     */
    it('REFUSES a LinkedIn value that is not a bare namespace and slug', async () => {
      const bad = [
        'https://www.linkedin.com/in/priya',  // a URL, not the stored form
        'linkedin.com/in/priya',
        'in/PRIYA',                            // not folded
        'priya',                               // no namespace
        'in/',                                 // no slug
        'school/imperial',                     // a namespace this product does not message
        'in/priya/detail/recent-activity',     // a sub-page
      ]
      for (const value of bad) {
        const msg = await expectRejection(() =>
          db.driver.select(
            `INSERT INTO suppressions (org_id, kind, value, reason) VALUES ($1, 'linkedin', $2, 'opt-out')`,
            [orgId, value],
          ),
        )
        expect(msg, `"${value}" should be rejected`).toMatch(/suppressions_(value_is_normalised|kind_check)/)
      }
    })

    it('accepts a LinkedIn profile and a company page as different rows', async () => {
      // The percent-encoded form is what normaliseLinkedIn() produces for a
      // non-ASCII slug, so the CHECK has to accept exactly that — the JS and
      // the SQL must agree on the same set or one of them is unreachable.
      for (const value of ['in/priya', 'company/rentman', 'in/jos%c3%a9-garc%c3%ada']) {
        const ok = await db.driver.select(
          `INSERT INTO suppressions (org_id, kind, value, reason)
           VALUES ($1, 'linkedin', $2, 'asked to stop on LinkedIn') RETURNING id`,
          [orgId, value],
        )
        expect(ok, value).toHaveLength(1)
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
      it.each(['Europe/London', 'America/New_York', 'Asia/Kolkata', 'UTC', 'America/Argentina/Salta', 'Japan', 'GMT', 'EST5EDT'])(
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
      it.each(['United States', 'Pacific Time', '', 'Europe London', 'Europe/London; DROP'])(
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

    /**
     * 0011. A message may not claim a person approved it without naming the
     * person and the moment — the same rule 0004 applied to `approvals`. A
     * message that went out "approved" with nobody's name on it is exactly the
     * audit gap §2.4 exists to close.
     */
    describe('a person’s approval on a draft (0011)', () => {
      let n = 0
      /** A fresh member each time, so the RESTRICT test can try to delete one. */
      const approver = async (): Promise<string> => {
        n += 1
        const [{ id }] = await db.driver.select<{ id: string }>(
          `INSERT INTO users (org_id, email, role) VALUES ($1, $2, 'member') RETURNING id`,
          [orgId, `approver-${n}@agency.test`],
        )
        return id
      }

      it('refuses status approved with no approver', async () => {
        const msg = await expectRejection(() =>
          db.driver.select(
            `INSERT INTO touches (org_id, company_id, channel, direction, status)
             VALUES ($1, $2, 'email', 'out', 'approved')`,
            [orgId, companyId],
          ),
        )
        expect(msg).toContain('touches_approved_has_approver')
      })

      it('refuses an approver without a time, and a time without an approver', async () => {
        const who = await approver()
        // On a row that is NOT approved, so the only rule in play is that the
        // two columns move together — an approved row without a time trips
        // `touches_approved_has_approver` first, which is the other test.
        const noTime = await expectRejection(() =>
          db.driver.select(
            `INSERT INTO touches (org_id, company_id, channel, direction, status, approved_by)
             VALUES ($1, $2, 'email', 'out', 'awaiting_approval', $3)`,
            [orgId, companyId, who],
          ),
        )
        expect(noTime).toContain('touches_approver_and_time_agree')
        const noWho = await expectRejection(() =>
          db.driver.select(
            `INSERT INTO touches (org_id, company_id, channel, direction, status, approved_at)
             VALUES ($1, $2, 'email', 'out', 'awaiting_approval', now())`,
            [orgId, companyId],
          ),
        )
        expect(noWho).toContain('touches_approver_and_time_agree')
      })

      it('accepts an approval that names who and when', async () => {
        const who = await approver()
        const [{ id }] = await db.driver.select<{ id: string }>(
          `INSERT INTO touches (org_id, company_id, channel, direction, status, approved_by, approved_at)
           VALUES ($1, $2, 'email', 'out', 'approved', $3, now()) RETURNING id`,
          [orgId, companyId, who],
        )
        expect(id).toBeTruthy()
      })

      /**
       * RESTRICT: whoever approved a sent message stays identifiable for as
       * long as the record of the message does.
       */
      it('will not delete a user who approved a message', async () => {
        const who = await approver()
        await db.driver.select(
          `INSERT INTO touches (org_id, company_id, channel, direction, status, approved_by, approved_at)
           VALUES ($1, $2, 'email', 'out', 'approved', $3, now())`,
          [orgId, companyId, who],
        )
        const msg = await expectRejection(() => db.driver.select(`DELETE FROM users WHERE id = $1`, [who]))
        expect(msg.length).toBeGreaterThan(0)
      })

      it('knows the sender’s claim status', async () => {
        const [{ id }] = await db.driver.select<{ id: string }>(
          `INSERT INTO touches (org_id, company_id, channel, direction, status)
           VALUES ($1, $2, 'email', 'out', 'sending') RETURNING id`,
          [orgId, companyId],
        )
        expect(id).toBeTruthy()
      })

      it('lets only an inbound message answer something', async () => {
        const [{ id: sent }] = await db.driver.select<{ id: string }>(
          `INSERT INTO touches (org_id, company_id, channel, direction, status)
           VALUES ($1, $2, 'email', 'out', 'sent') RETURNING id`,
          [orgId, companyId],
        )
        const msg = await expectRejection(() =>
          db.driver.select(
            `INSERT INTO touches (org_id, company_id, channel, direction, status, in_reply_to)
             VALUES ($1, $2, 'email', 'out', 'sent', $3)`,
            [orgId, companyId, sent],
          ),
        )
        expect(msg).toContain('touches_only_inbound_replies')
        const [{ id: reply }] = await db.driver.select<{ id: string }>(
          `INSERT INTO touches (org_id, company_id, channel, direction, status, in_reply_to)
           VALUES ($1, $2, 'email', 'in', 'replied', $3) RETURNING id`,
          [orgId, companyId, sent],
        )
        expect(reply).toBeTruthy()
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

/**
 * 0018 — evidence, consent records and operations. One reject and one accept
 * per CHECK, unique index, trigger and same-org key, with the constraint's
 * name asserted in the message: the name is what somebody reads in a log six
 * months later, and a rule that fails under a different name is a rule
 * nobody can find.
 */
describe('0018 — evidence, consent records and operations', () => {
  let db: TestDb
  let orgId: string
  let userId: string
  let companyId: string
  let contactId: string
  let scanId: string
  let proposalId: string
  let inbound: string
  let outbound: string
  // A second org, its user and its contact: every same-org key is proved by
  // a row that names the RIGHT kind of thing in the WRONG org.
  let rivalOrg: string
  let rivalUser: string
  let rivalContact: string
  let rivalInbound: string

  beforeAll(async () => {
    db = await migratedDb()
    ;[{ id: orgId }] = await db.driver.select<{ id: string }>(`INSERT INTO orgs (name) VALUES ('Agency') RETURNING id`)
    ;[{ id: userId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO users (org_id, email, role) VALUES ($1, 'owner@agency.test', 'owner') RETURNING id`, [orgId],
    )
    ;[{ id: companyId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO companies (org_id, domain, name) VALUES ($1, 'rentman.io', 'Rentman') RETURNING id`, [orgId],
    )
    ;[{ id: contactId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO contacts (org_id, company_id, email) VALUES ($1, $2, 'priya@rentman.io') RETURNING id`, [orgId, companyId],
    )
    ;[{ id: scanId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO scans (org_id, company_id, ok) VALUES ($1, $2, true) RETURNING id`, [orgId, companyId],
    )
    ;[{ id: proposalId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO proposals (org_id, company_id, scan_id, title, document) VALUES ($1, $2, $3, 'Posture review', '{}'::jsonb) RETURNING id`,
      [orgId, companyId, scanId],
    )
    ;[{ id: inbound }] = await db.driver.select<{ id: string }>(
      `INSERT INTO touches (org_id, company_id, contact_id, channel, direction, status, provider_id)
       VALUES ($1, $2, $3, 'email', 'in', 'replied', '<abc@rentman.io>') RETURNING id`,
      [orgId, companyId, contactId],
    )
    ;[{ id: outbound }] = await db.driver.select<{ id: string }>(
      `INSERT INTO touches (org_id, company_id, contact_id, channel, direction, status, sent_at)
       VALUES ($1, $2, $3, 'email', 'out', 'sent', now()) RETURNING id`,
      [orgId, companyId, contactId],
    )
    ;[{ id: rivalOrg }] = await db.driver.select<{ id: string }>(`INSERT INTO orgs (name) VALUES ('Rival') RETURNING id`)
    ;[{ id: rivalUser }] = await db.driver.select<{ id: string }>(
      `INSERT INTO users (org_id, email, role) VALUES ($1, 'owner@rival.test', 'owner') RETURNING id`, [rivalOrg],
    )
    const [{ id: rivalCompany }] = await db.driver.select<{ id: string }>(
      `INSERT INTO companies (org_id, domain) VALUES ($1, 'rival.test') RETURNING id`, [rivalOrg],
    )
    ;[{ id: rivalContact }] = await db.driver.select<{ id: string }>(
      `INSERT INTO contacts (org_id, company_id, email) VALUES ($1, $2, 'x@rival.test') RETURNING id`, [rivalOrg, rivalCompany],
    )
    ;[{ id: rivalInbound }] = await db.driver.select<{ id: string }>(
      `INSERT INTO touches (org_id, company_id, contact_id, channel, direction, status, provider_id)
       VALUES ($1, $2, $3, 'email', 'in', 'replied', '<theirs@rival.test>') RETURNING id`,
      [rivalOrg, rivalCompany, rivalContact],
    )
  })
  afterAll(async () => { await db.close() })

  const reject = async (sql: string, params: unknown[]) =>
    expectRejection(() => db.driver.select(sql, params))

  describe('§2.2 findings.scored — an informational signal carries no weight', () => {
    it('REFUSES an unscored finding that claims weight', async () => {
      const msg = await reject(
        `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight, scored, evidence)
         VALUES ($1, $2, $3, 'csp_quality', true, true, 5, false, '{"url":"https://rentman.io/"}'::jsonb)`,
        [orgId, scanId, companyId],
      )
      expect(msg).toContain('findings_informational_carries_no_weight')
    })

    it('accepts an unscored finding at weight 0', async () => {
      const rows = await db.driver.select<{ id: string }>(
        `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight, scored, evidence)
         VALUES ($1, $2, $3, 'csp_quality', true, true, 0, false, '{"url":"https://rentman.io/"}'::jsonb) RETURNING id`,
        [orgId, scanId, companyId],
      )
      expect(rows).toHaveLength(1)
    })

    it('defaults every existing row to scored — everything stored before 0018 was an ICP key', async () => {
      const [row] = await db.driver.select<{ scored: boolean }>(
        `INSERT INTO findings (org_id, scan_id, company_id, signal_key, observed, gap, weight)
         VALUES ($1, $2, $3, 'hsts', true, false, 10) RETURNING scored`,
        [orgId, scanId, companyId],
      )
      expect(row.scored).toBe(true)
    })
  })

  describe('touches.handled_* — a person dealt with a reply', () => {
    it('REFUSES handling an OUTBOUND row', async () => {
      const msg = await reject(
        `UPDATE touches SET handled_at = now(), handled_by = $2 WHERE id = $1`, [outbound, userId],
      )
      expect(msg).toContain('touches_handled_is_inbound_only')
    })

    it('REFUSES a handled_at with nobody named, and a name with no time', async () => {
      const a = await reject(`UPDATE touches SET handled_at = now() WHERE id = $1`, [inbound])
      expect(a).toContain('touches_handled_has_who')
      const b = await reject(`UPDATE touches SET handled_by = $2 WHERE id = $1`, [inbound, userId])
      expect(b).toContain('touches_handled_has_who')
    })

    it('REFUSES a handler from another org', async () => {
      const msg = await reject(
        `UPDATE touches SET handled_at = now(), handled_by = $2 WHERE id = $1`, [inbound, rivalUser],
      )
      expect(msg).toContain('touches_handled_by_is_in_the_same_org')
    })

    it('accepts an inbound row handled by one of its own org’s users', async () => {
      const rows = await db.driver.select<{ id: string }>(
        `UPDATE touches SET handled_at = now(), handled_by = $2 WHERE id = $1 RETURNING id`, [inbound, userId],
      )
      expect(rows).toHaveLength(1)
    })

    it('will not delete a user who handled a reply — they are revoked, never deleted', async () => {
      const msg = await reject(`DELETE FROM users WHERE id = $1`, [userId])
      expect(msg).toMatch(/touches_handled_by_is_in_the_same_org|violates foreign key/)
    })
  })

  describe('touches.answers_touch_id — an outbound draft that answers a reply', () => {
    it('REFUSES an INBOUND row that claims to answer something', async () => {
      const msg = await reject(
        `INSERT INTO touches (org_id, company_id, channel, direction, status, answers_touch_id)
         VALUES ($1, $2, 'email', 'in', 'replied', $3)`,
        [orgId, companyId, inbound],
      )
      expect(msg).toContain('touches_answer_is_outbound')
    })

    /**
     * The FK only says the parent exists. `dispatchTouch` reads the parent's
     * provider_id into In-Reply-To, so answering an OUTBOUND row, or a row
     * in another org, would thread this message into a conversation that is
     * not its own.
     */
    it('REFUSES an answer to an OUTBOUND row', async () => {
      const msg = await reject(
        `INSERT INTO touches (org_id, company_id, channel, direction, status, answers_touch_id)
         VALUES ($1, $2, 'email', 'out', 'awaiting_approval', $3)`,
        [orgId, companyId, outbound],
      )
      expect(msg).toContain('touches_answer_names_an_inbound_row_in_the_same_org')
    })

    it('REFUSES an answer to another org’s reply', async () => {
      const msg = await reject(
        `INSERT INTO touches (org_id, company_id, channel, direction, status, answers_touch_id)
         VALUES ($1, $2, 'email', 'out', 'awaiting_approval', $3)`,
        [orgId, companyId, rivalInbound],
      )
      expect(msg).toContain('touches_answer_names_an_inbound_row_in_the_same_org')
    })

    it('accepts an answer to an inbound row in the same org, and refuses re-pointing it afterwards', async () => {
      const [{ id }] = await db.driver.select<{ id: string }>(
        `INSERT INTO touches (org_id, company_id, contact_id, channel, direction, status, answers_touch_id)
         VALUES ($1, $2, $3, 'email', 'out', 'awaiting_approval', $4) RETURNING id`,
        [orgId, companyId, contactId, inbound],
      )
      expect(id).toBeTruthy()
      // Fires on UPDATE too: an honest row cannot be edited into a dishonest one.
      const msg = await reject(`UPDATE touches SET answers_touch_id = $2 WHERE id = $1`, [id, rivalInbound])
      expect(msg).toContain('touches_answer_names_an_inbound_row_in_the_same_org')
    })

    it('keeps the answer when the reply it answered is deleted (SET NULL)', async () => {
      const [{ id: reply }] = await db.driver.select<{ id: string }>(
        `INSERT INTO touches (org_id, company_id, channel, direction, status) VALUES ($1, $2, 'email', 'in', 'replied') RETURNING id`,
        [orgId, companyId],
      )
      const [{ id: answer }] = await db.driver.select<{ id: string }>(
        `INSERT INTO touches (org_id, company_id, channel, direction, status, answers_touch_id)
         VALUES ($1, $2, 'email', 'out', 'awaiting_approval', $3) RETURNING id`,
        [orgId, companyId, reply],
      )
      await db.driver.select(`DELETE FROM touches WHERE id = $1`, [reply])
      const [row] = await db.driver.select<{ answers_touch_id: string | null }>(
        `SELECT answers_touch_id FROM touches WHERE id = $1`, [answer],
      )
      expect(row.answers_touch_id).toBeNull()
    })
  })

  describe('§2.1 suppressions.source — which path recorded the opt-out', () => {
    it.each(['imported', 'agent', 'MANUAL', ''])('REFUSES the source %j', async (source) => {
      const msg = await reject(
        `INSERT INTO suppressions (org_id, kind, value, reason, source) VALUES ($1, 'email', $2, 'r', $3)`,
        [orgId, `${source.toLowerCase() || 'blank'}-source@example.com`, source],
      )
      expect(msg).toContain('suppressions_source_is_known')
    })

    it.each(['manual', 'reply', 'voice', 'unsubscribe', 'erasure', null])('accepts the source %j', async (source) => {
      const rows = await db.driver.select<{ id: string }>(
        `INSERT INTO suppressions (org_id, kind, value, reason, source) VALUES ($1, 'email', $2, 'r', $3) RETURNING id`,
        [orgId, `${source ?? 'untracked'}@example.com`, source],
      )
      expect(rows).toHaveLength(1)
    })
  })

  describe('§6 connectors.name is never agency', () => {
    it('REFUSES a connector named agency — it would displace the in-process server', async () => {
      const msg = await reject(
        `INSERT INTO connectors (org_id, name, kind, config) VALUES ($1, 'agency', 'http', '{}'::jsonb)`, [orgId],
      )
      expect(msg).toContain('connectors_name_is_not_agency')
    })
  })

  describe('contacts.email_bounce* — a bounce is evidence about an address', () => {
    it('REFUSES a bounce mark without its DSN code, and a code without a mark', async () => {
      const a = await reject(`UPDATE contacts SET email_bounced_at = now() WHERE id = $1`, [contactId])
      expect(a).toContain('contacts_bounce_has_code')
      const b = await reject(`UPDATE contacts SET email_bounce_code = '5.1.1' WHERE id = $1`, [contactId])
      expect(b).toContain('contacts_bounce_has_code')
    })

    it('accepts the mark with its code', async () => {
      const rows = await db.driver.select<{ id: string }>(
        `UPDATE contacts SET email_bounced_at = now(), email_bounce_code = '5.1.1' WHERE id = $1 RETURNING id`, [contactId],
      )
      expect(rows).toHaveLength(1)
    })

    it('REFUSES a code that is not an RFC 3463 status (0019)', async () => {
      for (const code of ['bounced', '550', '5.1', '2.0.0', '5.1.1 user unknown', ' 5.1.1', '']) {
        const msg = await reject(
          `UPDATE contacts SET email_bounced_at = now(), email_bounce_code = $2 WHERE id = $1`, [contactId, code],
        )
        expect(msg, code).toMatch(/contacts_bounce_code_is_rfc3463|contacts_bounce_has_code/)
      }
      const rows = await db.driver.select<{ id: string }>(
        `UPDATE contacts SET email_bounced_at = now(), email_bounce_code = '4.2.2' WHERE id = $1 RETURNING id`, [contactId],
      )
      expect(rows).toHaveLength(1)
    })
  })

  describe('meetings.outcome', () => {
    it('REFUSES an outcome nobody defined', async () => {
      const msg = await reject(
        `INSERT INTO meetings (org_id, company_id, starts_at, time_zone, outcome)
         VALUES ($1, $2, '2026-09-18T14:00:00Z', 'Europe/London', 'maybe')`,
        [orgId, companyId],
      )
      expect(msg).toContain('meetings_outcome_known')
    })

    it.each(['held', 'no_show', 'rescheduled', null])('accepts %j', async (outcome) => {
      const rows = await db.driver.select<{ id: string }>(
        `INSERT INTO meetings (org_id, company_id, starts_at, time_zone, outcome)
         VALUES ($1, $2, '2026-09-18T14:00:00Z', 'Europe/London', $3) RETURNING id`,
        [orgId, companyId, outcome],
      )
      expect(rows).toHaveLength(1)
    })
  })

  describe('notes', () => {
    const note = (over: { body?: string; contact?: string | null; author?: string } = {}) =>
      db.driver.select<{ id: string }>(
        `INSERT INTO notes (org_id, company_id, contact_id, author_user_id, body) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [orgId, companyId, over.contact ?? null, over.author ?? userId, over.body ?? 'Spoke to Priya; wants the CSP finding first.'],
      )

    it('REFUSES a blank body and one over 8000 characters', async () => {
      expect(await expectRejection(() => note({ body: '   ' }))).toContain('notes_body_is_not_blank')
      expect(await expectRejection(() => note({ body: 'x'.repeat(8001) }))).toContain('notes_body_is_bounded')
    })

    it('REFUSES a note about another org’s contact, or by another org’s user', async () => {
      expect(await expectRejection(() => note({ contact: rivalContact }))).toContain('notes_contact_is_in_the_same_org')
      expect(await expectRejection(() => note({ author: rivalUser }))).toContain('notes_author_is_in_the_same_org')
    })

    it('accepts a note, with or without a contact', async () => {
      expect(await note()).toHaveLength(1)
      expect(await note({ contact: contactId })).toHaveLength(1)
    })
  })

  describe('tasks', () => {
    const task = (over: Record<string, unknown> = {}) => {
      const t = {
        kind: 'todo', title: 'Send the proposal', touch: null, assignee: null, creator: userId,
        doneAt: null, doneBy: null, ...over,
      }
      return db.driver.select<{ id: string }>(
        `INSERT INTO tasks (org_id, company_id, touch_id, kind, title, assignee_user_id, created_by, done_at, done_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [orgId, companyId, t.touch, t.kind, t.title, t.assignee, t.creator, t.doneAt, t.doneBy],
      )
    }

    it('REFUSES a kind nobody defined, and a blank or over-long title', async () => {
      expect(await expectRejection(() => task({ kind: 'chore' }))).toContain('tasks_kind_known')
      expect(await expectRejection(() => task({ title: '  ' }))).toContain('tasks_title_is_not_blank')
      expect(await expectRejection(() => task({ title: 't'.repeat(201) }))).toContain('tasks_title_is_bounded')
    })

    it('REFUSES a done task with nobody named, and a name with no done time', async () => {
      expect(await expectRejection(() => task({ doneAt: new Date().toISOString() }))).toContain('tasks_done_has_who')
      expect(await expectRejection(() => task({ doneBy: userId }))).toContain('tasks_done_has_who')
    })

    it('REFUSES a linkedin_send task that names no touch', async () => {
      expect(await expectRejection(() => task({ kind: 'linkedin_send' }))).toContain('tasks_linkedin_send_names_touch')
    })

    it('REFUSES an assignee, creator or finisher from another org', async () => {
      expect(await expectRejection(() => task({ assignee: rivalUser }))).toContain('tasks_assignee_is_in_the_same_org')
      expect(await expectRejection(() => task({ creator: rivalUser }))).toContain('tasks_creator_is_in_the_same_org')
      expect(await expectRejection(() => task({ doneAt: new Date().toISOString(), doneBy: rivalUser })))
        .toContain('tasks_done_by_is_in_the_same_org')
    })

    /**
     * Two callers materialising one LinkedIn draft produce one task and the
     * loser re-reads. A DONE task does not block a new open one: the step
     * can legitimately be asked again.
     */
    it('allows one OPEN task per touch: a second is refused, a done one then an open one is fine', async () => {
      expect(await task({ kind: 'linkedin_send', touch: outbound })).toHaveLength(1)
      const msg = await expectRejection(() => task({ kind: 'linkedin_send', touch: outbound }))
      expect(msg).toMatch(/tasks_one_open_per_touch|duplicate key/)
      await db.driver.select(`UPDATE tasks SET done_at = now(), done_by = $2 WHERE touch_id = $1`, [outbound, userId])
      expect(await task({ kind: 'linkedin_send', touch: outbound })).toHaveLength(1)
    })

    it('accepts a plain to-do with an assignee, and unassigns it when that user is deleted (SET NULL names its column)', async () => {
      const [{ id: temp }] = await db.driver.select<{ id: string }>(
        `INSERT INTO users (org_id, email, role) VALUES ($1, 'temp@agency.test', 'member') RETURNING id`, [orgId],
      )
      const [{ id }] = await task({ assignee: temp, creator: temp })
      await db.driver.select(`DELETE FROM users WHERE id = $1`, [temp])
      const [row] = await db.driver.select<{ assignee_user_id: string | null; created_by: string | null; org_id: string }>(
        `SELECT assignee_user_id, created_by, org_id FROM tasks WHERE id = $1`, [id],
      )
      expect(row.assignee_user_id).toBeNull()
      expect(row.created_by).toBeNull()
      expect(row.org_id).toBe(orgId)
    })
  })

  describe('proposal_shares — a buyer link stores only the hash of its token', () => {
    const HASH = 'a'.repeat(64)
    const share = (over: Record<string, unknown> = {}) => {
      const s = { hash: HASH, creator: userId, expires: `now() + interval '30 days'`, acceptedAt: null, acceptedBy: null, ...over }
      return db.driver.select<{ id: string }>(
        `INSERT INTO proposal_shares (org_id, proposal_id, token_hash, created_by, expires_at, accepted_at, accepted_by_name)
         VALUES ($1, $2, $3, $4, ${s.expires}, $5, $6) RETURNING id`,
        [orgId, proposalId, s.hash, s.creator, s.acceptedAt, s.acceptedBy],
      )
    }

    it('REFUSES a raw token, a short hash and upper-case hex', async () => {
      expect(await expectRejection(() => share({ hash: 'b'.repeat(32) }))).toContain('proposal_shares_token_hash_shape')
      expect(await expectRejection(() => share({ hash: 'A'.repeat(64) }))).toContain('proposal_shares_token_hash_shape')
      expect(await expectRejection(() => share({ hash: `${'c'.repeat(60)}.tok` }))).toContain('proposal_shares_token_hash_shape')
    })

    it('REFUSES an acceptance with no name, a name with no acceptance, and a blank name', async () => {
      expect(await expectRejection(() => share({ hash: 'd'.repeat(64), acceptedAt: new Date().toISOString() })))
        .toContain('proposal_shares_accepted_has_name')
      expect(await expectRejection(() => share({ hash: 'd'.repeat(64), acceptedBy: 'Sam' })))
        .toContain('proposal_shares_accepted_has_name')
      expect(await expectRejection(() => share({ hash: 'd'.repeat(64), acceptedAt: new Date().toISOString(), acceptedBy: '  ' })))
        .toContain('proposal_shares_accepted_name_not_blank')
    })

    it('REFUSES a link that expires before it was created', async () => {
      expect(await expectRejection(() => share({ hash: 'e'.repeat(64), expires: `now() - interval '1 hour'` })))
        .toContain('proposal_shares_expires_after_created')
    })

    it('REFUSES a creator from another org', async () => {
      expect(await expectRejection(() => share({ hash: 'f'.repeat(64), creator: rivalUser })))
        .toContain('proposal_shares_creator_is_in_the_same_org')
    })

    it('accepts a link, and refuses the same hash twice', async () => {
      expect(await share()).toHaveLength(1)
      expect(await expectRejection(() => share())).toMatch(/proposal_shares_token_hash_key|duplicate key/)
    })
  })

  describe('worker_heartbeats — a system table', () => {
    const beat = (over: Record<string, unknown> = {}) => {
      const b = { worker: 'w-1', booted: `now() - interval '1 minute'`, tick: 'now()', outreach: 'disabled', chat: 'disabled', ...over }
      return db.driver.select<{ id: string }>(
        `INSERT INTO worker_heartbeats (worker_id, booted_at, last_tick_at, outreach, chat)
         VALUES ($1, ${b.booted}, ${b.tick}, $2, $3) RETURNING id`,
        [b.worker, b.outreach, b.chat],
      )
    }

    it('accepts a heartbeat, and refuses a second row for the same worker', async () => {
      expect(await beat()).toHaveLength(1)
      expect(await expectRejection(() => beat())).toMatch(/worker_heartbeats_worker_key|duplicate key/)
    })

    it('REFUSES an outreach or chat state nobody defined', async () => {
      expect(await expectRejection(() => beat({ worker: 'w-2', outreach: 'maybe' }))).toContain('worker_heartbeats_outreach_known')
      expect(await expectRejection(() => beat({ worker: 'w-3', chat: 'sometimes' }))).toContain('worker_heartbeats_chat_known')
    })

    it('REFUSES a tick from before the boot', async () => {
      expect(await expectRejection(() => beat({ worker: 'w-4', booted: 'now()', tick: `now() - interval '1 hour'` })))
        .toContain('worker_heartbeats_beat_after_boot')
    })
  })
})

describe('0019 — message templates, and what the operator said', () => {
  let db: TestDb
  let orgId: string
  let userId: string
  let companyId: string
  let contactId: string
  let campaignId: string
  let smsTemplate: string
  let waTemplate: string
  let rivalOrg: string
  let rivalUser: string
  let rivalTemplate: string

  beforeAll(async () => {
    db = await migratedDb()
    ;[{ id: orgId }] = await db.driver.select<{ id: string }>(`INSERT INTO orgs (name) VALUES ('Agency') RETURNING id`)
    ;[{ id: userId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO users (org_id, email, role) VALUES ($1, 'owner@agency.test', 'owner') RETURNING id`, [orgId],
    )
    ;[{ id: companyId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO companies (org_id, domain) VALUES ($1, 'rentman.in') RETURNING id`, [orgId],
    )
    ;[{ id: contactId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO contacts (org_id, company_id, phone) VALUES ($1, $2, '+919876543210') RETURNING id`, [orgId, companyId],
    )
    ;[{ id: campaignId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO campaigns (org_id, name, channel, status) VALUES ($1, 'Reminders', 'sms', 'active') RETURNING id`, [orgId],
    )
    ;[{ id: smsTemplate }] = await db.driver.select<{ id: string }>(
      `INSERT INTO message_templates (org_id, channel, external_id, sender_id, category, body, created_by)
       VALUES ($1, 'sms', '1107160000000012345', 'ACMEIN', 'service_explicit', 'Hi {#var#}', $2) RETURNING id`,
      [orgId, userId],
    )
    ;[{ id: waTemplate }] = await db.driver.select<{ id: string }>(
      `INSERT INTO message_templates (org_id, channel, external_id, sender_id, category, body)
       VALUES ($1, 'whatsapp', 'meeting_reminder', '+919800000000', 'utility', 'Hi {#var#}') RETURNING id`,
      [orgId],
    )
    ;[{ id: rivalOrg }] = await db.driver.select<{ id: string }>(`INSERT INTO orgs (name) VALUES ('Rival') RETURNING id`)
    ;[{ id: rivalUser }] = await db.driver.select<{ id: string }>(
      `INSERT INTO users (org_id, email, role) VALUES ($1, 'owner@rival.test', 'owner') RETURNING id`, [rivalOrg],
    )
    ;[{ id: rivalTemplate }] = await db.driver.select<{ id: string }>(
      `INSERT INTO message_templates (org_id, channel, external_id, sender_id, category, body)
       VALUES ($1, 'sms', '1107160000000099999', 'RIVALS', 'promotional', 'Offer {#var#}') RETURNING id`,
      [rivalOrg],
    )
  })
  afterAll(async () => { await db.close() })

  const reject = async (sql: string, params: unknown[]) => expectRejection(() => db.driver.select(sql, params))

  /** A template row, with any column overridden by SQL text. */
  const template = (over: Record<string, string> = {}, params: unknown[] = [orgId]) => {
    const v = {
      channel: `'sms'`, provider: `'dovesoft'`, external_id: `'1107160000000000001'`, sender_id: `'ACMEIN'`,
      category: `'promotional'`, body: `'Hi {#var#}'`, name: 'NULL', language: `'en'`, created_by: 'NULL', ...over,
    }
    return db.driver.select<{ id: string }>(
      `INSERT INTO message_templates (org_id, channel, provider, external_id, sender_id, category, body, name, language, created_by)
       VALUES ($1, ${v.channel}, ${v.provider}, ${v.external_id}, ${v.sender_id}, ${v.category}, ${v.body}, ${v.name}, ${v.language}, ${v.created_by})
       RETURNING id`,
      params,
    )
  }
  let n = 100
  /** A fresh external id per row, so the unique key is never the constraint under test by accident. */
  const nextId = () => `'11071600000000${String((n += 1)).padStart(5, '0')}'`

  describe('message_templates', () => {
    it('accepts an SMS, a WhatsApp and a voice template, each in its own categories', async () => {
      expect(await template({ external_id: nextId() })).toHaveLength(1)
      expect(await template({ external_id: `'welcome_v2'`, channel: `'whatsapp'`, sender_id: `'+919800000000'`, category: `'marketing'` })).toHaveLength(1)
      expect(await template({ external_id: nextId(), channel: `'voice'`, sender_id: `'+911400000000'`, category: `'service_implicit'` })).toHaveLength(1)
    })

    it('REFUSES a channel, or a provider, nobody defined', async () => {
      // An unknown channel also has no category list, so either CHECK may be the one reported.
      expect(await expectRejection(() => template({ external_id: nextId(), channel: `'email'` }))).toMatch(
        /message_templates_channel_known|message_templates_category_fits_channel/,
      )
      expect(await expectRejection(() => template({ external_id: nextId(), provider: `'twilio'` }))).toContain('message_templates_provider_known')
    })

    it('REFUSES a category from the other channel’s list', async () => {
      expect(await expectRejection(() => template({ external_id: nextId(), category: `'marketing'` }))).toContain('message_templates_category_fits_channel')
      expect(
        await expectRejection(() => template({ external_id: `'x_tpl'`, channel: `'whatsapp'`, sender_id: `'+919800000000'`, category: `'promotional'` })),
      ).toContain('message_templates_category_fits_channel')
    })

    it('REFUSES a blank, spaced or over-long template id', async () => {
      for (const id of [`'  '`, `'1107 1600'`, `'${'1'.repeat(129)}'`]) {
        expect(await expectRejection(() => template({ external_id: id }))).toContain('message_templates_external_id_shape')
      }
    })

    it('REFUSES an SMS header that is not six upper-case letters or digits, and accepts one that is', async () => {
      for (const h of [`'acmein'`, `'ACME'`, `'ACMEINX'`, `'ACM-IN'`]) {
        expect(await expectRejection(() => template({ external_id: nextId(), sender_id: h }))).toContain('message_templates_sms_sender_is_a_dlt_header')
      }
      expect(await template({ external_id: nextId(), sender_id: `'123456'` })).toHaveLength(1)
    })

    it('REFUSES a blank sender on any channel', async () => {
      expect(
        await expectRejection(() => template({ external_id: `'blank_sender'`, channel: `'whatsapp'`, sender_id: `'  '`, category: `'utility'` })),
      ).toContain('message_templates_sender_is_not_blank')
    })

    it('REFUSES a blank or over-long body', async () => {
      expect(await expectRejection(() => template({ external_id: nextId(), body: `'   '` }))).toContain('message_templates_body_is_not_blank')
      expect(await expectRejection(() => template({ external_id: nextId(), body: `repeat('x', 4001)` }))).toContain('message_templates_body_is_not_blank')
    })

    it('REFUSES a blank name or language, and accepts a NULL name', async () => {
      expect(await expectRejection(() => template({ external_id: nextId(), name: `' '` }))).toContain('message_templates_name_is_bounded')
      expect(await expectRejection(() => template({ external_id: nextId(), language: `' '` }))).toContain('message_templates_language_is_bounded')
      expect(await template({ external_id: nextId(), name: `'Reminder'`, language: `'hi'` })).toHaveLength(1)
    })

    it('REFUSES a second template with the same id on the same channel in one org — and allows it in another', async () => {
      expect(await expectRejection(() => template({ external_id: `'1107160000000012345'` }))).toMatch(
        /message_templates_org_channel_external_key|duplicate key/,
      )
      expect(await template({ external_id: `'1107160000000012345'` }, [rivalOrg])).toHaveLength(1)
    })

    it('REFUSES a creator from another org', async () => {
      expect(await expectRejection(() => template({ external_id: nextId(), created_by: '$2' }, [orgId, rivalUser]))).toContain(
        'message_templates_creator_is_in_the_same_org',
      )
    })

    it('stamps updated_at when a template is switched off', async () => {
      const [row] = await db.driver.select<{ updated_at: string | null }>(
        `UPDATE message_templates SET active = false WHERE id = (SELECT id FROM message_templates WHERE org_id = $1 AND channel = 'voice' LIMIT 1) RETURNING updated_at`,
        [orgId],
      )
      expect(row?.updated_at).not.toBeNull()
    })
  })

  describe('touches.template_id — the template a message was rendered from', () => {
    const smsTouch = (status: string, tpl: string | null, channel = 'sms', direction = 'out') =>
      db.driver.select<{ id: string }>(
        `INSERT INTO touches (org_id, campaign_id, contact_id, company_id, channel, direction, status, template_id, refusal_code,
                              approved_by, approved_at, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 CASE WHEN $7 = 'refused' THEN 'no_template' END,
                 CASE WHEN $7 = 'approved' THEN $9::uuid END, CASE WHEN $7 = 'approved' THEN now() END, 'Hi Priya')
         RETURNING id`,
        [orgId, campaignId, contactId, companyId, channel, direction, status, tpl, userId],
      )

    it('accepts an outbound SMS naming an SMS template of its own org', async () => {
      expect(await smsTouch('awaiting_approval', smsTemplate)).toHaveLength(1)
    })

    it('REFUSES a template of another org', async () => {
      expect(await expectRejection(() => smsTouch('awaiting_approval', rivalTemplate))).toContain(
        'touches_template_is_in_the_same_org_and_channel',
      )
    })

    it('REFUSES a template of another channel: an SMS cannot be rendered from a WhatsApp template', async () => {
      expect(await expectRejection(() => smsTouch('awaiting_approval', waTemplate))).toContain(
        'touches_template_is_in_the_same_org_and_channel',
      )
    })

    it.each(['awaiting_approval', 'approved', 'queued', 'sending'])(
      'REFUSES an outbound SMS in %s that names no template',
      async (status) => {
        expect(await expectRejection(() => smsTouch(status, null))).toContain('touches_sms_and_whatsapp_name_a_template')
      },
    )

    it('REFUSES an outbound WhatsApp message with no template too', async () => {
      expect(await expectRejection(() => smsTouch('awaiting_approval', null, 'whatsapp'))).toContain('touches_sms_and_whatsapp_name_a_template')
    })

    /**
     * `sent` is reached only from `sending`, which the CHECK binds, so a sent
     * row without a template is one a revert of 0019 left. Binding `sent`
     * made every such row un-updatable after a re-apply (review round 4,
     * [11]; migration-0019-revert.test.ts drives the sequence).
     */
    it('accepts a sent SMS with no template — only a revert of 0019 leaves one', async () => {
      expect(await smsTouch('sent', null)).toHaveLength(1)
    })

    it('accepts a refused or failed SMS with no template — neither can go out', async () => {
      expect(await smsTouch('refused', null)).toHaveLength(1)
      expect(await smsTouch('failed', null)).toHaveLength(1)
    })

    it('REFUSES re-approving such a row back into a state that can go out', async () => {
      const [{ id }] = await smsTouch('refused', null)
      expect(
        await reject(`UPDATE touches SET status = 'approved', refusal_code = NULL, approved_by = $2, approved_at = now() WHERE id = $1`, [id, userId]),
      ).toContain('touches_sms_and_whatsapp_name_a_template')
    })

    it('accepts an inbound SMS, and an email, with no template', async () => {
      expect(await smsTouch('replied', null, 'sms', 'in')).toHaveLength(1)
      expect(await smsTouch('awaiting_approval', null, 'email')).toHaveLength(1)
    })

    it('will not delete a template a message names', async () => {
      expect(await reject(`DELETE FROM message_templates WHERE id = $1`, [smsTemplate])).toMatch(
        /touches_template_is_in_the_same_org_and_channel|violates foreign key/,
      )
    })

    it('is enforced only from 0019 on: the check is NOT VALID, so stored rows were never re-checked', async () => {
      const [row] = await db.driver.select<{ convalidated: boolean }>(
        `SELECT convalidated FROM pg_constraint WHERE conname = 'touches_sms_and_whatsapp_name_a_template'`,
      )
      expect(row?.convalidated).toBe(false)
    })
  })

  describe('touches.delivery_* — what the operator said', () => {
    let sent: string
    beforeAll(async () => {
      ;[{ id: sent }] = await db.driver.select<{ id: string }>(
        `INSERT INTO touches (org_id, campaign_id, contact_id, channel, direction, status, template_id, provider_id, sent_at)
         VALUES ($1, $2, $3, 'sms', 'out', 'sent', $4, 'ds-1', now()) RETURNING id`,
        [orgId, campaignId, contactId, smsTemplate],
      )
    })
    const set = (cols: string) => db.driver.select<{ id: string }>(`UPDATE touches SET ${cols} WHERE id = $1 RETURNING id`, [sent])

    it('accepts each state with its own evidence', async () => {
      expect(await set(`delivery_status = 'pending', delivered_at = NULL, delivery_error = NULL`)).toHaveLength(1)
      expect(await set(`delivery_status = 'failed', delivered_at = NULL, delivery_error = 'UNDELIV'`)).toHaveLength(1)
      expect(await set(`delivery_status = 'delivered', delivered_at = now(), delivery_error = NULL`)).toHaveLength(1)
      expect(await set(`delivery_status = NULL, delivered_at = NULL, delivery_error = NULL`)).toHaveLength(1)
    })

    it('REFUSES a state nobody defined', async () => {
      expect(await expectRejection(() => set(`delivery_status = 'read'`))).toContain('touches_delivery_status_known')
    })

    it('REFUSES delivered without its time, and a time without delivered — NULL included', async () => {
      expect(await expectRejection(() => set(`delivery_status = 'delivered', delivered_at = NULL`))).toContain('touches_delivered_has_its_time')
      expect(await expectRejection(() => set(`delivery_status = NULL, delivered_at = now()`))).toContain('touches_delivered_has_its_time')
      expect(await expectRejection(() => set(`delivery_status = 'pending', delivered_at = now()`))).toContain('touches_delivered_has_its_time')
    })

    it('REFUSES a failure with no reason, and a reason with no failure', async () => {
      expect(await expectRejection(() => set(`delivery_status = 'failed', delivery_error = NULL`))).toContain('touches_delivery_failure_has_its_reason')
      expect(await expectRejection(() => set(`delivery_status = NULL, delivery_error = 'UNDELIV'`))).toContain('touches_delivery_failure_has_its_reason')
    })

    it('REFUSES a blank or over-long reason', async () => {
      expect(await expectRejection(() => set(`delivery_status = 'failed', delivery_error = '  '`))).toContain('touches_delivery_error_is_bounded')
      expect(await expectRejection(() => set(`delivery_status = 'failed', delivery_error = repeat('x', 301)`))).toContain('touches_delivery_error_is_bounded')
    })

    it('REFUSES a delivery state on an inbound row', async () => {
      const msg = await reject(
        `INSERT INTO touches (org_id, contact_id, channel, direction, status, delivery_status) VALUES ($1, $2, 'sms', 'in', 'replied', 'pending')`,
        [orgId, contactId],
      )
      expect(msg).toContain('touches_delivery_is_outbound_only')
    })
  })

  describe('one inbound SMS, one row', () => {
    const inbound = (providerId: string, channel = 'sms') =>
      db.driver.select<{ id: string }>(
        `INSERT INTO touches (org_id, contact_id, channel, direction, status, provider_id) VALUES ($1, $2, $3, 'in', 'replied', $4) RETURNING id`,
        [orgId, contactId, channel, providerId],
      )

    it('accepts one, and REFUSES the same message id again', async () => {
      expect(await inbound('mo-1')).toHaveLength(1)
      expect(await expectRejection(() => inbound('mo-1'))).toMatch(/touches_inbound_sms_provider_id_key|duplicate key/)
    })

    it('leaves inbound email and outbound rows to their own rules', async () => {
      expect(await inbound('<same@id>', 'email')).toHaveLength(1)
      expect(await inbound('<same@id>', 'email')).toHaveLength(1)
    })
  })

  /**
   * RESTRICT is checked as each row is deleted, and a whole org going takes
   * its templates AND the messages that name them in one cascade. This proves
   * the cascade still completes — the order the database runs it in does not
   * strand a template behind a message it is about to delete anyway.
   */
  it('lets a whole org be deleted with its templates and the messages that name them', async () => {
    const [{ id: gone }] = await db.driver.select<{ id: string }>(`INSERT INTO orgs (name) VALUES ('Leaving') RETURNING id`)
    const [{ id: tpl }] = await db.driver.select<{ id: string }>(
      `INSERT INTO message_templates (org_id, channel, external_id, sender_id, category, body)
       VALUES ($1, 'sms', '1', 'ACMEIN', 'promotional', 'Hi') RETURNING id`,
      [gone],
    )
    const [{ id: co }] = await db.driver.select<{ id: string }>(
      `INSERT INTO companies (org_id, domain) VALUES ($1, 'leaving.in') RETURNING id`, [gone],
    )
    await db.driver.select(
      `INSERT INTO touches (org_id, company_id, channel, direction, status, template_id)
       VALUES ($1, $2, 'sms', 'out', 'awaiting_approval', $3) RETURNING id`,
      [gone, co, tpl],
    )
    await db.driver.select(`DELETE FROM orgs WHERE id = $1 RETURNING id`, [gone])
    const left = await db.driver.select<{ n: number }>(`SELECT count(*)::int AS n FROM message_templates WHERE org_id = $1`, [gone])
    expect(left[0]?.n).toBe(0)
  })
})
