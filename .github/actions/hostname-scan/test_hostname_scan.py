"""Tests for hostname_scan.py (stdlib unittest, Python 3.9+).

Every private-looking fixture is assembled at run time (``_ip``, ``_host``) so
this file's own diff passes the scanner it tests -- the repo dogfoods the check.
"""

import io
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hostname_scan as hs  # noqa: E402


def _ip(*parts):
    return ".".join(str(p) for p in parts)


def _host(*labels):
    return ".".join(labels)


def _v6(*hextets):
    return ":".join(hextets)


def cats(line, deny=()):
    return [c for c, _ in hs.scan_line(line, deny)]


class ScanLineDetects(unittest.TestCase):
    def test_rfc1918(self):
        for addr in (_ip(10, 0, 0, 7), _ip(172, 20, 1, 1), _ip(192, 168, 1, 23)):
            self.assertEqual(cats("host = %s:8080" % addr), ["rfc1918-ipv4"], addr)

    def test_cgnat_and_link_local(self):
        self.assertEqual(cats("peer " + _ip(100, 101, 2, 3)), ["cgnat-ipv4"])
        self.assertEqual(cats("ll " + _ip(169, 254, 10, 1)), ["link-local-ipv4"])

    def test_private_suffixes(self):
        for suffix in ("local", "lan", "internal", "home.arpa", "ts.net", "localdomain", "fritz.box"):
            name = _host("nas", suffix)
            self.assertEqual(cats("ssh %s/share" % name), ["private-hostname"], name)

    def test_ipv6_ula_and_link_local(self):
        self.assertEqual(cats("addr " + _v6("fd12", "3456", "789a", "", "1")), ["ula-ipv6"])
        self.assertEqual(cats("addr " + _v6("fe80", "", "1")), ["link-local-ipv6"])
        self.assertEqual(cats("prefix %s/64" % _v6("fd00", "ab", "", "")), ["ula-ipv6"])

    def test_denylist(self):
        deny = hs.compile_denylist("secret-box\n\n")
        self.assertEqual(cats("ping secret-box now", deny), ["denylisted-name"])


class ScanLineNegativeControls(unittest.TestCase):
    """Values that look similar but are not private infrastructure."""

    def test_documentation_and_public_ipv4(self):
        for addr in (_ip(192, 0, 2, 10), _ip(198, 51, 100, 4), _ip(203, 0, 113, 9),
                     _ip(8, 8, 8, 8), _ip(127, 0, 0, 1), _ip(172, 32, 0, 1)):
            self.assertEqual(cats("addr " + addr), [], addr)

    def test_version_strings(self):
        self.assertEqual(cats("v" + _ip(10, 0, 0, 1, 2)), [])
        self.assertEqual(cats("bump to " + _ip(1, 10, 0, 1)), [])

    def test_filenames_and_code(self):
        for line in ("cp config.local.yml x", "x = self.local", "tls = threading.local()",
                     "see example.com", "obj.home(", "my.localhost.example"):
            self.assertEqual(cats(line), [], line)

    def test_public_and_loopback_ipv6(self):
        for line in ("addr " + _v6("2001", "db8", "", "1"), "lo ::1", "time 12:30:45"):
            self.assertEqual(cats(line), [], line)

    def test_pragma(self):
        self.assertEqual(cats("%s  # hostname-scan: allow" % _ip(10, 1, 1, 1)), [])


class Redaction(unittest.TestCase):
    def test_never_prints_full_value(self):
        cases = [("rfc1918-ipv4", _ip(192, 168, 7, 42)),
                 ("private-hostname", _host("printer", "lan")),
                 ("ula-ipv6", _v6("fd12", "3456", "", "9")),
                 ("denylisted-name", "secret-box")]
        for category, value in cases:
            out = hs.redact(category, value)
            self.assertNotIn(value, out)
        self.assertEqual(hs.redact("private-hostname", _host("printer", "lan")), "p***.lan")
        self.assertEqual(hs.redact("rfc1918-ipv4", _ip(192, 168, 7, 42)), "192.168.x.x")


