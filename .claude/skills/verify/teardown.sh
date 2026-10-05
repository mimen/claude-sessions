#!/bin/zsh -f
# Stop everything a run owns, then remove its sandbox only when nothing owned is still alive.
#   teardown.sh <evidence-dir> <sandbox>
# The catalogue daemon is spawned by the CLI, not by us; it is adopted from the sandbox's own lock
# file, so a daemon serving the real ~/.ccs is never a candidate. Evidence is never touched.
set -u
out=${1:?usage: teardown.sh <evidence-dir> <sandbox>}
sandbox=${${2:?sandbox required}:A}
skill=${0:A:h}
[[ -f $sandbox/.ccs-verify-sandbox ]] || { print -u2 "teardown.sh: $sandbox is not a sandbox; keeping it"; exit 1; }

owner=$sandbox/root/run/native-catalogue.lock/owner.json
rc=0
if [[ -f $owner && ! -e $out/owned/catalogue-daemon.json ]]; then
  pid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$owner")
  if ps -p "$pid" >/dev/null 2>&1; then
    # The lock may be stale and its pid reused: adopt only a catalogue-service whose env names this sandbox.
    command=$(ps -o command= -p "$pid")
    root=$(ps eww -o command= -p "$pid" | tr ' ' '\n' | sed -n 's/^CCS_ROOT=//p')
    if [[ $command == *"catalogue-service serve"* && $root == "$sandbox/root" ]]; then
      "$skill/own.sh" adopt "$out" catalogue-daemon "$pid" || rc=1
    else
      print -u2 "teardown.sh: lock names pid $pid, which is not this sandbox's catalogue service; not touching it"
      rc=1
    fi
  fi
fi
"$skill/own.sh" stop-all "$out" || rc=1
if [[ -S $sandbox/root/run/native-catalogue-v1.sock && -f $owner ]]; then
  print -u2 "teardown.sh: sandbox catalogue daemon still holds its lock; keeping $sandbox"
  rc=1
fi
if (( rc == 0 )); then
  rm -rf "$sandbox"
  print "sandbox removed: $sandbox"
else
  print -u2 "teardown.sh: a stop refused; kept $sandbox for inspection"
fi
exit $rc
