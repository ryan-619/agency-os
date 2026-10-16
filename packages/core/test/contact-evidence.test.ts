/**
 * True data only (2026-10-13): the readers that say whether something real
 * SHOWS an address, a number, a person or a website — never what a model
 * composed. Every case that matters here is one that happened: a person made
 * up whole (`security@carbonmaps.io`), an address guessed from a LinkedIn
 * profile (`akash@farmley.com`), a website invented for a café
 * (`yummybites-delhi.business.site`), and connectors that refused every call
 * and kept being called. Each reader is tested in both directions, and on the
 * input a hostile page could send it.
 */
import { describe, expect, it } from 'vitest'
import {
  ADDRESS_SOURCE_MAX, ADDRESS_SOURCE_PATTERN, ROLE_LOCAL_PARTS, addressSourceWords, connectorFailureKind,
  connectorResultFailure, findEmailsIn, findPhonesIn, isAddressSource, isRoleAddress, isShutDownHost, maskAddress,
  maskPhone, pageLabel, pageLinks, readablePathProblem, textNamesPerson, textShowsDomain, textShowsEmail,
  textShowsPhone,
} from '../src/index.js'

const IN = { defaultCountry: 'IN' } as const

/** Milliseconds a call takes; the adversarial inputs below must stay linear. */
function timed(fn: () => unknown): number {
  const started = performance.now()
  fn()
  return performance.now() - started
}

// ---------------------------------------------------------------------------
// Email addresses
// ---------------------------------------------------------------------------

