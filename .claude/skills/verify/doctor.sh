#!/bin/zsh -f
# Read-only: is this checkout and this sandbox worth driving? One line per fact; exit 1 on a blocker.
# Usage: eval "$(sandbox.sh <dir>)"; doctor.sh [<evidence-dir>]
# With an evidence dir, also checks every owned process: same pid, start time and argv, the
# listener it should hold, and that it was started from this checkout.
set -u -o pipefail
repo=${0:A:h:h:h:h}
fail=0
say() { print -r -- "$1: $2"; }
bad() { say "$1" "FAIL $2"; fail=1; }

say checkout "$repo @ $(git -C "$repo" rev-parse --short HEAD)$(git -C "$repo" diff --quiet HEAD -- src tui-go bin || print ' (dirty src/tui-go/bin)')"
for tool in bun go sqlite3 ttyd; do
  command -v $tool >/dev/null && say $tool "$(command -v $tool)" || bad $tool "not on PATH"
done
[[ -d $repo/node_modules ]] && say node_modules present || bad node_modules "missing; run bun install --frozen-lockfile"

if [[ -z ${CCS_VERIFY_SANDBOX:-} || ! -f ${CCS_VERIFY_SANDBOX:-/nonexistent}/.ccs-verify-sandbox ]]; then
  bad sandbox "not active; eval \"\$(.claude/skills/verify/sandbox.sh <dir>)\" first"
else
  say sandbox "$CCS_VERIFY_SANDBOX"
  [[ ${CCS_ROOT:-} == $CCS_VERIFY_SANDBOX/* ]] && say CCS_ROOT "$CCS_ROOT" || bad CCS_ROOT "${CCS_ROOT:-unset} is outside the sandbox"
  [[ ${CMUX_BIN:-} == $CCS_VERIFY_SANDBOX/bin/cmux ]] && say cmux-guard on || bad cmux-guard "CMUX_BIN=${CMUX_BIN:-unset}"
  [[ $(command -v ccs) == $CCS_VERIFY_SANDBOX/bin/ccs ]] && say ccs-guard on || bad ccs-guard "ccs resolves to $(command -v ccs)"
  store=$(sed -n 's/^path = "\(.*\)"/\1/p' "$CCS_ROOT/config.toml")
  say store "$store ($(find "$store" -name '*.jsonl' | wc -l | tr -d ' ') transcripts)"
  [[ $store == $CCS_VERIFY_SANDBOX/* ]] || bad store "store is outside the sandbox"
  if [[ -S $CCS_ROOT/run/native-catalogue-v1.sock ]]; then
    say catalogue-daemon "running (sandbox socket; exits after 30s idle)"
  else
    say catalogue-daemon "not running (starts on demand)"
  fi
fi
if [[ -n ${1:-} ]]; then
  for record in "$1"/owned/*.json(N); do
    "${0:A:h}/own.sh" check "$1" "${record:t:r}" | sed 's/verify:[0-9a-f]*/<redacted>/g' || fail=1
    [[ $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["checkout"])' "$record") == "$repo" ]] \
      || bad "${record:t:r}" "owned process belongs to another checkout"
  done
fi
exit $fail
