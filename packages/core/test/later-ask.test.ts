/** A reply that asks to be contacted later, read into a day (`src/later-ask.ts`). */
import { describe, expect, it } from 'vitest'
import { DIWALI, LATER_ASK_MAX_DAYS, instantAtWallClock, laterAsk } from '../src/index.js'

// A Thursday.
const TODAY = '2026-10-08'
const read = (text: string, today = TODAY) => laterAsk(text, today)

describe('laterAsk', () => {
  it.each([
    ['Call me tomorrow', 'tomorrow', '2026-10-09'],
    ['Can you call me the day after tomorrow?', 'the day after tomorrow', '2026-10-10'],
    ['Please call on Monday', 'on Monday', '2026-10-12'],
    ['Busy this week. Try me next Thursday', 'on Thursday', '2026-10-15'],
    ['Can we talk next week?', 'next week', '2026-10-15'],
    ['Get back to me in two weeks', 'in 2 weeks', '2026-10-22'],
    ['Ping me in a fortnight', 'in 2 weeks', '2026-10-22'],
    ['Please contact us after 10 days', 'in 10 days', '2026-10-18'],
    ['Reach out in a couple of months', 'in 2 months', '2026-12-08'],
    ['Call me next month', 'next month', '2026-11-01'],
    ['Not now, maybe after this month', 'after this month', '2026-11-01'],
    ['We can discuss next quarter', 'next quarter', '2027-01-01'],
    ['Not right now — try again next year', 'after the new year', '2027-01-02'],
    ['Very busy till Diwali, please call after Diwali', 'after Diwali', '2026-11-15'],
    ['Talk in March', 'in March', '2027-03-01'],
    ['Let’s connect after March', 'after March', '2027-04-01'],
    ['Maybe mid January', 'in mid-January', '2027-01-15'],
    ['Call after the 15th', 'after the 15th', '2026-10-16'],
    ['Can you call me on 20th November?', 'on the 20th of November', '2026-11-20'],
    ['Write to me after 5 Dec', 'after 5 December', '2026-12-06'],
    ['I am travelling for 3 weeks', 'in 3 weeks', '2026-10-29'],
    ['On leave from 20th Oct to 5th Nov, please contact me after 5th Nov', 'after the 5th of November', '2026-11-06'],
    ['Out of station till 25 October. Call then', 'after 25 October', '2026-10-26'],
    ['Call me tomorrow, I am away next week', 'tomorrow', '2026-10-09'],
  ])('%s → %s', (text, phrase, day) => {
    expect(read(text)).toEqual({ phrase, day })
  })

  it('reads nothing without a time, or without anybody asking to be contacted', () => {
    for (const text of [
      'Call me later',
      'Sounds good, call me',
      'We launched next to the station in March',
      'Our clinic opened 2 months ago',
      'Thanks for the report.',
      'We are fully booked next month',
      'You may send the details.',
    ]) expect(read(text), text).toBeNull()
  })

  it('reads nothing that is negated', () => {
    expect(read('Please don’t call me next week')).toBeNull()
    expect(read('Do not contact us next month')).toBeNull()
  })

  it('reads nothing from a reply that turns an ask around ANYWHERE before it, or asks to be left alone (review, 2026-10-08)', () => {
    for (const text of [
      // The negation more than two words back — the first version read each of these as a day to call.
      'I don’t want you to call me next week',
      'Please do not ever bother to email me again next month',
      'We never asked anybody to contact us in March',
      // Turned around in one sentence, and a day named in another.
      'Don’t call. Maybe in March.',
      'Stop calling me. Try in March',
      'Leave us alone, we might talk after Diwali',
      // Removal or departure, in the broad reader's words.
      'Please remove me from your list. Maybe call in March',
      'I have left the company — contact me after March and I will point you to the right person',
      'Unsubscribe. Perhaps next quarter.',
    ]) expect(read(text), text).toBeNull()
  })

  it('still reads an ask whose clause carries no negation, and the polite phrases that only look like one', () => {
    expect(read('I don’t have time now, call me next month')).toEqual({ phrase: 'next month', day: '2026-11-01' })
    expect(read('Don’t hesitate to call me next week')).toMatchObject({ phrase: 'next week' })
    expect(read('Feel free to stop by and talk next week')).toMatchObject({ phrase: 'next week' })
    expect(read('Never mind the price, call me tomorrow')).toMatchObject({ phrase: 'tomorrow' })
  })

  it('reads the first sentence that asks, line by line, and never a day that has passed or is too far', () => {
    expect(read('Thanks.\nToo busy now.\nCall next month please')).toEqual({ phrase: 'next month', day: '2026-11-01' })
    expect(read('Call me on 3rd October', '2026-10-08')).toEqual({ phrase: 'on the 3rd of October', day: '2027-10-03' })
    expect(read('Call me after 13 months', TODAY)).toBeNull()
    expect(LATER_ASK_MAX_DAYS).toBe(400)
  })

  it('does not read May the verb as May the month, nor this month as "in October"', () => {
    expect(read('You may call me')).toBeNull()
    expect(read('Talk in October')).toBeNull()
    expect(read('Call in May')).toEqual({ phrase: 'in May', day: '2027-05-01' })
  })

  it('knows Diwali only for the years it lists', () => {
    expect(Object.keys(DIWALI)).toEqual(['2026', '2027', '2028'])
    expect(read('Call after Diwali', '2029-06-01')).toBeNull()
  })

  it('turns a day into 10:00 where the person is', () => {
    expect(instantAtWallClock('2026-11-01', '10:00', 'Asia/Kolkata')?.toISOString()).toBe('2026-11-01T04:30:00.000Z')
    // New York switches back on 1 November 2026: 10:00 that morning is EST.
    expect(instantAtWallClock('2026-11-01', '10:00', 'America/New_York')?.toISOString()).toBe('2026-11-01T15:00:00.000Z')
    expect(instantAtWallClock('2026-11-01', '10:00', 'Not/AZone')).toBeNull()
  })
})
