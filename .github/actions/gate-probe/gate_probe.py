#!/usr/bin/env python3
"""Behavioural probe: does a repo's change detector fail closed?

GitHub counts a skipped job as a passing required check, so a change detector
that decides which required jobs run must treat every unknown kind of input as
code. Reading the detector cannot show which way it fails; running it can.

The repo declares its detectors in .github/gate-probe.json:

    {"version": 1,
     "detectors": [{"command": ["tools/ci/detect-changes.sh"],
                    "outputs": ["rust"],
                    "negative_controls": ["docs/architecture.md"],
                    "exempt_outputs": {"rust": "why this tier may skip"},
                    "controls": ["optional/extra/path.rs"]}]}

For each control path (the defaults below, plus the detector's own), the probe
runs the command with the changed-file list in the file named by
$GATE_PROBE_FILES and a fresh $GITHUB_OUTPUT, and requires every listed output
to be "true". A detector that says "no code changed" for a .rs file under
docs/ or a file in a new top-level directory fails open.

A probe that cannot go red proves nothing: a detector that answers "true" for
everything (for example because it runs all jobs on an unknown event) would
pass the controls without classifying a single file. So every detector also
names `negative_controls` paths, and must answer "false" for each of them; otherwise
its classification was not exercised and the probe fails. The detector sees
EVENT_NAME=GITHUB_EVENT_NAME=pull_request, as in a real PR.

A tiered detector declares in `outputs` the tier that gates the always-
required checks. Any other output that gates a required check goes in
`exempt_outputs` with a reason; temper's static check flags an output that is
in neither. The probe does not run exempt outputs.

Exit 0: every detector fails closed. 1: a detector fails open. 2: the contract
is missing or invalid, or a detector did not run (fail closed).
Standard library only; Python 3.9 floor.
"""

import json
import os
import subprocess
import sys
import tempfile

CONTRACT = ".github/gate-probe.json"
DEFAULT_CONTROLS = [
    "docs/gate-probe-control.rs",
    "supply-chain/gate-probe-control.toml",
    "gate-probe-new-dir/control.bin",
]
TIMEOUT_S = 120


def load_contract(root):
    path = os.path.join(root, CONTRACT)
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except FileNotFoundError:
        raise ValueError("%s not found" % CONTRACT)
    except json.JSONDecodeError as e:
        raise ValueError("%s is not JSON (line %d)" % (CONTRACT, e.lineno))
    if not isinstance(doc, dict) or doc.get("version") != 1:
        raise ValueError("%s: version must be 1" % CONTRACT)
    dets = doc.get("detectors")
    if not isinstance(dets, list) or not dets:
        raise ValueError("%s: detectors must be a non-empty list" % CONTRACT)
    for i, d in enumerate(dets):
        cmd = d.get("command") if isinstance(d, dict) else None
        outs = d.get("outputs") if isinstance(d, dict) else None
        ctl = d.get("controls", []) if isinstance(d, dict) else None
        nc = d.get("negative_controls") if isinstance(d, dict) else None
        if not (isinstance(cmd, list) and cmd and all(isinstance(c, str) and c for c in cmd)):
            raise ValueError("detectors[%d].command must be a non-empty list of strings" % i)
        exe = os.path.normpath(cmd[0])
        if os.path.isabs(exe) or exe.startswith(".."):
            raise ValueError("detectors[%d].command[0] must be a repo-relative path" % i)
        if not (isinstance(outs, list) and outs and all(isinstance(o, str) and o for o in outs)):
            raise ValueError("detectors[%d].outputs must be a non-empty list of strings" % i)
        if not (isinstance(ctl, list) and all(isinstance(c, str) and c for c in ctl)):
            raise ValueError("detectors[%d].controls must be a list of strings" % i)
        ex = d.get("exempt_outputs", {}) if isinstance(d, dict) else None
        if not (isinstance(ex, dict) and all(isinstance(k, str) and k and isinstance(v, str) and v.strip()
                                              and k not in (outs or []) for k, v in ex.items())):
            raise ValueError("detectors[%d].exempt_outputs must map output names (not in outputs) to a reason" % i)
        if not (isinstance(nc, list) and nc and all(isinstance(c, str) and c for c in nc)):
            raise ValueError("detectors[%d].negative_controls must be a non-empty list of paths the detector classifies as not code" % i)
    return dets


def parse_outputs(text):
    out = {}
    for line in text.splitlines():
        if "=" in line and "<<" not in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def run_detector(root, command, changed):
    """Run once for one changed-file list; returns the outputs it wrote."""
    with tempfile.TemporaryDirectory() as tmp:
        files = os.path.join(tmp, "changed.txt")
        output = os.path.join(tmp, "output.txt")
        with open(files, "w", encoding="utf-8") as f:
            f.write("\n".join(changed) + "\n")
        open(output, "w").close()
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": tmp,
            "GATE_PROBE_FILES": files,
            "GITHUB_OUTPUT": output,
            "EVENT_NAME": "pull_request",
            "GITHUB_EVENT_NAME": "pull_request",
        }
        exe = os.path.join(root, os.path.normpath(command[0]))
        proc = subprocess.run([exe] + command[1:], cwd=root, env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=TIMEOUT_S)
        if proc.returncode != 0:
            raise RuntimeError("exit %d" % proc.returncode)
        with open(output, encoding="utf-8") as f:
            return parse_outputs(f.read())


def probe(root):
    """Returns (exit_code, report lines)."""
    try:
        dets = load_contract(root)
    except ValueError as e:
        return 2, ["contract: %s" % e]
    lines = []
    worst = 0
    for d in dets:
        name = " ".join(d["command"])
        for control in DEFAULT_CONTROLS + d.get("controls", []):
            try:
                outs = run_detector(root, d["command"], [control])
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as e:
                lines.append("ERROR  %s on %s: did not run (%s)" % (name, control, type(e).__name__ if not isinstance(e, RuntimeError) else e))
                worst = max(worst, 2)
                continue
            open_ = [o for o in d["outputs"] if outs.get(o) != "true"]
            if open_:
                lines.append("OPEN   %s on %s: %s not true" % (name, control, ",".join(open_)))
                worst = max(worst, 1)
            else:
                lines.append("closed %s on %s" % (name, control))
        for path in d["negative_controls"]:
            try:
                outs = run_detector(root, d["command"], [path])
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as e:
                lines.append("ERROR  %s on %s: did not run (%s)" % (name, path, type(e).__name__ if not isinstance(e, RuntimeError) else e))
                worst = max(worst, 2)
                continue
            unexercised = [o for o in d["outputs"] if outs.get(o) != "false"]
            if unexercised:
                lines.append("VACUOUS %s on %s: %s not false; classification not exercised" % (name, path, ",".join(unexercised)))
                worst = max(worst, 1)
            else:
                lines.append("non-code %s on %s" % (name, path))
    return worst, lines


def main(argv):
    root = argv[1] if len(argv) > 1 else os.getcwd()
    code, lines = probe(root)
    for line in lines:
        print(line)
    print({0: "gate-probe: every detector fails closed",
           1: "gate-probe: a detector FAILS OPEN or its classification was not exercised",
           2: "gate-probe: could not probe (failing closed)"}[code])
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
