#!/usr/bin/env python3
"""readerhelper:// protocol handler.

Opens a local PDF from the readerHelper web app, which a browser cannot do
itself: a page served over https is forbidden from navigating to file:///C:/...
This mirrors what Zotero Searcher does on Ctrl+Shift+O (os.startfile on the path
from the Better BibTeX `file` field).

URL form:
    readerhelper://open?path=<url-encoded absolute path>[&page=<n>]

SAFETY.  Windows hands this URL to us straight from the browser, so *any* site
the user visits can invoke it. It is therefore treated as untrusted input:

  * only ".pdf" is ever opened -- never .exe, .lnk, .bat, .ps1, .scr;
  * the file must already exist (nothing is created, downloaded or written);
  * UNC and remote paths are refused, so this cannot be pointed at a share;
  * with ALLOWED_ROOTS set, paths outside those directories are refused;
  * nothing is executed except the PDF viewer.

Install with tools/install-protocol.ps1; uninstall with -Uninstall.
"""

from __future__ import annotations

import ctypes
import os
import shutil
import subprocess
import sys
import urllib.parse

APP = "readerHelper"

# Optional allowlist. Leave empty to permit any local PDF, or list the folders
# your library actually lives in for a tighter guard, e.g.:
#     ALLOWED_ROOTS = [r"C:\Users\Shae\Zotero", r"D:\Books"]
ALLOWED_ROOTS: list[str] = []

# Readers that can be told to jump to a page. First match on PATH wins.
PAGE_AWARE_READERS = [
    ("SumatraPDF.exe", lambda path, page: ["-page", str(page), path]),
    ("Acrobat.exe", lambda path, page: [f"/A", f"page={page}", path]),
    ("AcroRd32.exe", lambda path, page: [f"/A", f"page={page}", path]),
]


def alert(message: str, title: str = APP, icon: int = 0x30) -> None:
    """Message box; the handler is windowless, so this is the only way to speak."""
    try:
        ctypes.windll.user32.MessageBoxW(0, message, title, icon)
    except Exception:
        print(message, file=sys.stderr)


ACTIONS = {"open", "goodreads-upload"}


def parse_action(argv: list[str]) -> tuple[str | None, dict, str | None]:
    """Split the URL into an action and its query, validating the scheme."""
    if len(argv) < 2:
        return None, {}, "No URL was passed to the handler."

    raw = argv[1].strip().strip('"')
    parts = urllib.parse.urlsplit(raw)

    if parts.scheme.lower() != "readerhelper":
        return None, {}, f"Unexpected scheme: {parts.scheme!r}"

    # Windows may hand us readerhelper://open?... or readerhelper:open?...
    action = (parts.netloc or parts.path.lstrip("/")).split("?", 1)[0].lower() or "open"
    if action not in ACTIONS:
        return None, {}, f"Unknown action: {action!r}"

    return action, urllib.parse.parse_qs(parts.query), None


def parse(argv: list[str]) -> tuple[str | None, int | None, str | None]:
    action, query, err = parse_action(argv)
    if err:
        return None, None, err
    if action != "open":
        return None, None, f"Unknown action: {action!r}"
    path = (query.get("path") or [""])[0]
    if not path:
        return None, None, "The URL carried no path."

    page_raw = (query.get("page") or [""])[0]
    page = None
    if page_raw:
        try:
            page = max(1, int(page_raw))
        except ValueError:
            page = None

    return path, page, None


def validate(path: str) -> tuple[str | None, str | None]:
    """Return (safe_path, error). Refuses anything that is not an existing local PDF."""
    path = os.path.normpath(os.path.expandvars(path))

    if path.startswith("\\\\") or path.startswith("//"):
        return None, f"Refusing a network path:\n\n{path}"

    if not os.path.isabs(path):
        return None, f"Refusing a relative path:\n\n{path}"

    if os.path.splitext(path)[1].lower() != ".pdf":
        return None, f"{APP} only opens PDF files. Refusing:\n\n{path}"

    real = os.path.realpath(path)
    if os.path.splitext(real)[1].lower() != ".pdf":
        # A .lnk or symlink pointing somewhere else.
        return None, f"Refusing a link that does not resolve to a PDF:\n\n{path}"

    if not os.path.isfile(real):
        return None, f"That PDF is not on this machine:\n\n{path}"

    if ALLOWED_ROOTS:
        allowed = any(
            os.path.commonpath([real, os.path.realpath(root)]) == os.path.realpath(root)
            for root in ALLOWED_ROOTS
            if os.path.isdir(root)
        )
        if not allowed:
            return None, f"That PDF is outside the folders {APP} may open:\n\n{real}"

    return real, None


def open_pdf(path: str, page: int | None) -> str | None:
    """Open the PDF, jumping to `page` when a reader that supports it is present."""
    if page:
        for exe, build_args in PAGE_AWARE_READERS:
            found = shutil.which(exe)
            if not found:
                continue
            try:
                subprocess.Popen([found, *build_args(path, page)], close_fds=True)
                return None
            except OSError:
                break  # fall through to the default handler

    try:
        os.startfile(path)  # noqa: S606 - a validated .pdf, opened by the shell
        return None
    except OSError as err:
        return f"Windows could not open the PDF:\n\n{path}\n\n{err}"


def run_goodreads_upload(query: dict) -> str | None:
    """Hand off to the Goodreads uploader, which lives beside this script.

    Nothing from the URL reaches a shell: only a filename is taken, it is
    stripped to its basename, and the uploader itself resolves it inside the
    downloads folder. The URL cannot name an arbitrary path.
    """
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "goodreads_upload.mjs")
    if not os.path.isfile(script):
        return f"The uploader is missing:\n\n{script}"

    node = shutil.which("node")
    if not node:
        return "Node is not on PATH, so the Goodreads uploader cannot run."

    cmd = [node, script]
    name = (query.get("name") or [""])[0]
    if name:
        safe = os.path.basename(name)
        if not safe.lower().endswith(".csv"):
            return f"Refusing a non-CSV filename:\n\n{name}"
        cmd += ["--name", safe]

    kwargs: dict = {}
    if sys.platform == "win32" and hasattr(subprocess, "CREATE_NO_WINDOW"):
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        # Detached: the browser run takes a while and the handler must return.
        subprocess.Popen(cmd, cwd=os.path.dirname(script), **kwargs)
    except OSError as err:
        return f"Could not start the uploader:\n\n{err}"
    return None


def main() -> int:
    action, query, err = parse_action(sys.argv)
    if err:
        alert(err)
        return 2

    if action == "goodreads-upload":
        err = run_goodreads_upload(query)
        if err:
            alert(err)
            return 6
        return 0

    path, page, err = parse(sys.argv)
    if err:
        alert(err)
        return 2

    safe, err = validate(path)
    if err:
        alert(err)
        return 3

    err = open_pdf(safe, page)
    if err:
        alert(err)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