describe('findEmailsIn and textShowsEmail — what happened', () => {
  it('finds no address on a page that names nobody — security@carbonmaps.io was made up', () => {
    const page =
      'Carbon Maps — measure and reduce the environmental footprint of your food products. ' +
      'Talk to our team through the contact form. Security matters to us: we are ISO 27001 aligned.'
    expect(findEmailsIn(page)).toEqual([])
    expect(textShowsEmail(page, 'security@carbonmaps.io')).toBe(false)
  })

  it('finds no address in a LinkedIn snippet that names the person and the company but no address', () => {
    const snippet =
      'Akash Gupta - Co-founder & CEO - Farmley | LinkedIn. Akash Gupta. Co-founder at Farmley (farmley.com). ' +
      'New Delhi, Delhi, India. 500+ connections.'
    expect(findEmailsIn(snippet)).toEqual([])
    expect(textShowsEmail(snippet, 'akash@farmley.com')).toBe(false)
    expect(textShowsEmail(snippet, 'abhishek@farmley.com')).toBe(false)
  })

  it('reads the bracketed obfuscations a business writes to keep robots off its address', () => {
    for (const text of [
      'Write to info [at] 127atelier [dot] in for orders',
      'Write to info [ at ] 127atelier [ dot ] in',
      'info(at)127atelier.in',
      'info (at) 127atelier (dot) in',
      'info{at}127atelier{dot}in',
      'info&#64;127atelier&#46;in',
      'info&#x40;127atelier.in',
      'info&commat;127atelier&period;in',
      'INFO AT 127atelier DOT in',
      'info AT 127atelier DOT in',
    ]) {
      expect(findEmailsIn(text), text).toEqual(['info@127atelier.in'])
      expect(textShowsEmail(text, 'info@127atelier.in'), text).toBe(true)
    }
  })

  it('does not read a sentence as an address: "write to us at farmley dot com" names nobody', () => {
    for (const text of ['Write to us at farmley dot com', 'info at 127atelier dot in', 'Meet us at the store.']) {
      expect(findEmailsIn(text), text).toEqual([])
    }
    expect(textShowsEmail('Write to us at farmley dot com', 'us@farmley.com')).toBe(false)
  })

  it('reads a shouted spelled-out address only for a role inbox: "EMAIL US AT ACME DOT COM" names nobody', () => {
    for (const text of ['EMAIL US AT ACME DOT COM', 'CONTACT US AT 127ATELIER DOT IN', 'SHOP NOW AT ACME DOT COM']) {
      expect(findEmailsIn(text), text).toEqual([])
    }
    expect(findEmailsIn('WRITE TO INFO AT ACME DOT COM')).toEqual(['info@acme.com'])
    expect(findEmailsIn('akash AT farmley DOT com')).toEqual(['akash@farmley.com'])
  })

  it('reads a domain up to where run-together text had a break, and finds the address the page showed', () => {
    // Read whole, these were info@acme.inphone and info@acme.in.call — addresses nobody published.
    expect(findEmailsIn('Email: info@acme.inPhone: 98765 43210')).toEqual(['info@acme.in'])
    expect(findEmailsIn('Write to info@acme.in.Call us today')).toEqual(['info@acme.in'])
    expect(textShowsEmail('Email: info@acme.inPhone: 98765 43210', 'info@acme.in')).toBe(true)
    // A capital the address itself carries is not a break.
    expect(findEmailsIn('Mail Info@MyCompany.com or SALES@ACME.IN or hello@Acme.In')).toEqual([
      'info@mycompany.com', 'sales@acme.in', 'hello@acme.in',
    ])
  })

  it('reads a mailto link: percent-escapes undone, its query left off, several addresses split', () => {
    expect(findEmailsIn('<a href="mailto:hello%40mokobara.com?subject=Hi%20there">Mail us</a>')).toEqual([
      'hello@mokobara.com',
    ])
    expect(findEmailsIn('<a href="MAILTO:Hello@Mokobara.com?subject=x&body=y">')).toEqual(['hello@mokobara.com'])
    expect(findEmailsIn('<a href="mailto:sales%2Bin@acme.in">')).toEqual(['sales+in@acme.in'])
    expect(findEmailsIn('<a href="mailto:a@acme.in,b@acme.in">')).toEqual(['a@acme.in', 'b@acme.in'])
    expect(findEmailsIn('<a href="mailto:%20info@acme.in">')).toEqual(['info@acme.in'])
    expect(findEmailsIn('<a href="https://x.in/share?to=a%40acme.in%2Cb%40acme.in">')).toEqual(['a@acme.in', 'b@acme.in'])
    expect(textShowsEmail('<a href="mailto:hello%40mokobara.com?subject=Hi">', 'HELLO@mokobara.com')).toBe(true)
  })

  it('never returns an image name, a placeholder, a package version or a tracker as an address', () => {
    const page = [
      '<img src="/cdn/logo@2x.png" srcset="/hero@3x.webp 3x, /icon@2x.SVG 2x">',
      '<link href="/fonts/inter@1.woff2"><script src="/jquery@3.6.0.min.js"></script>',
      'Enter your email: you@example.com or name@yourdomain.com — test@test.com',
      'import React from "react@18.3.1"; "@babel/core@7.24.0" lodash@4.17.21',
      'Sentry.init({ dsn: "https://f0e1d2c3b4a5@o123456.ingest.sentry.io/4504" })',
      '<script>window.__s = "8f3a2b1c@sentry-next.wixpress.com"; x = "abc@sentry.io"</script>',
    ].join('\n')
    expect(findEmailsIn(page)).toEqual([])
  })

  it('keeps the whole local part, underscores and dots and plus signs included', () => {
    expect(findEmailsIn('Email first_last@acme.co.in or john.doe@acme.io or ops+india@acme.io')).toEqual([
      'first_last@acme.co.in', 'john.doe@acme.io', 'ops+india@acme.io',
    ])
    // Read without the underscore, this was `last@acme.co.in` — a guess at somebody else.
    expect(textShowsEmail('first_last@acme.co.in', 'last@acme.co.in')).toBe(false)
  })

  it('reads an address out of JSON a page embeds, without the escape glued to it', () => {
    const json = '{"html":"\\u003ca href=\\"mailto:info@acme.in\\"\\u003einfo@acme.in\\u003c/a\\u003e"}'
    expect(findEmailsIn(json)).toEqual(['info@acme.in'])
    expect(findEmailsIn('"contact":"hello\\u0040acme.in"')).toEqual(['hello@acme.in'])
  })

  it('normalises, dedupes across case and links, and lists addresses in the order the page shows them', () => {
    expect(findEmailsIn('Sales: b@acme.in. Support: <a href="mailto:a@acme.in">a@acme.in</a>, B@ACME.IN')).toEqual([
      'b@acme.in', 'a@acme.in',
    ])
    expect(findEmailsIn('Write to hello@mokobara.com.')).toEqual(['hello@mokobara.com'])
    expect(findEmailsIn("'quoted@acme.in'")).toEqual(['quoted@acme.in'])
  })

  it('refuses what is not an address: no top-level domain, a numeric one, a local part past 64 characters', () => {
    expect(findEmailsIn('user@localhost and a@b.c and x@1.2.3.4')).toEqual([])
    expect(findEmailsIn(`${'a'.repeat(65)}@acme.in`)).toEqual([])
    expect(findEmailsIn(`${'a'.repeat(64)}@acme.in`)).toEqual([`${'a'.repeat(64)}@acme.in`])
  })

  it('shows only the address itself — never a longer or shorter one around it', () => {
    const text = 'Write to akash@farmley.com'
    expect(textShowsEmail(text, 'akash@farmley.com')).toBe(true)
    expect(textShowsEmail(text, 'kash@farmley.com')).toBe(false)
    expect(textShowsEmail(text, 'akash@farmley.co')).toBe(false)
    expect(textShowsEmail(text, 'not an address')).toBe(false)
    expect(textShowsEmail(text, '')).toBe(false)
  })

  it('reads a hostile page in linear time', () => {
    expect(timed(() => findEmailsIn('a'.repeat(600_000)))).toBeLessThan(500)
    expect(timed(() => findEmailsIn('a@'.repeat(300_000)))).toBeLessThan(500)
    expect(timed(() => findEmailsIn(`${' '.repeat(300_000)}x`))).toBeLessThan(500)
    expect(timed(() => findEmailsIn('[ at'.repeat(150_000)))).toBeLessThan(500)
    expect(timed(() => findEmailsIn('abc AT '.repeat(80_000)))).toBeLessThan(500)
    expect(timed(() => findEmailsIn('a.'.repeat(300_000)))).toBeLessThan(500)
    const many = Array.from({ length: 40_000 }, (_, i) => `p${i}@acme.in`).join(' ')
    expect(timed(() => expect(findEmailsIn(many)).toHaveLength(40_000))).toBeLessThan(1000)
  })
})

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

