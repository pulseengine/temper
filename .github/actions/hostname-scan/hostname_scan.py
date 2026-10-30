#!/usr/bin/env python3
"""hostname-scan: refuse private-network hostnames and addresses in a repo.

A public repo must not carry the shape of a private network: mDNS/LAN host
names (``*.local``, ``*.lan``, ``*.internal``, ``*.home.arpa``,
consumer-router domains such as ``*.fritz.box`` ...), tailnet names
(``*.ts.net``), RFC 1918 / CGNAT / link-local IPv4, and ULA / link-local
IPv6. Real home-network names are NOT listed here -- they would leak the very
thing this check exists to keep out. Supply them at run time through the
``HOSTNAME_SCAN_DENYLIST`` environment variable (newline-separated regular
expressions, typically from an org secret).

Modes (exactly one):
  --diff BASE HEAD   scan lines ADDED between BASE and HEAD (PR / merge queue)
  --all              scan every tracked file at HEAD
  --history          scan every line ever added on any ref; prints counts per
                     category only, never values (for a make-public review)

Exit status: 0 clean, 1 findings, 2 usage or git error.

Findings are printed as GitHub annotations with the value REDACTED, because
CI logs of a public repo are public.

Allowlist (default ``.github/hostname-scan-allow.txt``), one entry per line:
  path:<glob>     skip files matching the fnmatch glob
  value:<regex>   ignore findings whose value fully matches (case-insensitive)
  # comment / blank lines ignored
A line containing ``hostname-scan: allow`` is skipped (inline pragma).

Compatible with Python 3.9 (stdlib only).
"""

import argparse
import fnmatch
import ipaddress
import os
import re
import subprocess
import sys
from collections import Counter
from typing import Iterable, Iterator, List, NamedTuple, Optional, Pattern, Tuple

DEFAULT_ALLOWLIST = ".github/hostname-scan-allow.txt"
PRAGMA = "hostname-scan: allow"

# Private / special-use names. ``home.arpa`` is RFC 8375, ``internal`` is the
# ICANN-reserved private TLD, ``local`` is mDNS (RFC 6762).
PRIVATE_SUFFIXES = (
    "local",
    "lan",
    "home",
    "internal",
    "intranet",
    "localdomain",
    "home.arpa",
    "ts.net",
    "fritz.box",
    "speedport.ip",
)

_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
HOST_RE = re.compile(
    r"(?<![\w.-])((?:" + _LABEL + r"\.)+(?:"
    + "|".join(re.escape(s) for s in sorted(PRIVATE_SUFFIXES, key=len, reverse=True))
    + r"))(?![\w-]|\.[a-z0-9])",
    re.IGNORECASE,
)

# Attribute access that merely looks like a host (``self.local``,
# ``threading.local()``) -- code, not a name on a network.
CODE_RECEIVERS = {"self", "this", "cls", "super", "threading", "os", "ctx", "context"}

IPV4_RE = re.compile(r"(?<![\d.])((?:\d{1,3}\.){3}\d{1,3})(?![\d]|\.\d)")
IPV6_CANDIDATE_RE = re.compile(r"(?<![0-9a-f:])([0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7})", re.IGNORECASE)

# The range definitions themselves are the one place these prefixes belong.
IPV4_NETS = (
    ("rfc1918-ipv4", ipaddress.ip_network("10.0.0.0/8")),  # hostname-scan: allow
    ("rfc1918-ipv4", ipaddress.ip_network("172.16.0.0/12")),  # hostname-scan: allow
    ("rfc1918-ipv4", ipaddress.ip_network("192.168.0.0/16")),  # hostname-scan: allow
    ("cgnat-ipv4", ipaddress.ip_network("100.64.0.0/10")),  # hostname-scan: allow
    ("link-local-ipv4", ipaddress.ip_network("169.254.0.0/16")),  # hostname-scan: allow
)
IPV6_NETS = (
    ("ula-ipv6", ipaddress.ip_network("fc00::/7")),  # hostname-scan: allow
    ("link-local-ipv6", ipaddress.ip_network("fe80::/10")),  # hostname-scan: allow
)


class Finding(NamedTuple):
    path: str
    line: int
    category: str
    value: str


class Allowlist(object):
    def __init__(self, path_globs: List[str], value_res: List[Pattern]) -> None:
        self.path_globs = path_globs
        self.value_res = value_res

    @classmethod
    def load(cls, disk_path: Optional[str], rel_path: Optional[str] = None) -> "Allowlist":
        """Read the allowlist at ``disk_path``; ``rel_path`` (its repo-relative
        name) is always skipped, since the allowlist names what it allows."""
        globs = []  # type: List[str]
        values = []  # type: List[Pattern]
        if disk_path and os.path.isfile(disk_path):
            with open(disk_path, encoding="utf-8") as fh:
                for raw in fh:
                    entry = raw.strip()
                    if not entry or entry.startswith("#"):
                        continue
                    kind, _, rest = entry.partition(":")
                    rest = rest.strip()
                    if kind == "path" and rest:
                        globs.append(rest)
                    elif kind == "value" and rest:
                        values.append(re.compile(rest, re.IGNORECASE))
                    else:
                        raise ValueError("bad allowlist entry: %r" % entry)
        if rel_path:
            globs.append(rel_path)
        return cls(globs, values)

    def skips_path(self, path: str) -> bool:
        return any(fnmatch.fnmatch(path, g) for g in self.path_globs)

    def allows_value(self, value: str) -> bool:
        return any(r.fullmatch(value) for r in self.value_res)


def compile_denylist(text: str) -> List[Pattern]:
    return [re.compile(p.strip(), re.IGNORECASE) for p in text.splitlines() if p.strip()]


