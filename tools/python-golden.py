#!/usr/bin/env python3
"""
Run the ORIGINAL Python lead engine against the recorded fixtures and write
what it produced.

This is the other half of the Phase 1 Definition of Done: "importing the 16
seed domains produces scored companies whose findings match what the Python
engine produces for the same domains."

The engine at ~/Documents/lead-engine is imported UNMODIFIED. Only its two I/O
functions are replaced, so it reads the fixture instead of the internet — the
same bytes the TypeScript engine gets. Every rule, every threshold and every
branch below that is the original's.

  python3 tools/python-golden.py [--engine PATH] [--out PATH]
"""
import argparse, gzip, io, json, os, sys, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "..", "packages", "scanner", "fixtures")
DEFAULT_ENGINE = os.path.expanduser("~/Documents/lead-engine")


class FakeHeaders(dict):
    """urllib's headers: case-insensitive .get, .items() for the dict build."""
    def __init__(self, pairs):
        super().__init__(pairs)
        self._lower = {k.lower(): v for k, v in pairs.items()}

    def get(self, key, default=None):
        return self._lower.get(key.lower(), default)


class FakeResponse(io.BytesIO):
    def __init__(self, status, body, headers, url):
        super().__init__(body.encode("utf-8"))
        self.status = status
        self.url = url
        # Content-Encoding is dropped: the fixture body is already decoded, so
        # _decode() must not try to gunzip it a second time.
        self.headers = FakeHeaders({k: v for k, v in headers.items() if k.lower() != "content-encoding"})

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()
        return False


def install_fixture(signals, capture):
    """Point the engine's two I/O functions at one recorded capture."""
    home = capture["home"]
    paths = capture["paths"]
    host = capture["domain"]

    def fake_get(url, timeout=None):
        rest = url.split(f"https://{host}", 1)[-1] or "/"
        if rest == "/":
            if not home["ok"]:
                if home.get("status"):
                    raise urllib.error.HTTPError(url, home["status"], "error", None, None)
                raise OSError(home.get("error", "no response"))
            return FakeResponse(home["status"], home["body"], home["headers"], home.get("finalUrl") or url)

        res = paths.get(rest)
        if res is None or res.get("error") is not None or res.get("status") is None:
            raise OSError((res or {}).get("error", "not probed"))
        return FakeResponse(res["status"], res["body"], {}, url)

    def fake_tls(h):
        t = capture["tls"]
        if not t.get("ok"):
            return {"ok": False, "error": t.get("error", "")}
        return {
            "ok": True,
            "protocol": t.get("protocol", ""),
            "issuer": t.get("issuer", ""),
            "expires": t.get("expires", ""),
            "days_to_expiry": t.get("daysToExpiry", 999),
        }

    signals._get = fake_get
    signals._tls_info = fake_tls


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default=DEFAULT_ENGINE)
    ap.add_argument("--out", default=os.path.join(FIXTURES, "python-golden.json"))
    a = ap.parse_args()

    if not os.path.isdir(a.engine):
        print(f"Python engine not found at {a.engine}", file=sys.stderr)
        sys.exit(2)

    sys.path.insert(0, a.engine)
    from src import signals, score                      # noqa: E402
    from icp.security_gap_saas_us_eu import PROFILE     # noqa: E402

    files = sorted(f for f in os.listdir(FIXTURES) if f.endswith(".json.gz"))
    if not files:
        print("no fixtures — run `npm run fixtures:capture` first", file=sys.stderr)
        sys.exit(2)

    out = {}
    for fname in files:
        with gzip.open(os.path.join(FIXTURES, fname), "rt", encoding="utf-8") as fh:
            capture = json.load(fh)

        install_fixture(signals, capture)
        profile = signals.profile_site(capture["domain"])
        profile["company"] = capture.get("company", "") or capture["domain"]
        result = score.score_company(profile, PROFILE)
        result["company"] = profile["company"]

        out[capture["domain"]] = {
            "profile": {
                "domain": profile["domain"],
                "title": profile.get("title", ""),
                "fetch_ok": profile.get("fetch_ok", False),
                "fetch_error": profile.get("fetch_error", ""),
                "has_login_surface": profile.get("has_login_surface", False),
                "is_security_vendor": profile.get("is_security_vendor", False),
                "mentions_security_hiring": profile.get("mentions_security_hiring", False),
                "compliance_claims": profile.get("compliance_claims", []),
                "outdated_libs": profile.get("outdated_libs", []),
                "observations": profile.get("observations", {}),
            },
            "result": {
                "domain": result["domain"], "company": result["company"],
                "score": result["score"], "tier": result["tier"],
                "qualified": result["qualified"], "disqualified": result["disqualified"],
                "gaps": result["gaps"], "strengths": result["strengths"],
                "headline_finding": result["headline_finding"], "angle": result["angle"],
                "evidence": result["evidence"], "reachable": result["reachable"],
            },
        }
        r = out[capture["domain"]]["result"]
        flag = r["tier"] or ("DQ" if r["disqualified"] else "below")
        print(f"  {capture['domain']:26} {r['score']:>3}  {flag}")

    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(out, fh, indent=2, sort_keys=True)
    print(f"\nwrote {len(out)} golden results -> {os.path.relpath(a.out, os.path.join(HERE, '..'))}")


if __name__ == "__main__":
    main()
