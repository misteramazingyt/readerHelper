#!/usr/bin/env python3
"""test_protocol.py — the readerhelper:// handler's guards.

Windows hands this handler URLs straight from the browser, so *any* site the
user visits can invoke it. These tests are about what it refuses: opening
anything that is not an existing local PDF, and passing anything to a shell.

    python scripts/test_protocol.py
"""

from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import readerhelper_open as R  # noqa: E402

passed = 0
failures: list[str] = []


def check(name):
    def wrap(fn):
        global passed
        try:
            fn()
            passed += 1
        except AssertionError as err:
            failures.append(f"{name}: {err}")
        except Exception as err:  # noqa: BLE001
            failures.append(f"{name}: unexpected {type(err).__name__}: {err}")
        return fn
    return wrap


tmp = tempfile.mkdtemp()
pdf = os.path.join(tmp, "book.pdf")
exe = os.path.join(tmp, "evil.exe")
open(pdf, "wb").write(b"%PDF-1.4")
open(exe, "wb").write(b"MZ")

import urllib.parse as _u


def open_url(path: str, page: int | None = None) -> str:
    q = "path=" + _u.quote(path, safe="")
    if page:
        q += f"&page={page}"
    return "readerhelper://open?" + q


# ------------------------------------------------------------------ scheme

@check("only the readerhelper scheme is accepted")
def _():
    for bad in ["http://example.com/x.pdf", "file:///C:/x.pdf", "javascript:alert(1)"]:
        _a, _q, err = R.parse_action(["x", bad])
        assert err, f"should refuse {bad}"


@check("only known actions are accepted")
def _():
    for bad in ["readerhelper://run?x=1", "readerhelper://exec", "readerhelper://delete?path=x"]:
        _a, _q, err = R.parse_action(["x", bad])
        assert err and "Unknown action" in err, f"should refuse {bad}"

    for good in ["readerhelper://open?path=x", "readerhelper://goodreads-upload"]:
        action, _q, err = R.parse_action(["x", good])
        assert not err, f"should accept {good}: {err}"
        assert action in R.ACTIONS


@check("a bare readerhelper:// URL defaults to open")
def _():
    action, _q, err = R.parse_action(["x", "readerhelper://?path=y"])
    assert not err, err
    assert action == "open", action


# -------------------------------------------------------------- opening PDFs

@check("an existing local PDF is allowed through")
def _():
    path, page, err = R.parse(["x", open_url(pdf, 12)])
    assert not err, err
    safe, err = R.validate(path)
    assert not err, err
    assert safe == os.path.realpath(pdf)
    assert page == 12


@check("anything that is not a PDF is refused")
def _():
    for bad in [exe, os.path.join(tmp, "x.bat"), os.path.join(tmp, "x.lnk")]:
        path, _p, err = R.parse(["x", open_url(bad)])
        assert not err, err
        _safe, err = R.validate(path)
        assert err, f"should refuse {bad}"


@check("a PDF that does not exist is refused")
def _():
    path, _p, err = R.parse(["x", open_url(os.path.join(tmp, "absent.pdf"))])
    _safe, err = R.validate(path)
    assert err and "not on this machine" in err, err


@check("network and relative paths are refused")
def _():
    for bad in [r"\\server\share\x.pdf", "//server/share/x.pdf", "../x.pdf", "x.pdf"]:
        _safe, err = R.validate(bad)
        assert err, f"should refuse {bad}"


@check("a URL with no path at all is refused")
def _():
    _path, _page, err = R.parse(["x", "readerhelper://open"])
    assert err and "no path" in err.lower(), err


# ---------------------------------------------------------- goodreads upload

@check("the uploader only ever receives a bare CSV filename")
def _():
    # A traversal in the URL must not become a path the uploader trusts.
    err = R.run_goodreads_upload({"name": ["../../../etc/passwd"]})
    assert err and "non-CSV" in err, f"traversal should be refused as non-CSV, got {err!r}"

    err = R.run_goodreads_upload({"name": ["evil.exe"]})
    assert err and "non-CSV" in err, f"an exe should be refused, got {err!r}"


@check("a well-formed upload request is not rejected on its arguments")
def _():
    # It may still fail because node or the script is absent; what matters is
    # that it is not turned away for the filename.
    err = R.run_goodreads_upload({"name": ["goodreads-reading.csv"]})
    if err:
        assert "non-CSV" not in err and "Refusing" not in err, err


# ------------------------------------------------------------------- report

# Plain ASCII on purpose: a Windows console defaults to cp1252 and raises
# UnicodeEncodeError on a tick or a bullet.
if failures:
    print(f"\nFAILED: {len(failures)} failed, {passed} passed:\n")
    for f in failures:
        print(f"  - {f}")
    print()
    sys.exit(1)

print(f"OK: {passed} protocol handler tests passed.")