class DiffParsing(unittest.TestCase):
    def test_added_lines_tracks_numbers(self):
        diff = "\n".join([
            "diff --git a/f.txt b/f.txt",
            "--- a/f.txt",
            "+++ b/f.txt",
            "@@ -1,0 +5,2 @@",
            "+one",
            "+two",
            "@@ -9 +20 @@",
            "-gone",
            "+three",
        ])
        self.assertEqual(list(hs.added_lines(diff)),
                         [("f.txt", 5, "one"), ("f.txt", 6, "two"), ("f.txt", 20, "three")])

    def test_deleted_file_is_ignored(self):
        diff = "--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-" + _ip(10, 0, 0, 1)
        self.assertEqual(list(hs.added_lines(diff)), [])


class EndToEnd(unittest.TestCase):
    """Drive main() against a throwaway git repo."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self._git("init", "-q", "-b", "main")
        self._git("config", "user.email", "t@example.com")
        self._git("config", "user.name", "t")
        self._git("config", "commit.gpgsign", "false")
        self._write("README.md", "hello\n")
        self._commit("base")
        self.base = self._git("rev-parse", "HEAD").strip()

    def tearDown(self):
        self.tmp.cleanup()

    def _git(self, *args):
        return subprocess.run(["git"] + list(args), cwd=self.root, check=True,
                              stdout=subprocess.PIPE, universal_newlines=True).stdout

    def _write(self, rel, text):
        full = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as fh:
            fh.write(text)

    def _commit(self, msg):
        self._git("add", "-A")
        self._git("commit", "-q", "-m", msg)

    def _run(self, *argv):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = hs.main(list(argv) + ["--root", self.root])
        return code, buf.getvalue()

    def test_clean_diff_passes(self):
        self._write("doc.md", "see %s\n" % _ip(192, 0, 2, 1))
        self._commit("doc")
        code, out = self._run("--diff", self.base, "HEAD")
        self.assertEqual(code, 0, out)

    def test_dirty_diff_fails_with_redacted_annotation(self):
        name = _host("nas", "lan")
        self._write("deploy/hosts.txt", "a\n%s\n" % name)
        self._commit("leak")
        code, out = self._run("--diff", self.base, "HEAD")
        self.assertEqual(code, 1)
        self.assertIn("::error file=deploy/hosts.txt,line=2,", out)
        self.assertNotIn(name, out)

    def test_preexisting_value_not_flagged_by_diff(self):
        self._write("old.txt", _ip(10, 9, 9, 9) + "\n")
        self._commit("old")
        mid = self._git("rev-parse", "HEAD").strip()
        self._write("new.txt", "fine\n")
        self._commit("new")
        self.assertEqual(self._run("--diff", mid, "HEAD")[0], 0)
        self.assertEqual(self._run("--all")[0], 1)

    def test_allowlist_path_and_value(self):
        self._write("fixtures/a.txt", _ip(10, 0, 0, 1) + "\n")
        self._write("b.txt", "metadata %s\n" % _host("metadata", "google", "internal"))
        self._write(hs.DEFAULT_ALLOWLIST,
                    "# fixtures are synthetic\npath:fixtures/*\nvalue:metadata\\.google\\.internal\n")
        self._commit("allow")
        code, out = self._run("--diff", self.base, "HEAD")
        self.assertEqual(code, 0, out)

    def test_bad_allowlist_is_usage_error(self):
        self._write(hs.DEFAULT_ALLOWLIST, "nonsense\n")
        self._commit("bad")
        self.assertEqual(self._run("--all")[0], 2)

    def test_history_reports_counts_only(self):
        name = _host("box", "local")
        self._write("x.txt", name + "\n")
        self._commit("leak")
        self._write("x.txt", "removed\n")
        self._commit("fix")
        code, out = self._run("--history")
        self.assertEqual(code, 1)
        self.assertIn("private-hostname", out)
        self.assertNotIn(name, out)
        self.assertEqual(self._run("--all")[0], 0)

    def test_denylist_from_env(self):
        self._write("n.txt", "connect to secret-box\n")
        self._commit("n")
        old = os.environ.get("HOSTNAME_SCAN_DENYLIST")
        os.environ["HOSTNAME_SCAN_DENYLIST"] = "secret-box"
        try:
            code, out = self._run("--diff", self.base, "HEAD")
        finally:
            if old is None:
                del os.environ["HOSTNAME_SCAN_DENYLIST"]
            else:
                os.environ["HOSTNAME_SCAN_DENYLIST"] = old
        self.assertEqual(code, 1)
        self.assertNotIn("secret-box", out)

    def test_bad_ref_is_usage_error(self):
        self.assertEqual(self._run("--diff", "nope", "HEAD")[0], 2)


if __name__ == "__main__":
    unittest.main()
