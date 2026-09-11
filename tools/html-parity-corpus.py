#!/usr/bin/env python3
"""
Build the HTML parser differential corpus.

packages/scanner/src/htmlparser.ts is a port of `html.parser.HTMLParser`. The
sixteen recorded seed pages prove it agrees with Python on real-world markup,
which is necessary and nowhere near sufficient — real pages are well behaved,
and the bugs this port exists to fix (tags read out of comments, tags cut short
by a `>` inside a quoted value) only show up in markup that is not.

So this runs the REFERENCE engine's own extractor over a corpus of deliberately
hostile tag soup and records what it answers. The TypeScript side replays the
same strings in packages/scanner/test/html-parity.test.ts. A disagreement is
between the two engines, not between two moments on the internet.

    python3 tools/html-parity-corpus.py
"""
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.expanduser('~/Documents/lead-engine/src')
OUT = os.path.join(HERE, '..', 'packages', 'scanner', 'fixtures', 'html-parity.json')

sys.path.insert(0, os.path.dirname(REF))
from src.signals import _Extract  # noqa: E402  the reference extractor itself


# --- hand-written cases, each one a thing that has gone wrong or could ------
CASES = [
    # A commented-out IE fallback. The regex parser reported "jQuery 1.11.0
    # served in production" from markup no browser ever executes.
    '<!--[if lt IE 9]><script src="/js/jquery-1.11.0.min.js"></script><![endif]-->'
    '<script src="/js/app.js"></script>',
    # A password field inside a comment flipped has_login_surface, which
    # qualifies a company the reference disqualifies.
    '<!-- <input type="password"> --><p>nothing here</p>',
    '<!-- <a href="/login">sign in</a> -->',
    # `--\s*>` closes a comment; `-->` is not the only spelling.
    '<!-- x -- ><script src="/a-1.0.0.js"></script>',
    '<!-- unterminated <script src="/never-seen.js"></script>',
    # A `>` inside a quoted attribute value must not end the tag.
    '<a onclick="() => go()" href="/login">in</a>',
    '<script onload="if(a>b){}" src="/js/bootstrap-4.6.0.min.js"></script>',
    "<a onclick='x>1' href='/dashboard'>d</a>",
    '<input data-x="a>b" type="password">',
    # Tag-shaped text inside a script body is script text, not markup.
    '<script>var s = "<input type=\'password\'>";</script>',
    '<script>document.write("<script src=\'/js/jquery-1.4.2.js\'><\\/script>")</script>',
    '<script>if (a </b) {}</script><title>after</title>',
    '<script>x</script ><title>t</title>',
    '<style>a::before{content:"<a href=\'/login\'>"}</style>',
    '<script src="/a.js">var t = "</p>";</script>',
    # Marked sections.
    '<![CDATA[ <script src="/js/moment-2.0.0.js"></script> ]]><title>ok</title>',
    '<![if !IE]><script src="/js/lodash-4.17.4.js"></script><![endif]>',
    '<![unknownkeyword]><title>lost</title>',
    # Titles.
    '<title>Real</title><svg><title>icon</title></svg>',
    '<title>unclosed and then the rest of the document',
    '<title>a</title><p>b</p><title>c</title>',
    '<title/>not the title',
    '<TITLE>Upper</TITLE>',
    '<title>  spaced  </title>',
    '<title>' + ('x' * 260) + '</title>',
    '<title>' + ('y' * 190) + '</title><p>' + ('z' * 40) + '</p>',
    '<title>a&amp;b &lt;c&gt; &#8212; &notit; &amp &#x2014;</title>',
    '<title>é\U0001f600 café</title>',
    '<title>\x1c stripped? \x85</title>',
    '<title>﻿ kept? ﻿</title>',
    # Attribute shapes.
    '<script src=/js/angular-1.5.0.js></script>',
    '<script src></script><script src=""></script>',
    '<script SRC="/js/JQuery-2.1.0.js"></script>',
    '<script src="/a.js" src="/b.js"></script>',
    '<script\n  src="/js/jquery-1.11.0.min.js"\n></script>',
    '<script src = "/js/spaced.js"></script>',
    '<script src=="/js/doubleeq.js"></script>',
    '<input type=password>',
    '<input type=PASSWORD>',
    '<input type="&#112;assword">',
    '<input type=" password ">',
    '<a href="/LOGIN">up</a>',
    '<a href="&#47;login">entity</a>',
    '<a>no href</a><a href>empty</a>',
    '<a href="/about" href="/login">last wins</a>',
    '<a href="/login" />',
    '<input/type="password">',
    # Truncation and buffer-boundary behaviour, which differs because the
    # reference calls feed() and never close().
    '<title>t</title><script src="/js/jquery-1.11.0.min.js"',
    '<title>t</title><a href="/login"',
    '<title>t</title>trailing &amp',
    '<title>t</title>trailing &',
    '<title>t</title>trailing text with no ampersand at all',
    '<p>&#',
    '<',
    '<p><',
    '</>',
    '</ >',
    '</3>',
    '<!doctype html><title>doc</title>',
    '<!doctype html',
    '<!bogus><title>after bogus</title>',
    '<?php echo "<script src=\'/x.js\'>"; ?><title>pi</title>',
    '<a href=">">text</a><a href="/login">real</a>',
    '<a href="/login" extra=>',
    '',
    'no markup at all',
]


def soup(rng: random.Random) -> str:
    """Random tag soup drawn from the tokens that have caused trouble."""
    tokens = [
        '<title>', '</title>', '<TITLE >', '</title >', '<title/>',
        '<script>', '</script>', '<style>', '</style>',
        '<script src="/js/jquery-1.11.0.min.js">', '<script src=/js/b-4.0.0.js>',
        '<script src="a>b">', '<script src>',
        '<input type="password">', '<input type=password >', '<input type="pass">',
        '<a href="/login">', '<a href=\'/app\'>', '<a href="/x">', '</a>',
        '<!--', '-->', '-- >', '<!-- x -->', '<![CDATA[', ']]>', '<![if !IE]>',
        '<!doctype html>', '<?pi?>', '<!bogus>', '</>', '<', '>', '&', '&amp;',
        '&#8212;', '&notit;', 'text ', ' ', '\n', '"', "'", '/', '=',
    ]
    return ''.join(rng.choice(tokens) for _ in range(rng.randint(1, 24)))


def observe(html: str) -> dict:
    p = _Extract()
    try:
        p.feed(html)
    except Exception:
        pass
    # Exactly what signals.py reads off the parser afterwards.
    return {'html': html, 'title': p.title[:160], 'scripts': p.scripts, 'has_login': p.has_login}


rng = random.Random(20260911)
cases = list(CASES) + [soup(rng) for _ in range(2000)]
seen, corpus = set(), []
for html in cases:
    if html in seen:
        continue
    seen.add(html)
    corpus.append(observe(html))

with open(OUT, 'w') as f:
    json.dump(
        {
            'python': f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}',
            'generator': 'tools/html-parity-corpus.py',
            'cases': corpus,
        },
        f,
        ensure_ascii=False,
        indent=1,
    )
    f.write('\n')

titled = sum(1 for c in corpus if c['title'])
scripted = sum(1 for c in corpus if c['scripts'])
logins = sum(1 for c in corpus if c['has_login'])
print(f'{len(corpus)} cases -> {os.path.relpath(OUT, os.path.join(HERE, ".."))} '
      f'({titled} with a title, {scripted} with scripts, {logins} with a login surface)')
