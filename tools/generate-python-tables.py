#!/usr/bin/env python3
"""
Regenerate packages/scanner/src/python-tables.ts from CPython's own tables.

The scanner's HTML reader is a port of `html.parser.HTMLParser` and
`html.unescape`, because the reference engine at ~/Documents/lead-engine reads
pages with them and PROMPT.md 8.3 says the rules encoded there ARE the product.
Every lookup table those two consult is emitted here rather than transcribed by
hand, so "the port disagrees with Python" can never be a typo in a 2231-entry
table.

    python3 tools/generate-python-tables.py

Re-run only when the Python version the goldens are generated with changes.
"""
import html
import html.entities
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'packages', 'scanner', 'src', 'python-tables.ts')

MAP_NOTE = (
    " *  A Map rather than an object literal, so that a page asking for\n"
    " *  `&constructor;` or `&__proto__;` gets a miss instead of a function.\n"
)


def dense(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, indent=0).replace('\n', '')


def char_class(codepoints) -> str:
    """A JS regex character-class body covering exactly these code points."""
    out, run_start, prev = [], None, None
    for c in sorted(codepoints) + [None]:
        if prev is not None and c == prev + 1:
            prev = c
            continue
        if run_start is not None:
            if run_start == prev:
                out.append(f'\\u{run_start:04x}')
            elif prev == run_start + 1:
                out.append(f'\\u{run_start:04x}\\u{prev:04x}')
            else:
                out.append(f'\\u{run_start:04x}-\\u{prev:04x}')
        run_start = prev = c
    return ''.join(out)


space = [c for c in range(0x110000) if chr(c).isspace()]
assert max(space) < 0x10000, 'a non-BMP space would need surrogate handling'

py = f'{sys.version_info.major}.{sys.version_info.minor}'

with open(OUT, 'w') as f:
    f.write(f'''/**
 * Lookup tables GENERATED from CPython {py}'s `html` module by
 * tools/generate-python-tables.py. Do not edit by hand.
 *
 * htmlparser.ts and unescape.ts are ports of `html.parser.HTMLParser` and
 * `html.unescape`, which is what the reference engine reads pages with.
 * Transcribing a 2231-entry entity table by hand would make a silent
 * one-character disagreement between the two engines a matter of luck, so none
 * of this is transcribed.
 */

''')

    f.write('/** `html.entities.html5` — what `html.unescape` resolves named references\n'
            ' *  against. Both the semicolon-terminated and the semicolon-less forms are\n'
            ' *  present, exactly as Python ships them: `&amp` without the semicolon is\n'
            ' *  legal HTML and the two engines have to agree about it.\n'
            + MAP_NOTE + ' */\n')
    f.write('export const HTML5_ENTITIES: ReadonlyMap<string, string> = new Map(Object.entries(\n')
    f.write(dense(dict(html.entities.html5)))
    f.write('))\n\n')

    f.write('/** `html._invalid_charrefs` — numeric references Python rewrites rather than\n'
            ' *  resolving, mostly the Windows-1252 bytes an author means when they write\n'
            ' *  `&#147;`. Keyed by decimal code point.\n'
            + MAP_NOTE + ' */\n')
    f.write('export const INVALID_CHARREFS: ReadonlyMap<number, string> = new Map(\n')
    f.write(dense([[k, v] for k, v in sorted(html._invalid_charrefs.items())]))
    f.write(')\n\n')

    f.write('/** `html._invalid_codepoints` — numeric references Python resolves to nothing\n'
            ' *  at all: controls and non-characters. */\n')
    f.write('export const INVALID_CODEPOINTS: ReadonlySet<number> = new Set(\n')
    f.write(dense(sorted(html._invalid_codepoints)))
    f.write(')\n\n')

    f.write("/** The code points `str.isspace()` is true for. Python's `\\s` and\n"
            " *  `str.strip()` both use exactly this set, and it is NOT the set\n"
            " *  JavaScript's `\\s` and `String.trim()` use: Python has U+001C..U+001F and\n"
            " *  U+0085, and does not have U+FEFF. The ported regexes spell `\\s` out with\n"
            " *  this rather than trusting the two languages to mean the same thing. */\n")
    f.write(f"export const PY_SPACE_CLASS = '{char_class(space)}'\n")

print(f'wrote {os.path.relpath(OUT, os.path.join(HERE, ".."))} from CPython {py}: '
      f'{len(html.entities.html5)} entities, {len(html._invalid_charrefs)} invalid charrefs, '
      f'{len(html._invalid_codepoints)} invalid code points, {len(space)} space chars')
