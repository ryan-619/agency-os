/**
 * Reverting 0019 and applying it again must leave every SMS sent before the
 * revert writable (review round 4, [11]).
 *
 * The down drops `touches.template_id`, the up adds it back NULL, and a CHECK
 * is evaluated on EVERY later UPDATE of a row, `NOT VALID` or not. A first
 * version of `touches_sms_and_whatsapp_name_a_template` bound `sent` too, so
 * after one rollback-and-redeploy every earlier SMS became un-updatable: its
 * delivery report answered 500, its recipient could not be erased, and its
 * contact could not be deleted (ON DELETE SET NULL is an UPDATE). The CHECK
 * now binds only the statuses the sender can still carry to a provider.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { freshDb, migrations, type TestDb } from './helpers.js'
import { migrateUp, migrateDown } from '../src/migrator.js'

describe('0019 down, then up, over a sent SMS', () => {
  let db: TestDb
  let orgId: string
  let contactId: string
  let sentId: string
  let draftId: string

  beforeAll(async () => {
    db = await freshDb()
    await migrateUp(db.driver, migrations())
    ;[{ id: orgId }] = await db.driver.select<{ id: string }>(`INSERT INTO orgs (name) VALUES ('Agency') RETURNING id`)
    const [{ id: companyId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO companies (org_id, domain) VALUES ($1, 'acme.in') RETURNING id`, [orgId],
    )
    ;[{ id: contactId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO contacts (org_id, company_id, phone) VALUES ($1, $2, '+919812345678') RETURNING id`, [orgId, companyId],
    )
    const [{ id: campaignId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO campaigns (org_id, name, channel, status) VALUES ($1, 'Reminders', 'sms', 'active') RETURNING id`, [orgId],
    )
    const [{ id: tpl }] = await db.driver.select<{ id: string }>(
      `INSERT INTO message_templates (org_id, channel, external_id, sender_id, category, body)
       VALUES ($1, 'sms', '1107160000000012345', 'ACMEIN', 'service_explicit', 'Hi {#var#}') RETURNING id`, [orgId],
    )
    ;[{ id: sentId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO touches (org_id, campaign_id, contact_id, company_id, channel, direction, status, template_id,
                            body, recipient, provider_id, sent_at)
       VALUES ($1, $2, $3, $4, 'sms', 'out', 'sent', $5, 'Hi Priya', '+919812345678', 'ds-1', now()) RETURNING id`,
      [orgId, campaignId, contactId, companyId, tpl],
    )
    ;[{ id: draftId }] = await db.driver.select<{ id: string }>(
      `INSERT INTO touches (org_id, campaign_id, contact_id, company_id, channel, direction, status, template_id, body)
       VALUES ($1, $2, $3, $4, 'sms', 'out', 'awaiting_approval', $5, 'Hi Priya') RETURNING id`,
      [orgId, campaignId, contactId, companyId, tpl],
    )

    // Down to and including 0019: the migrator reverts newest first, so any
    // migration written after 0019 goes before it, and comes back with it.
    const steps = migrations().filter((m) => m.version >= '0019').length
    const reverted = await migrateDown(db.driver, migrations(), steps)
    expect(reverted.at(-1)).toBe('0019')
    expect(reverted).toHaveLength(steps)
    await migrateUp(db.driver, migrations())
  }, 120_000)

  afterAll(async () => { await db?.close() })

  it('really did lose the link: the rows came back with no template', async () => {
    const rows = await db.driver.select<{ id: string; template_id: string | null }>(
      `SELECT id, template_id FROM touches WHERE id = ANY($1::uuid[])`, [[sentId, draftId]],
    )
    expect(rows.map((r) => r.template_id)).toEqual([null, null])
  })

  it('lets a delivery report land on a sent SMS', async () => {
    const rows = await db.driver.select<{ id: string }>(
      `UPDATE touches SET delivery_status = 'delivered', delivered_at = now() WHERE id = $1 RETURNING id`, [sentId],
    )
    expect(rows).toHaveLength(1)
  })

  it('settled the draft that could still go out: refused no_template, saying why', async () => {
    const [row] = await db.driver.select<{ status: string; refusal_code: string | null; error: string | null }>(
      `SELECT status, refusal_code, error FROM touches WHERE id = $1`, [draftId],
    )
    expect(row).toMatchObject({ status: 'refused', refusal_code: 'no_template' })
    expect(row?.error).toContain('0019 was reverted')
  })

  it('still refuses to put a template-less SMS back where it could go out', async () => {
    await expect(
      db.driver.select(
        `UPDATE touches SET status = 'queued', refusal_code = NULL WHERE id = $1`, [draftId],
      ),
    ).rejects.toThrow(/touches_sms_and_whatsapp_name_a_template/)
  })

  it('lets an erasure blank its recipient, and the contact be deleted', async () => {
    expect(await db.driver.select(`UPDATE touches SET recipient = NULL WHERE id = $1 RETURNING id`, [sentId])).toHaveLength(1)
    expect(await db.driver.select(`DELETE FROM contacts WHERE id = $1 RETURNING id`, [contactId])).toHaveLength(1)
  })
})