describe('findPhonesIn', () => {
  it('reads an Indian mobile however it is written, under defaultCountry IN', () => {
    for (const text of [
      '98765 43210', '9876543210', '98765-43210', '987 654 3210', '98765.43210',
      '+91 98765 43210', '+91-98765-43210', '+919876543210', '+91 (98765) 43210', '(+91) 98765 43210',
      '0 98765 43210', '098765 43210', '09876543210', '0091 98765 43210', '00 91 98765 43210',
      '91 98765 43210', '919876543210', 'Mob:-9876543210', 'Ph.98765 43210', 'Mobile No. 9876543210',
      'Call us on 98765 43210', 'WhatsApp: 98765 43210',
    ]) {
      expect(findPhonesIn(text, IN), text).toEqual(['+919876543210'])
    }
  })

  it('reads an Indian landline with its trunk 0 and STD code — brackets, spaces and dashes alike', () => {
    for (const text of ['(022) 2345 6789', '022-2345-6789', '022 2345 6789', '022-23456789', '(022)-23456789', '022 23456789']) {
      expect(findPhonesIn(text, IN), text).toEqual(['+912223456789'])
    }
    expect(findPhonesIn('011-41234567', IN)).toEqual(['+911141234567'])
    expect(findPhonesIn('0124 456 7890', IN)).toEqual(['+911244567890'])
    expect(findPhonesIn('(080) 4567-8901', IN)).toEqual(['+918045678901'])
    expect(findPhonesIn('+91 22 2345 6789', IN)).toEqual(['+912223456789'])
    expect(findPhonesIn('Toll free 1800 123 4567', IN)).toEqual(['+9118001234567'])
  })

  it('guesses no country without defaultCountry: a number with no country code is not read', () => {
    expect(findPhonesIn('98765 43210')).toEqual([])
    expect(findPhonesIn('(022) 2345 6789')).toEqual([])
    expect(findPhonesIn('tel:09876543210')).toEqual([])
    expect(findPhonesIn('+91 98765 43210')).toEqual(['+919876543210'])
  })

  it('reads no number from an order id, an invoice, a year, a price, a PIN code or a product code', () => {
    for (const text of [
      'Order #1234567890', 'Order ID: 9876543210', 'order no. 98765 43210', 'Invoice 202610110001', 'INV-9876543210',
      'Ref: 9876543210', 'Tracking AWB 9876543210', 'Copyright 2024', '© 2019–2024 Acme', 'since 1998 2005 2010',
      'Price ₹12,999', 'Rs. 4999/-', '₹ 98765 43210', '₹9876543210', 'MRP: 9876543210', '$9876543210',
      'GSTIN 27AAAPL1234C1ZV', 'PIN 400001', 'Mumbai 400001', 'ISBN 978-3-16-148410-0', 'SKU9876543210',
      'v1.9876543210', '9876543210abc', '9876543210@ybl', 'https://acme.in/p/9876543210', 'data-id="9876543210"',
      '"product_id": 9876543210', 'timestamp 1697040000', 'Date 2026-10-11 12:30', 'lat 19.0760, long 72.8777',
      '0.9876543210', 'tracking 1Z999AA10123456784', 'Aadhaar 9198 7654 3210',
    ]) {
      expect(findPhonesIn(text, IN), text).toEqual([])
    }
  })

  it('reads a number written with its country code to exactly its length — never the hours after it', () => {
    // This read +91987654321010: the "(10" of "(10am" taken as two more digits.
    expect(findPhonesIn('Call +91 98765 43210 (10am-7pm)')).toEqual(['+919876543210'])
    expect(findPhonesIn('+91 98765 43210 - 2024')).toEqual(['+919876543210'])
    expect(findPhonesIn('+91 98765 43210 98765 43211')).toEqual(['+919876543210'])
    expect(findPhonesIn('+91 98765 43210 98765 43211', IN)).toEqual(['+919876543210', '+919876543211'])
    expect(findPhonesIn('+1 415 555 0132 ext 12', IN)).toEqual(['+14155550132'])
    expect(findPhonesIn('+1 (415) 555-0132')).toEqual(['+14155550132'])
    expect(findPhonesIn('+44 20 7946 0958 (9am-5pm)')).toEqual(['+442079460958'])
    expect(findPhonesIn('+44 (0)20 7946 0958')).toEqual(['+442079460958'])
    expect(findPhonesIn('0044 20 7946 0958')).toEqual(['+442079460958'])
    expect(findPhonesIn('+971 50 123 4567')).toEqual(['+971501234567'])
    expect(findPhonesIn('+91 98765 4321')).toEqual([])
  })

  it('reads a +country number once, never again as an Indian one inside it', () => {
    expect(findPhonesIn('+44 20 7946 0958', IN)).toEqual(['+442079460958'])
    expect(findPhonesIn('+1 415 555 0132', IN)).toEqual(['+14155550132'])
  })

  it('reads tel: and WhatsApp links, and lists every number once, in the order the page shows them', () => {
    expect(findPhonesIn('<a href="tel:+919876543210">Call</a>')).toEqual(['+919876543210'])
    expect(findPhonesIn('<a href="tel:098765%2043210">Call</a>', IN)).toEqual(['+919876543210'])
    expect(findPhonesIn('https://wa.me/919876543210')).toEqual(['+919876543210'])
    expect(findPhonesIn('https://api.whatsapp.com/send?phone=919876543210&text=hi')).toEqual(['+919876543210'])
    expect(findPhonesIn('https://api.whatsapp.com/send?text=hi&phone=919876543210')).toEqual(['+919876543210'])
    expect(findPhonesIn('whatsapp://send?phone=+919876543210')).toEqual(['+919876543210'])
    // An Indian page that left the 91 off its WhatsApp link still means its own mobile.
    expect(findPhonesIn('https://wa.me/9876543210', IN)).toEqual(['+919876543210'])
    const page =
      'Office: (022) 2345 6789 · <a href="tel:+919876543210">98765 43210</a> · ' +
      '<a href="https://wa.me/919876543210">WhatsApp</a> · Sales 99999 88888'
    expect(findPhonesIn(page, IN)).toEqual(['+912223456789', '+919876543210', '+919999988888'])
  })

  it('reads two numbers written one after the other as two', () => {
    expect(findPhonesIn('call 98765-43210 or 99999 88888', IN)).toEqual(['+919876543210', '+919999988888'])
    expect(findPhonesIn('98765 43210 / 99999 88888', IN)).toEqual(['+919876543210', '+919999988888'])
    expect(findPhonesIn('Ph: 022 2345 6789, 98765 43210', IN)).toEqual(['+912223456789', '+919876543210'])
  })

  it('reads a hostile page in linear time', () => {
    expect(timed(() => findPhonesIn('9 '.repeat(300_000), IN))).toBeLessThan(1000)
    expect(timed(() => findPhonesIn('9'.repeat(600_000), IN))).toBeLessThan(500)
    expect(timed(() => findPhonesIn('+1'.repeat(300_000), IN))).toBeLessThan(1000)
    expect(timed(() => findPhonesIn('api.whatsapp.com/send?'.repeat(25_000)))).toBeLessThan(500)
  })
})

