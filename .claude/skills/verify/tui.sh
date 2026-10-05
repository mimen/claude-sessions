#!/bin/zsh -f
# Serve the real Go TUI (`bin/ccs`) in a PTY over ttyd so a browser can drive and record it.
#   tui.sh start <evidence-dir> [port]   fresh sandbox, doctor, owned ttyd, prints the URL to open
#   tui.sh url   <evidence-dir>          credentialed URL, for the browser only
#   tui.sh stop  <evidence-dir>          copy sandbox logs and catalogue rows, then teardown.sh
# ttyd binds the tailnet interface because the T3 browser cannot reach this Mac's loopback. It
# runs with --once, --check-origin and a random BasicAuth credential. The credential lives only in
# <sandbox>/ttyd.cred (mode 600) and is removed with the sandbox; it never enters the evidence.
# A failed start runs the same cleanup as stop, so no listener or sandbox outlives it.
set -eu
cmd=${1:?usage: tui.sh start|url|stop <evidence-dir> [port]}
out=${2:?evidence dir required}
out=${out:A}
skill=${0:A:h}
repo=${skill:h:h:h}

finish() {
  local sandbox=$(<"$out/sandbox-path") rc=0
  [[ -f $sandbox/.ccs-verify-sandbox ]] || { print -u2 "tui.sh: $sandbox is not a sandbox"; return 1; }
  cp "$sandbox/cmux-calls.log" "$sandbox/enrich-refused.log" "$out/" 2>/dev/null || :
  sqlite3 -readonly "$sandbox/root/cache/catalogue.db" \
    "select session_id, custom_title from catalogue" > "$out/catalogue-rows.txt" 2>/dev/null || :
  if [[ -f $sandbox/ttyd.cred ]]; then
    local cred=$(<"$sandbox/ttyd.cred")
    sed -i '' "s|$cred|<redacted>|g" "$out/owned/ttyd.log" 2>/dev/null || :
  fi
  # Until ttyd is confirmed stopped, the evidence record stays a link to the private record in the
  # sandbox, so a retry of `tui.sh stop` can still prove identity and kill it.
  if [[ -L $out/owned/ttyd.json ]]; then
    if "$skill/own.sh" stop "$out" ttyd; then
      rm -f "$out/owned/ttyd.json"
      mv "$out/owned/ttyd.json.redacted" "$out/owned/ttyd.json"
    else
      print -u2 "tui.sh: ttyd stop refused; kept $sandbox and $out/sandbox-path for retry"
      return 1
    fi
  fi
  "$skill/teardown.sh" "$out" "$sandbox" || rc=1
  (( rc == 0 )) && rm -f "$out/sandbox-path"
  return $rc
}

case $cmd in
start)
  port=${3:-7699}
  [[ -e $out ]] && { print -u2 "tui.sh: $out exists; evidence is never reused"; exit 1; }
  mkdir -p "$out/owned"
  sandbox=$(mktemp -d /tmp/ccs-verify-tui.XXXXXX); rmdir "$sandbox"
  sandbox_env=$("$skill/sandbox.sh" "$sandbox") || { print -u2 "tui.sh: sandbox setup failed; no ccs ran"; rm -rf "$sandbox"; exit 1; }
  eval "$sandbox_env"
  print -r -- "$sandbox" > "$out/sandbox-path"
  started=0
  trap '(( started )) || { print -u2 "tui.sh: start failed; cleaning up"; finish || print -u2 "tui.sh: cleanup refused; see teardown output"; }' EXIT
  "$skill/doctor.sh" > "$out/doctor.txt" 2>&1 || { cat "$out/doctor.txt"; exit 1; }
  (cd "$repo" && ./bin/ccs reindex) > "$out/reindex.txt" 2>&1
  (cd "$repo/tui-go" && go build -o .bin/ccs-go .)
  addr=$(tailscale ip -4 2>/dev/null | head -1)
  iface=$(ifconfig | awk -v ip="$addr" '/^[a-z0-9]+:/{i=$1} $1=="inet" && $2==ip {sub(":","",i); print i}')
  [[ -z $iface ]] && { print -u2 "tui.sh: no tailnet interface for '$addr'"; exit 1; }
  (umask 077; print -r -- "verify:$(openssl rand -hex 16)" > "$sandbox/ttyd.cred")
  print -r -- "http://$addr:$port/" > "$out/url"
  "$skill/own.sh" start "$out" ttyd "$port" -- \
    ttyd -p "$port" -i "$iface" -W -o -O -c "$(<"$sandbox/ttyd.cred")" -t fontSize=13 \
    zsh -fc "cd '$repo' && exec ./bin/ccs"
  # The live record carries the credential in argv; evidence keeps only a redacted copy.
  python3 - "$out/owned/ttyd.json" "$(<"$sandbox/ttyd.cred")" <<'EOF'
import json, sys
path, cred = sys.argv[1:]
record = json.load(open(path))
open(path + ".redacted", "w").write(json.dumps({**record, "argv": record["argv"].replace(cred, "<redacted>")}, indent=2))
EOF
  mv "$out/owned/ttyd.json" "$sandbox/ttyd.owned.json"
  ln -s "$sandbox/ttyd.owned.json" "$out/owned/ttyd.json"
  "$skill/doctor.sh" "$out" > "$out/doctor-owned.txt" 2>&1 || { cat "$out/doctor-owned.txt"; exit 1; }
  started=1
  print "open: $(<"$out/url")  (credentialed URL: tui.sh url $out)"
  ;;
url)
  sandbox=$(<"$out/sandbox-path")
  print -r -- "$(<"$out/url" | sed "s|http://|http://$(<"$sandbox/ttyd.cred")@|")"
  ;;
stop)
  finish
  ;;
*) print -u2 "tui.sh: unknown command $cmd"; exit 2 ;;
esac
