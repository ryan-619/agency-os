/**
 * What /campaigns says about an SMS campaign (0019), in one place.
 *
 * An SMS campaign is not cold outreach and is never filled by enrolment: it
 * is where an SMS's daily cap and quiet hours live, and each SMS under it is
 * drafted per person — from a registered DLT template, to somebody with a
 * recorded SMS opt-in — and approved by a person. The database refuses
 * auto-send on one (`campaigns_no_auto_send_on_voice_or_sms`), and so does
 * `campaignInput`, with a sentence; the form says so before either is asked.
 *
 * Pure strings, so `apps/web/test/campaigns-sms.test.ts` can pin them.
 */

/** Under the channel select. */
export const CHANNEL_HINT =
  'Cold outreach is email and LinkedIn only, and enrolment fills those two. An SMS campaign is for people with a ' +
  'recorded SMS opt-in: each SMS is drafted per person from a registered template, with Draft SMS on /contacts, and ' +
  'approved by a person. Voice and WhatsApp are not offered.'

/** Beside the auto-send box on an SMS campaign, which cannot be ticked. */
export const SMS_AUTO_SEND_OFF =
  'Never, on SMS: every SMS is approved by a person on /approvals before it is sent, and it goes only to people with a ' +
  'recorded SMS opt-in.'

/** On an SMS campaign's card, where the enrol button would be. */
export const SMS_NOT_ENROLLED =
  'Enrolment does not fill an SMS campaign. Each SMS is drafted per person, from a registered template, with Draft SMS ' +
  'on /contacts — only to people with a recorded SMS opt-in — and waits on /approvals for a person.'