describe('textShowsPhone', () => {
  const wanted = '+919876543210'

  it('sees the number however the text writes it', () => {
    for (const text of [
      '+91 98765 43210', '+91-98765-43210', '(+91) 98765-43210', '0091 98765 43210', '+919876543210', '919876543210',
      '98765 43210', '98765-43210', '98765.43210', '9876543210', '098765 43210', '0 98765 43210', '987 654 3210',
      'tel:+919876543210', 'https://wa.me/919876543210', 'Call 98765 43210 - 10am to 7pm', 'Mobile:98765 43210.',
    ]) {
      expect(textShowsPhone(text, wanted), text).toBe(true)
    }
    expect(textShowsPhone('(022) 2345 6789', '+912223456789')).toBe(true)
    expect(textShowsPhone('022-2345-6789', '+912223456789')).toBe(true)
    expect(textShowsPhone('<a href="tel:098765%2043210">', wanted, IN)).toBe(true)
    expect(textShowsPhone('+44 (0)20 7946 0958', '+442079460958')).toBe(true)
    expect(textShowsPhone('020 7946 0958', '+442079460958')).toBe(true)
    expect(textShowsPhone('Toll free 1800 123 4567', '+9118001234567')).toBe(true)
  })

  it('never sees it in another number, a shorter one or the tail of a longer one', () => {
    for (const text of [
      'Invoice 202419876543210', 'Reach us: 1987654321098765 43210', 'order 4398765432101', '98765 4321',
      '+91 98765 43211', '9876543211', '', 'no numbers here',
    ]) {
      expect(textShowsPhone(text, wanted), text).toBe(false)
    }
    // The area code is part of the number: 515 is not 415.
    expect(textShowsPhone('+1 (515) 555-0132', '+14155550132')).toBe(false)
    expect(textShowsPhone('555-0132', '+14155550132')).toBe(false)
  })

  it('answers false for a number that is not one', () => {
    expect(textShowsPhone('98765 43210', '98765 43210')).toBe(false)
    expect(textShowsPhone('98765 43210', 'call me')).toBe(false)
  })

  it('reads a hostile text in linear time', () => {
    expect(timed(() => textShowsPhone('9 '.repeat(300_000), wanted))).toBeLessThan(1500)
    expect(timed(() => textShowsPhone('1 '.repeat(300_000), wanted))).toBeLessThan(1500)
  })
})

// ---------------------------------------------------------------------------
// People and websites
// ---------------------------------------------------------------------------

describe('textNamesPerson', () => {
  it('finds every part of a name as a whole word, ignoring case and accents either way', () => {
    expect(textNamesPerson('José García, founder of 127 Atelier', 'Jose', 'Garcia')).toBe(true)
    expect(textNamesPerson('Jose Garcia, founder', 'José', 'García')).toBe(true)
    expect(textNamesPerson('ZOË SMITH — studio lead', 'Zoe', 'Smith')).toBe(true)
    expect(textNamesPerson('Talk to Pat O’Brien', 'Pat', "O'Brien")).toBe(true)
    expect(textNamesPerson('Mary-Jane Watson runs sales', 'Mary-Jane', 'Watson')).toBe(true)
    expect(textNamesPerson('आकाश गुप्ता, संस्थापक', 'आकाश', 'गुप्ता')).toBe(true)
  })

  it('refuses a name the text does not show whole', () => {
    expect(textNamesPerson('Akashdeep Gupta', 'Akash', 'Gupta')).toBe(false)
    expect(textNamesPerson('Ravindra Kumar', 'Ravi', 'Kumar')).toBe(false)
    expect(textNamesPerson('Akash from Farmley', 'Akash', 'Gupta')).toBe(false)
    // The case that happened: a whole person made up, named nowhere.
    expect(textNamesPerson('Carbon Maps measures food footprints.', 'Alex', 'Chen')).toBe(false)
    expect(textNamesPerson('आकाशवाणी', 'आकाश', null)).toBe(false)
  })

  it('checks only the parts it is given, and parts of two letters or more', () => {
    expect(textNamesPerson('Akash runs Farmley', 'Akash', null)).toBe(true)
    expect(textNamesPerson('Mr Gupta', null, 'Gupta')).toBe(true)
    expect(textNamesPerson('Gupta & Co', 'A.', 'Gupta')).toBe(true)
    expect(textNamesPerson('anything at all', null, null)).toBe(false)
    expect(textNamesPerson('anything at all', '', '  ')).toBe(false)
    expect(textNamesPerson('anything at all', 'A', 'K')).toBe(false)
  })

  it('reads a long text in linear time', () => {
    expect(timed(() => textNamesPerson('ab '.repeat(200_000), 'Akash', 'Gupta'))).toBeLessThan(500)
  })
})