def scan_line(line: str, denylist: Iterable[Pattern] = ()) -> List[Tuple[str, str]]:
    """Return (category, value) pairs for one line of text."""
    if PRAGMA in line:
        return []
    hits = []  # type: List[Tuple[str, str]]

    for m in HOST_RE.finditer(line):
        host = m.group(1)
        first = host.split(".", 1)[0].lower()
        if first in CODE_RECEIVERS:
            continue
        if line[m.end():m.end() + 1] == "(":
            continue
        hits.append(("private-hostname", host))

    for m in IPV4_RE.finditer(line):
        try:
            addr = ipaddress.ip_address(m.group(1))
        except ValueError:
            continue
        for category, net in IPV4_NETS:
            if addr in net:
                hits.append((category, m.group(1)))
                break

    for m in IPV6_CANDIDATE_RE.finditer(line):
        token = m.group(1).rstrip(":")
        if token.count(":") < 2 and "::" not in m.group(1):
            continue
        for candidate in (m.group(1), token, token + "::"):
            try:
                addr6 = ipaddress.ip_address(candidate)
            except ValueError:
                continue
            for category, net in IPV6_NETS:
                if addr6 in net:
                    hits.append((category, m.group(1)))
                    break
            break

    for pattern in denylist:
        for m in pattern.finditer(line):
            hits.append(("denylisted-name", m.group(0)))

    return hits


def redact(category: str, value: str) -> str:
    """Show the shape of a finding without publishing it (CI logs are public)."""
    if category == "denylisted-name":
        return "[denylisted]"
    if category.endswith("ipv6"):
        return value.split(":", 1)[0] + ":…"
    if category.endswith("ipv4"):
        return ".".join(value.split(".")[:2] + ["x", "x"])
    lowered = value.lower()
    for suffix in sorted(PRIVATE_SUFFIXES, key=len, reverse=True):
        if lowered.endswith("." + suffix):
            return value[:1] + "***." + suffix
    return value[:1] + "***"


def git(args: List[str], cwd: str) -> str:
    proc = subprocess.run(
        ["git"] + args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        universal_newlines=True, errors="replace",
    )
    if proc.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (" ".join(args), proc.stderr.strip()))
    return proc.stdout


HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def added_lines(diff_text: str) -> Iterator[Tuple[str, int, str]]:
    """Yield (path, line_no, text) for each '+' line of a unified diff."""
    path = None  # type: Optional[str]
    line_no = 0
    for raw in diff_text.splitlines():
        if raw.startswith("+++ "):
            target = raw[4:]
            path = None if target == "/dev/null" else target[2:] if target.startswith("b/") else target
            continue
        if raw.startswith("--- ") or raw.startswith("diff --git"):
            continue
        hunk = HUNK_RE.match(raw)
        if hunk:
            line_no = int(hunk.group(1))
            continue
        if path is None:
            continue
        if raw.startswith("+"):
            yield path, line_no, raw[1:]
            line_no += 1
        elif raw.startswith(" "):
            line_no += 1


def scan_pairs(pairs: Iterable[Tuple[str, int, str]], allow: Allowlist,
               denylist: Iterable[Pattern]) -> List[Finding]:
    deny = list(denylist)
    out = []  # type: List[Finding]
    for path, line_no, text in pairs:
        if allow.skips_path(path):
            continue
        for category, value in scan_line(text, deny):
            if not allow.allows_value(value):
                out.append(Finding(path, line_no, category, value))
    return out


def tracked_lines(root: str) -> Iterator[Tuple[str, int, str]]:
    for path in git(["ls-files", "-z"], root).split("\0"):
        if not path:
            continue
        full = os.path.join(root, path)
        if not os.path.isfile(full):
            continue
        with open(full, "rb") as fh:
            data = fh.read()
        if b"\0" in data[:8192]:
            continue  # binary
        for i, text in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            yield path, i, text


def history_added_lines(root: str) -> Iterator[Tuple[str, int, str]]:
    log = git(["log", "--all", "-p", "--no-color", "--no-ext-diff", "-U0", "--format=commit %H"], root)
    return added_lines(log)


def emit(findings: List[Finding], out=None) -> None:
    out = out or sys.stdout
    for f in findings:
        out.write("::error file=%s,line=%d,title=hostname-scan::%s %s\n"
                  % (f.path, f.line, f.category, redact(f.category, f.value)))


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--diff", nargs=2, metavar=("BASE", "HEAD"))
    mode.add_argument("--all", action="store_true")
    mode.add_argument("--history", action="store_true")
    ap.add_argument("--root", default=".")
    ap.add_argument("--allowlist", default=DEFAULT_ALLOWLIST)
    args = ap.parse_args(argv)

    try:
        allow = Allowlist.load(os.path.join(args.root, args.allowlist), args.allowlist)
        deny = compile_denylist(os.environ.get("HOSTNAME_SCAN_DENYLIST", ""))
        if args.diff:
            base, head = args.diff
            text = git(["diff", "--no-color", "--no-ext-diff", "-U0", "--diff-filter=AMRC",
                        "%s...%s" % (base, head)], args.root)
            findings = scan_pairs(added_lines(text), allow, deny)
        elif args.all:
            findings = scan_pairs(tracked_lines(args.root), allow, deny)
        else:
            findings = scan_pairs(history_added_lines(args.root), allow, deny)
    except (RuntimeError, ValueError, re.error) as exc:
        sys.stderr.write("hostname-scan: %s\n" % exc)
        return 2

    if args.history:
        counts = Counter(f.category for f in findings)
        files = len({f.path for f in findings})
        for category, n in sorted(counts.items()):
            print("%-18s %d" % (category, n))
        print("total %d finding(s) in %d path(s) across history" % (len(findings), files))
    else:
        emit(findings)
        print("hostname-scan: %d finding(s)" % len(findings))
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
