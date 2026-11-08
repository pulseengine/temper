"""Self-test for gate_probe.py: a fail-open detector must be caught, a
fail-closed one must pass, and anything that prevents probing fails closed."""

import json
import os
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate_probe  # noqa: E402

# Lists what counts as CODE: anything new is silently "not code" (fails open).
ALLOWLIST = r"""#!/bin/sh
rust=false
while IFS= read -r f; do
  case "$f" in *.rs|Cargo.toml|Cargo.lock|.github/workflows/*) rust=true ;; esac
done < "$GATE_PROBE_FILES"
echo "rust=$rust" >> "$GITHUB_OUTPUT"
"""

# Lists what is NOT code: everything else is code (fails closed).
DENYLIST = r"""#!/bin/sh
rust=false
while IFS= read -r f; do
  case "$f" in *.md|LICENSE) ;; *) rust=true ;; esac
done < "$GATE_PROBE_FILES"
echo "rust=$rust" >> "$GITHUB_OUTPUT"
"""

# Treats docs/ as docs whatever the file type: the negative control's case.
DOCS_DIR = r"""#!/bin/sh
rust=true
while IFS= read -r f; do
  case "$f" in docs/*) rust=false ;; esac
done < "$GATE_PROBE_FILES"
echo "rust=$rust" >> "$GITHUB_OUTPUT"
"""


class Repo:
    def __init__(self, script=None, contract=None):
        self.dir = tempfile.TemporaryDirectory()
        self.root = self.dir.name
        if script is not None:
            p = os.path.join(self.root, "detect.sh")
            with open(p, "w") as f:
                f.write(script)
            os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
        if contract is not None:
            os.makedirs(os.path.join(self.root, ".github"))
            with open(os.path.join(self.root, gate_probe.CONTRACT), "w") as f:
                f.write(contract if isinstance(contract, str) else json.dumps(contract))

    def __enter__(self):
        return self.root

    def __exit__(self, *a):
        self.dir.cleanup()


def contract(**extra):
    d = {"command": ["detect.sh"], "outputs": ["rust"], "negative_controls": ["README.md"]}
    d.update(extra)
    return {"version": 1, "detectors": [d]}


class GateProbeTest(unittest.TestCase):
    def test_denylist_detector_fails_closed(self):
        with Repo(DENYLIST, contract()) as root:
            code, lines = gate_probe.probe(root)
            self.assertEqual(code, 0, lines)
            self.assertEqual(len(lines), len(gate_probe.DEFAULT_CONTROLS) + 1)
            self.assertTrue(lines[-1].startswith("non-code"))

    def test_allowlist_detector_fails_open(self):
        with Repo(ALLOWLIST, contract()) as root:
            code, lines = gate_probe.probe(root)
            self.assertEqual(code, 1, lines)
            self.assertTrue(any(l.startswith("OPEN") and "supply-chain" in l for l in lines))
            # the .rs control is code for an allowlist too: only the new kinds fail
            self.assertTrue(any(l.startswith("closed") and "docs/" in l for l in lines))

    def test_docs_directory_detector_fails_on_rs_under_docs(self):
        with Repo(DOCS_DIR, contract()) as root:
            code, lines = gate_probe.probe(root)
            self.assertEqual(code, 1)
            self.assertTrue(any(l.startswith("OPEN") and "docs/gate-probe-control.rs" in l for l in lines))

    def test_repo_controls_are_added(self):
        with Repo(DENYLIST, contract(controls=["README.md"])) as root:
            code, lines = gate_probe.probe(root)
            self.assertEqual(code, 1)
            self.assertTrue(any("README.md" in l and l.startswith("OPEN") for l in lines))

    def test_detector_that_says_code_for_everything_is_vacuous(self):
        # gale's case: an unknown event runs everything, no file is classified
        always = "#!/bin/sh\necho rust=true >> \"$GITHUB_OUTPUT\"\n"
        with Repo(always, contract()) as root:
            code, lines = gate_probe.probe(root)
            self.assertEqual(code, 1)
            self.assertTrue(any(l.startswith("VACUOUS") and "README.md" in l for l in lines))
        # an output that is missing on the non-code path is not "false" either
        with Repo("#!/bin/sh\ntrue\n", contract()) as root:
            self.assertEqual(gate_probe.probe(root)[0], 1)

    def test_detector_sees_a_pull_request_event(self):
        event = ("#!/bin/sh\nif [ \"$GITHUB_EVENT_NAME\" = pull_request ] && [ \"$EVENT_NAME\" = pull_request ]; then\n"
                 + DENYLIST.split("\n", 1)[1] + "else echo rust=true >> \"$GITHUB_OUTPUT\"; fi\n")
        with Repo(event, contract()) as root:
            self.assertEqual(gate_probe.probe(root)[0], 0)

    def test_missing_contract_fails_closed(self):
        with Repo(DENYLIST) as root:
            self.assertEqual(gate_probe.probe(root)[0], 2)

    def test_invalid_contracts_fail_closed(self):
        for bad in ["{", {"version": 2, "detectors": []}, {"version": 1, "detectors": []},
                    contract(command=[]), contract(outputs=[]), contract(command=["/bin/sh"]),
                    contract(command=["../x.sh"]), contract(controls="docs/x.rs"),
                    contract(negative_controls=[]), contract(negative_controls="README.md"),
                    {"version": 1, "detectors": [{"command": ["detect.sh"], "outputs": ["rust"]}]}]:
            with Repo(DENYLIST, bad) as root:
                self.assertEqual(gate_probe.probe(root)[0], 2, bad)

    def test_detector_that_crashes_or_is_missing_fails_closed(self):
        with Repo("#!/bin/sh\nexit 3\n", contract()) as root:
            code, lines = gate_probe.probe(root)
            self.assertEqual(code, 2)
            self.assertTrue(lines[0].startswith("ERROR"))
        with Repo(None, contract()) as root:
            self.assertEqual(gate_probe.probe(root)[0], 2)

    def test_detector_gets_no_secrets(self):
        os.environ["GATE_PROBE_SECRET"] = "s3cret"
        try:
            leak = ("#!/bin/sh\nif [ -n \"$GATE_PROBE_SECRET\" ]; then echo rust=leak >> \"$GITHUB_OUTPUT\"; exit 0; fi\n"
                    + DENYLIST.split("\n", 1)[1])
            with Repo(leak, contract()) as root:
                self.assertEqual(gate_probe.probe(root)[0], 0)
        finally:
            del os.environ["GATE_PROBE_SECRET"]


if __name__ == "__main__":
    unittest.main()