describe('textShowsDomain', () => {
  it('finds a host on a host boundary: plain, in a URL, behind www and under a subdomain', () => {
    for (const text of [
      '127atelier.in', 'Visit 127atelier.in.', 'https://www.127atelier.in/pages/about', 'https://127atelier.in',
      'shop.127atelier.in', '127ATELIER.IN', 'info@127atelier.in', '(127atelier.in)',
    ]) {
      expect(textShowsDomain(text, '127atelier.in'), text).toBe(true)
    }
    expect(textShowsDomain('https://www.127atelier.in/x', 'https://www.127atelier.in/pages/contact')).toBe(true)
  })

  it('never inside a longer host, nor as the start of somebody else’s', () => {
    for (const text of [
      'x127atelier.in', 'my-127atelier.in', '127atelier.in.evil.com', 'https://127atelier.in.evil.com/', '127atelier.india',
      '127atelier.in-shop.com', 'atelier.in', '',
    ]) {
      expect(textShowsDomain(text, '127atelier.in'), text).toBe(false)
    }
  })

  it('answers false for a domain that is not one', () => {
    expect(textShowsDomain('anything', 'not a domain')).toBe(false)
    expect(textShowsDomain('anything', '')).toBe(false)
  })

  it('reads a long run of dotted labels in linear time', () => {
    expect(timed(() => textShowsDomain('a.'.repeat(300_000), '127atelier.in'))).toBeLessThan(500)
  })
})

