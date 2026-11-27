#!/usr/bin/env bash
# Runs the wasm32-wasip2 build with the same cases as wasi-smoke.mjs, under
# wasmtime (the component as built) or kiln (the component after
# `meld fuse --reproducible`; kiln runs fused components only).
# Usage: wasip2-smoke.sh <wasmtime|kiln> <runner binary> <module.wasm> <repo root>
set -euo pipefail
mode=$1; bin=$2; wasm=$3; root=$4
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cp -R "$root/templates/readme" "$dir/t"
printf 'format: 1\nname: zwinger\none_liner: "Confines an agent."\nstatus: active\nlicence: MIT\n' > "$dir/vars.yaml"
printf 'x\n<!-- pulseengine:licence -->\nold\n<!-- /pulseengine:licence -->\n' > "$dir/README.md"
case "$mode" in
  wasmtime) g=/work; run() { "$bin" run --dir "$dir::/work" "$wasm" "$@"; } ;;
  kiln) g=$dir; run() { "$bin" --dir "$dir" "$wasm" "$@"; } ;;
  *) echo "mode must be wasmtime or kiln" >&2; exit 2 ;;
esac
check=(check --format json --variables "$g/vars.yaml" --readme "$g/README.md" --templates "$g/t")

test "$(run interface-version)" = "1"
out=$(run "${check[@]}")
echo "$out" | grep -q '"interface":1,"code":"divergent_undeclared"'
want='x\n<!-- pulseengine:licence -->\nMIT. Issues and pull requests are welcome.\n<!-- /pulseengine:licence -->\n'
echo "$out" | grep -qF "\"readme\":\"$want\""
printf 'x\n<!-- pulseengine:licence -->\nMIT. Issues and pull requests are welcome.\n<!-- /pulseengine:licence -->\n' > "$dir/README.md"
run "${check[@]}" | grep -q '"code":"ok"'
# A path outside the preopen is unreadable: exit 1, nothing on stdout.
set +e; out=$(run check --format json --variables /etc/hosts --readme "$g/README.md" --templates "$g/t" 2>/dev/null); rc=$?; set -e
test "$rc" -eq 1 && test -z "$out"
# Exit 2 needs a Rust 1.100 build (wasi:cli/exit exit-with-code) and
# main ending in std::process::exit; an older build reaches the host as 1.
set +e; err=$(run --no-such-flag 2>&1 >/dev/null); rc=$?; set -e
test "$rc" -eq 2
echo "$err" | grep -q "unknown command or flag"
echo "wasip2 smoke ($mode): 6 runs ok"
