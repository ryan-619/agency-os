/**
 * ⌘K, Ctrl+K and "/" jump to search (2026-10-09) — "/" only where a person
 * is not already typing.
 */
import { describe, expect, it } from 'vitest'
import { isSearchShortcut } from '../src/components/search-box'

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

describe('isSearchShortcut', () => {
  it('takes ⌘K and Ctrl+K from anywhere, typing or not', () => {
    for (const typing of [false, true]) {
      expect(isSearchShortcut(key('k', { metaKey: true }), typing)).toBe(true)
      expect(isSearchShortcut(key('K', { ctrlKey: true }), typing)).toBe(true)
    }
  })

  it('takes "/" only where nobody is typing', () => {
    expect(isSearchShortcut(key('/'), false)).toBe(true)
    expect(isSearchShortcut(key('/'), true)).toBe(false)
  })

  it('leaves every other key alone', () => {
    expect(isSearchShortcut(key('k'), false)).toBe(false)
    expect(isSearchShortcut(key('k', { metaKey: true, shiftKey: true }), false)).toBe(false)
    expect(isSearchShortcut(key('k', { metaKey: true, altKey: true }), false)).toBe(false)
    expect(isSearchShortcut(key('/', { metaKey: true }), false)).toBe(false)
    expect(isSearchShortcut(key('j', { ctrlKey: true }), false)).toBe(false)
  })
})