describe('isShutDownHost', () => {
  it('names Google Business Profile websites, shut down in 2024', () => {
    for (const host of [
      'business.site', 'yummybites-delhi.business.site', 'MYRAHSPA.BUSINESS.SITE', 'cafe.business.site.',
      'https://yummybites-delhi.business.site/', 'www.cafe.business.site',
    ]) {
      expect(isShutDownHost(host), host).toBe(true)
    }
  })

  it('leaves every other host alone', () => {
    for (const host of ['notbusiness.site', 'business.site.example.com', 'myrahspa-mumbai.co', '127atelier.in', '']) {
      expect(isShutDownHost(host), host).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Role inboxes and masking
// ---------------------------------------------------------------------------

describe('isRoleAddress and maskAddress', () => {
  it('knows a business’s published inbox from a person’s', () => {
    for (const email of ['info@127atelier.in', 'Hello@Mokobara.com', 'customer.care@acme.in', 'contact-us@acme.in', 'sales@acme.in']) {
      expect(isRoleAddress(email), email).toBe(true)
    }
    for (const email of ['akash@farmley.com', 'info.akash@acme.in', 'bala@vahdamteas.com', 'not an address']) {
      expect(isRoleAddress(email), email).toBe(false)
    }
    for (const part of ['info', 'hello', 'contact', 'sales', 'support', 'enquiry', 'bookings', 'careers']) {
      expect(ROLE_LOCAL_PARTS.has(part), part).toBe(true)
    }
  })

  it('shows a role inbox whole and a person’s address as its first letter and domain', () => {
    expect(maskAddress('info@127atelier.in')).toBe('info@127atelier.in')
    expect(maskAddress(' Akash@Farmley.com ')).toBe('a…@farmley.com')
    expect(maskAddress('bala@vahdamteas.com')).toBe('b…@vahdamteas.com')
    expect(maskAddress('@farmley.com')).toBe('…')
    expect(maskAddress('nothing')).toBe('…')
  })
})

describe('maskPhone', () => {
  it('shows the country code and the last four digits, with the country code read whole', () => {
    expect(maskPhone('+919876543210')).toBe('+91…3210')
    expect(maskPhone('+1 415 555 0132')).toBe('+1…0132')
    expect(maskPhone('+442079460958')).toBe('+44…0958')
    expect(maskPhone('+971501234567')).toBe('+971…4567')
    expect(maskPhone('+79161234567')).toBe('+7…4567')
    expect(maskPhone('98765 43210')).toBe('…')
  })
})

// ---------------------------------------------------------------------------
// Where an address came from
// ---------------------------------------------------------------------------

describe('isAddressSource and ADDRESS_SOURCE_PATTERN', () => {
  it('accepts every documented source', () => {
    for (const value of [
      'person', 'import', 'inbound', 'chat', 'connector:exa', 'connector:apollo', 'connector:my-server-2',
      'connector:0x', 'https://127atelier.in/pages/contact', 'http://acme.in', `https://acme.in/${'a'.repeat(2048 - 17)}`,
    ]) {
      expect(isAddressSource(value), value).toBe(true)
    }
  })

  it('refuses anything else', () => {
    for (const value of [
      'typed', 'Person', ' person', 'person ', 'chat\n', 'connector:', 'connector:Bad', 'connector:-x', 'connector:a_b',
      'ftp://x', 'https://', 'https://a b', 'mailto:info@acme.in', '', `https://acme.in/${'a'.repeat(2049 - 16)}`,
    ]) {
      expect(isAddressSource(value), JSON.stringify(value.slice(0, 40))).toBe(false)
    }
    expect(ADDRESS_SOURCE_MAX).toBe(2048)
  })

  it('is one anchored pattern the 0029 CHECK can use as it stands', () => {
    expect(ADDRESS_SOURCE_PATTERN.startsWith('^')).toBe(true)
    expect(ADDRESS_SOURCE_PATTERN.endsWith('$')).toBe(true)
    // No bound over 255, which a Postgres regex refuses: the length is a CHECK of its own.
    expect(ADDRESS_SOURCE_PATTERN).not.toMatch(/\{\d{3,}/)
    const re = new RegExp(ADDRESS_SOURCE_PATTERN)
    expect(re.test('connector:exa')).toBe(true)
    expect(re.test('xperson')).toBe(false)
  })
})

describe('addressSourceWords', () => {
  it('says where each address came from', () => {
    expect(addressSourceWords('https://www.127atelier.in/pages/contact/')).toEqual({
      words: 'seen on 127atelier.in/pages/contact', tone: 'ok',
    })
    expect(addressSourceWords('chat')).toEqual({ words: 'typed in chat by the person the assistant was helping', tone: 'ok' })
    expect(addressSourceWords('connector:exa').words).toMatch(/^returned by the exa connector/)
    expect(addressSourceWords('connector:exa').tone).toBe('ok')
    expect(addressSourceWords('person')).toEqual({ words: 'typed by a teammate', tone: 'ok' })
    expect(addressSourceWords('import')).toEqual({ words: 'from an import', tone: 'ok' })
    expect(addressSourceWords('inbound')).toEqual({ words: 'from a form they filled in', tone: 'ok' })
  })

  it('says when nobody recorded it, and warns of one the assistant added before sources were kept', () => {
    expect(addressSourceWords(null)).toEqual({ words: 'where it came from was not recorded', tone: 'ok' })
    expect(addressSourceWords(null, 'person')).toEqual({ words: 'where it came from was not recorded', tone: 'ok' })
    expect(addressSourceWords(null, 'agent')).toEqual({
      words: 'added by the assistant before sources were kept — check it before sending', tone: 'warn',
    })
    expect(addressSourceWords('typed')).toEqual({ words: 'where it came from was not recorded', tone: 'ok' })
    expect(addressSourceWords('connector:')).toEqual({ words: 'where it came from was not recorded', tone: 'ok' })
  })

  it('labels a page as a person reads it: host and path, no scheme or www, bounded', () => {
    expect(pageLabel('https://www.127atelier.in/')).toBe('127atelier.in')
    expect(pageLabel('https://127atelier.in/pages/contact?ref=x#top')).toBe('127atelier.in/pages/contact')
    const long = pageLabel(`https://acme.in/${'a'.repeat(200)}`)
    expect(long.length).toBe(80)
    expect(long.endsWith('…')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// What a page reader may be pointed at
// ---------------------------------------------------------------------------

describe('readablePathProblem', () => {
  const problem = (url: string) => readablePathProblem(new URL(url))

  it('reads public pages, a sitemap and security.txt', () => {
    for (const url of [
      'https://127atelier.in/', 'https://127atelier.in/pages/contact', 'https://acme.in/about-us.html',
      'https://acme.in/index.php?page=contact', 'https://acme.in/sitemap.xml', 'https://acme.in/sitemap_index.xml',
      'https://acme.in/post-sitemap.xml', 'https://acme.in/.well-known/security.txt', 'https://acme.in/robots.txt',
      'http://acme.in/team', 'https://acme.in:443/contact', 'http://acme.in:80/contact', 'https://acme.in/private-dining',
    ]) {
      expect(problem(url), url).toBeNull()
    }
  })

  it('never requests a hidden file, an admin or login page, a backup, a config or a dump', () => {
    for (const url of [
      'https://acme.in/.git/config', 'https://acme.in/.env', 'https://acme.in/.htaccess', 'https://acme.in/.DS_Store',
      'https://acme.in/.well-known/other', 'https://acme.in/.well-known/security.txt/more', 'https://acme.in/%2egit/HEAD',
      'https://acme.in/%252egit/HEAD', 'https://acme.in/wp-admin/', 'https://acme.in/wp-login.php',
      'https://acme.in/wp-config.php', 'https://acme.in/xmlrpc.php', 'https://acme.in/admin', 'https://acme.in/Admin/',
      'https://acme.in/admin.php', 'https://acme.in/administrator', 'https://acme.in/phpmyadmin/', 'https://acme.in/pma',
      'https://acme.in/server-status', 'https://acme.in/server-info', 'https://acme.in/cgi-bin/test.cgi',
      'https://acme.in/backup', 'https://acme.in/backups/', 'https://acme.in/config', 'https://acme.in/phpinfo.php',
      'https://acme.in/actuator/health',
    ]) {
      expect(problem(url), url).toMatch(/probe/)
    }
  })

  it('reads a segment as a server may: an escaped slash, a NUL, a space or a ;parameter hides nothing', () => {
    // Each of these walked past the first version's check.
    for (const url of [
      'https://acme.in/foo%2f.git%2fconfig', 'https://acme.in/foo%5c.env', 'https://acme.in/admin%00.html',
      'https://acme.in/admin%20', 'https://acme.in/admin;jsessionid=1', 'https://acme.in/%00.ssh/id_rsa',
      'https://acme.in/id_rsa', 'https://acme.in/home/.ssh/id_ed25519',
    ]) {
      expect(problem(url), url).toMatch(/probe/)
    }
    expect(problem('https://acme.in/menu;lang=en')).toBeNull()
    expect(problem('https://acme.in/db-design-services')).toBeNull()
  })

  it('never requests a file by an extension a site does not publish as a page', () => {
    for (const ext of [
      'sql', 'bak', 'old', 'zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'env', 'ini', 'log', 'pem', 'key', 'conf', 'config',
      'yml', 'yaml', 'json', 'xml', 'sqlite', 'php~',
    ]) {
      expect(problem(`https://acme.in/files/site.${ext}`), ext).toMatch(/probe/)
    }
    expect(problem('https://acme.in/feed.xml')).toMatch(/probe/)
    expect(problem('https://acme.in/index.php.bak')).toMatch(/probe/)
  })

  it('refuses another scheme, a username or password, and a port of its own', () => {
    expect(problem('ftp://acme.in/file')).toMatch(/http or https/)
    expect(problem('file:///etc/passwd')).toMatch(/http or https/)
    expect(problem('javascript:alert(1)')).toMatch(/http or https/)
    expect(problem('https://user:pass@acme.in/')).toMatch(/username or password/)
    expect(problem('https://user@acme.in/')).toMatch(/username or password/)
    expect(problem('https://acme.in:8443/')).toMatch(/port 8443/)
    expect(problem('http://acme.in:8080/contact')).toMatch(/port 8080/)
  })
})

// ---------------------------------------------------------------------------
// A connector that refuses
// ---------------------------------------------------------------------------

describe('connectorResultFailure — the refusals that kept being called', () => {
  it('reads jina’s 401 as a key it lacks', () => {
    expect(connectorResultFailure('HTTP 401: Unauthorized', true)).toBe('auth')
    expect(connectorResultFailure('HTTP 401: Unauthorized', false)).toBe('auth')
  })

  it('reads an in-band "Error: … Unauthorized" as a key it lacks', () => {
    expect(connectorResultFailure('Error: Search failed for query "x": Unauthorized', false)).toBe('auth')
  })

  it('reads tavily’s 429 body as a quota it ran out of', () => {
    const tavily =
      '{"error":"Search failed","status":429,"detail":{"error":"Your request has been blocked due to excessive ' +
      'requests. Please reduce the rate of requests. Verify you are using production API keys."}}'
    expect(connectorResultFailure(tavily, false)).toBe('quota')
    expect(connectorResultFailure(tavily, true)).toBe('quota')
  })

  it('reads firecrawl’s keyless refusal as a key it lacks, as an error or in band', () => {
    const firecrawl =
      'Anonymous keyless access is unavailable for this request. Fix: Create an API key at https://firecrawl.dev and ' +
      'set FIRECRAWL_API_KEY.'
    expect(connectorResultFailure(firecrawl, true)).toBe('auth')
    expect(connectorResultFailure(firecrawl, false)).toBe('auth')
  })

  it('reads the other shapes an API refuses in', () => {
    expect(connectorResultFailure('{"error":{"message":"Invalid API key","type":"invalid_request_error"}}', false)).toBe('auth')
    expect(connectorResultFailure('{"status":429,"message":"Too Many Requests"}', false)).toBe('quota')
    expect(connectorResultFailure('{"detail":"Unauthorized"}', false)).toBe('auth')
    expect(connectorResultFailure('429 Too Many Requests', false)).toBe('quota')
    expect(connectorResultFailure('Error: Payment Required — your plan has no credits left', false)).toBe('quota')
    expect(connectorResultFailure('Error: monthly quota exceeded', false)).toBe('quota')
    expect(connectorResultFailure('API key is missing', false)).toBe('auth')
    expect(connectorResultFailure('Error: 403 Forbidden — your API key does not have access to this endpoint', false)).toBe('auth')
  })

  it('reads a refusal that cites its own help page after the status as the connector’s', () => {
    // A web address AFTER the status is the connector's own link; the first version read it as a page's.
    expect(connectorResultFailure('HTTP 401: Unauthorized. Get your API key at https://jina.ai/?sui=apikey', true)).toBe('auth')
    expect(connectorResultFailure('Error: 401 Unauthorized — get a key at https://jina.ai/api', false)).toBe('auth')
    expect(
      connectorResultFailure('{"error":"Unauthorized","message":"See https://docs.exa.ai for your key","statusCode":401}', false),
    ).toBe('auth')
    expect(
      connectorResultFailure(
        'Rate limit exceeded. Consumed (req/min): 11, Remaining (req/min): 0. Upgrade your plan at ' +
          'https://firecrawl.dev/pricing for increased rate limits',
        true,
      ),
    ).toBe('quota')
  })

  it('reads a scraper’s own error, which names its action, as the scraper refusing', () => {
    // firecrawl words its own 401 and 429 this way; "scrape" there is the call, not a page.
    expect(connectorResultFailure('Unexpected error during scrape URL: Status code 401', true)).toBe('auth')
    expect(connectorResultFailure('Unexpected error during scrape URL: Status code 429', true)).toBe('quota')
  })

  it('never reads a short result that opens with a number as a status', () => {
    expect(connectorResultFailure('429 Lexington Avenue, New York, NY 10022', false)).toBeNull()
    expect(connectorResultFailure('401 Best Places to Eat in Delhi', false)).toBeNull()
    expect(connectorResultFailure('403 Forbidden', false)).toBe('auth')
  })

  it('never reads a page or a search result as a refusal, whatever words it carries', () => {
    const article = [
      'Error handling in Node.js: what a 401 Unauthorized means, and how a rate limit works.',
      'When a client sends too many requests, servers answer 429. An invalid API key is answered 401.',
      'This guide walks through each status with examples. '.repeat(60),
    ].join('\n')
    expect(article.length).toBeGreaterThan(1500)
    expect(connectorResultFailure(article, false)).toBeNull()
    expect(connectorResultFailure('Title: Unauthorized access at a bank\nURL: https://news.example.org/x', false)).toBeNull()
    expect(connectorResultFailure('{"error":null,"results":[{"title":"Rate limits explained"}]}', false)).toBeNull()
    expect(connectorResultFailure('200 Best Restaurants in Delhi — rate limits on reservations', false)).toBeNull()
  })

  it('never reads a page that refused the connector as the connector refusing', () => {
    // A scraper kept out of a protected site is still a working scraper.
    expect(connectorResultFailure('Error: Failed to scrape https://acme.in: 403 Forbidden', true)).toBeNull()
    expect(connectorResultFailure('Failed to fetch https://acme.in/team — status 401 Unauthorized', true)).toBeNull()
    expect(connectorResultFailure('Error: crawling https://acme.in returned 429 Too Many Requests', true)).toBeNull()
    // But its own key, said in so many words, is its own.
    expect(connectorResultFailure('Error: Failed to scrape https://acme.in: invalid API key', true)).toBe('auth')
  })

  it('reads an error that is about neither as no refusal', () => {
    expect(connectorResultFailure('Error: 503 Service Unavailable', true)).toBeNull()
    expect(connectorResultFailure('{"error":"Not found"}', false)).toBeNull()
    expect(connectorResultFailure('Error: something broke', false)).toBeNull()
    expect(connectorResultFailure('', true)).toBeNull()
  })

  it('reads a bare 403 as a key problem only when it says key or token', () => {
    expect(connectorFailureKind('403')).toBeNull()
    expect(connectorFailureKind('403: token not accepted')).toBe('auth')
    expect(connectorFailureKind('Forbidden')).toBe('auth')
    expect(connectorFailureKind('rate-limited, retry later')).toBe('quota')
    expect(connectorFailureKind('insufficient credits')).toBe('quota')
    expect(connectorFailureKind('all good')).toBeNull()
  })

  it('reads a long error in linear time', () => {
    expect(timed(() => connectorFailureKind(`https://${'a'.repeat(600_000)} 401`))).toBeLessThan(200)
    expect(timed(() => connectorResultFailure(`Error: ${'a'.repeat(600_000)}`, true))).toBeLessThan(200)
  })
})

// ---------------------------------------------------------------------------
// Links on a page
// ---------------------------------------------------------------------------

describe('pageLinks', () => {
  const base = 'https://www.127atelier.in/pages/about'

  it('resolves each link against the page, without its fragment, with its words', () => {
    const html = [
      '<a href="/pages/contact">Contact <b>us</b></a>',
      '<a href="team.html">Our&nbsp;team</a>',
      "<A HREF='https://www.127atelier.in/pages/contact#form'>Write to us</A>",
      '<a\nclass="x" href=/pages/reach-us>Reach us</a>',
      '<a href="https://instagram.com/127atelier?a=1&amp;b=2">Instagram</a>',
    ].join('\n')
    expect(pageLinks(html, base)).toEqual([
      { href: 'https://www.127atelier.in/pages/contact', text: 'Contact us' },
      { href: 'https://www.127atelier.in/pages/team.html', text: 'Our team' },
      { href: 'https://www.127atelier.in/pages/reach-us', text: 'Reach us' },
      { href: 'https://instagram.com/127atelier?a=1&b=2', text: 'Instagram' },
    ])
  })

  it('skips anchors, scripts, tags that are not links, and links with no address', () => {
    const html = [
      '<a href="#top">Top</a>', '<a href="javascript:void(0)">Menu</a>', '<a href="JavaScript:go()">Go</a>',
      '<abbr title="x">abbr</abbr>', '<area href="/map">', '<a name="x">no href</a>', '<a href="">empty</a>',
      '<a href="/contact">Contact</a>',
    ].join('')
    expect(pageLinks(html, base)).toEqual([{ href: 'https://www.127atelier.in/contact', text: 'Contact' }])
  })

  it('keeps pages and contact links only, judged on the address as resolved', () => {
    const html = [
      '<a href="java\nscript:alert(1)">x</a>', '<a href="java\tscript:go()">y</a>', '<a href="data:text/html,hi">d</a>',
      '<a href="ftp://acme.in/f">f</a>', '<a href="mailto:info@127atelier.in">Mail</a>', '<a href="tel:+919876543210">Call</a>',
      '<a href="//cdn.127atelier.in/about">About</a>',
    ].join('')
    expect(pageLinks(html, base).map((l) => l.href)).toEqual([
      'mailto:info@127atelier.in', 'tel:+919876543210', 'https://cdn.127atelier.in/about',
    ])
  })

  it('bounds a link’s words to 120 characters, and answers nothing for a page address it cannot read', () => {
    const [link] = pageLinks(`<a href="/x">${'word '.repeat(100)}</a>`, base)
    expect(link!.text.length).toBeLessThanOrEqual(120)
    expect(pageLinks('<a href="/x">x</a>', 'not a url')).toEqual([])
  })

  it('reads at most 400 links', () => {
    const html = Array.from({ length: 1000 }, (_, i) => `<a href="/p/${i}">p${i}</a>`).join('')
    expect(pageLinks(html, base)).toHaveLength(400)
  })

  it('reads a hostile page in linear time: unclosed tags, and one link repeated without its closing tag', () => {
    expect(timed(() => pageLinks('<a '.repeat(200_000), base))).toBeLessThan(200)
    expect(timed(() => pageLinks(`${'<a '.repeat(200_000)}>`, base))).toBeLessThan(200)
    expect(timed(() => pageLinks('<a href="/x">'.repeat(50_000), base))).toBeLessThan(500)
    expect(pageLinks('<a href="/x">'.repeat(50_000), base)).toHaveLength(1)
  })
})

describe('a connector refusing through its own API address', () => {
  it('reads an error naming the connector’s own service as its refusal, and another site’s as a page’s', async () => {
    const { connectorFailureKind, connectorResultFailure } = await import('../src/contact-evidence.js')
    const own = 'Request to https://api.tavily.com/search failed with status 401'
    expect(connectorFailureKind(own)).toBeNull()
    expect(connectorFailureKind(own, 'tavily')).toBe('auth')
    expect(connectorResultFailure(own, true, 'tavily')).toBe('auth')
    expect(connectorFailureKind('Failed to scrape https://acme.in/team: 403 Forbidden', 'firecrawl')).toBeNull()
    expect(connectorFailureKind('Request to https://api.tavily.com/x failed: 429', 'ta')).toBeNull()
  })
})
