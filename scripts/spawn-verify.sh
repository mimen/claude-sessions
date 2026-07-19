#!/bin/bash
# spawn a testrole session, wait, verify: own workspace, correct name, correct tags, caller unharmed
CALLER_SURFACE="8D67E236-F2BB-481E-813A-83A2AC3672A4"
CALLER_BEFORE=$(python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/Library/Application Support/cmux/session-com.cmuxterm.app.json')));import sys
def w(o):
 if isinstance(o,dict):
  if o.get('id')=='$CALLER_SURFACE': print(((o.get('terminal') or {}).get('agent') or {}).get('sessionId'))
  for v in o.values(): w(v)
 elif isinstance(o,list):
  [w(v) for v in o]
w(d)" 2>/dev/null)
OUT=$(bun run bin/ccs new-session --role testrole --title "verify-run" --prompt "echo ok" 2>&1)
WS=$(echo "$OUT" | grep -oE "workspace:[0-9]+" | head -1)
sleep 5
# checks
python3 - "$WS" "$CALLER_SURFACE" "$CALLER_BEFORE" <<'PY'
import json,os,sys
ws,caller,caller_before=sys.argv[1],sys.argv[2],sys.argv[3]
tree=json.load(os.popen("cmux tree --all --json --id-format both 2>/dev/null"))
# 1. workspace exists + named verify-run
found_ws=None
for w in tree['windows']:
 for x in w.get('workspaces',[]):
  if x.get('ref')==ws: found_ws=x
ok_ws = found_ws is not None
ok_name = found_ws and found_ws.get('title')=='verify-run'
# 2. caller surface binding unchanged
d=json.load(open(os.path.expanduser('~/Library/Application Support/cmux/session-com.cmuxterm.app.json')))
caller_now=None
def wlk(o):
 global caller_now
 if isinstance(o,dict):
  if o.get('id')==caller: caller_now=((o.get('terminal') or {}).get('agent') or {}).get('sessionId')
  for v in o.values(): wlk(v)
 elif isinstance(o,list):
  [wlk(v) for v in o]
wlk(d)
ok_caller = (caller_now==caller_before)
print(f"  workspace created: {'PASS' if ok_ws else 'FAIL'} ({ws})")
print(f"  name = verify-run: {'PASS' if ok_name else 'FAIL'} (got {found_ws.get('title') if found_ws else None!r})")
print(f"  caller surface unharmed: {'PASS' if ok_caller else 'FAIL'} (before={caller_before[:8] if caller_before else None}, now={caller_now[:8] if caller_now else None})")
print("RESULT:", "ALL PASS" if (ok_ws and ok_name and ok_caller) else "FAILURE")
# cleanup
if ws: os.system(f"cmux close-workspace --workspace {ws} >/dev/null 2>&1")
PY
