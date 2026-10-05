#!/bin/zsh -f
# Start, adopt, check and stop processes a verify run owns, by recorded identity rather than by name.
#   own.sh start    <run-dir> <name> <port> -- <command...>  start it; record pid, start time, argv, checkout, port
#   own.sh adopt    <run-dir> <name> <pid>                   record a process the CLI spawned for this sandbox
#   own.sh check    <run-dir> <name>                         print identity + listener; exit 1 if it no longer matches
#   own.sh stop     <run-dir> <name>                         kill only if pid, start time and argv still match
#   own.sh stop-all <run-dir>                                stop every record; exit 1 if any stop refused
# Records live in <run-dir>/owned/<name>.json; process output in <run-dir>/owned/<name>.log.
set -eu
cmd=${1:?usage: own.sh start|adopt|check|stop|stop-all <run-dir> ...}
run=${2:?run dir required}
mkdir -p "$run/owned"
checkout=${0:A:h:h:h:h}

started_of() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/  */ /g;s/^ //'; }
argv_of() { ps -o command= -p "$1" 2>/dev/null; }
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }

record_process() {
  local record=$1 pid=$2 port=$3
  python3 - "$record" "$pid" "$(started_of $pid)" "$(argv_of $pid)" "$checkout" "$port" <<'EOF'
import json, sys
path, pid, started, argv, checkout, port = sys.argv[1:]
json.dump({"pid": int(pid), "started": started, "argv": argv, "checkout": checkout,
           "port": int(port) if port else None}, open(path, "w"), indent=2)
EOF
}

matches() {
  local record=$1 pid
  pid=$(field "$record" pid)
  [[ -n $(started_of $pid) && $(started_of $pid) == "$(field "$record" started)" && $(argv_of $pid) == "$(field "$record" argv)" ]]
}

case $cmd in
start)
  name=${3:?name required}; port=${4:?port required}; shift 4
  [[ ${1:-} == -- ]] && shift
  record="$run/owned/$name.json"
  [[ -e $record ]] && { print -u2 "own.sh: $record exists; a run never reuses a name"; exit 1; }
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    print -u2 "own.sh: port $port already has a listener; pick another"; exit 1
  fi
  "$@" > "$run/owned/$name.log" 2>&1 &!
  pid=$!
  sleep 0.3
  [[ -z $(started_of $pid) ]] && { print -u2 "own.sh: $name exited at once; see $run/owned/$name.log"; exit 1; }
  record_process "$record" $pid "$port"
  print "$name pid=$pid port=$port"
  ;;
adopt)
  name=${3:?name required}; pid=${4:?pid required}
  record="$run/owned/$name.json"
  [[ -e $record ]] && { print -u2 "own.sh: $record exists; a run never reuses a name"; exit 1; }
  [[ -z $(started_of $pid) ]] && { print -u2 "own.sh: pid $pid is not running"; exit 1; }
  record_process "$record" $pid ""
  print "$name pid=$pid adopted"
  ;;
check)
  name=${3:?name required}
  record="$run/owned/$name.json"
  [[ -f $record ]] || { print -u2 "own.sh: no record for $name"; exit 1; }
  pid=$(field "$record" pid); port=$(field "$record" port)
  matches "$record" || { print "$name: FAIL pid $pid gone or reused"; exit 1; }
  print "$name: pid=$pid started='$(field "$record" started)' checkout=$(field "$record" checkout)"
  if [[ $port != None ]]; then
    listener=$(lsof -nP -a -p $pid -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}' | sort -u | tr '\n' ' ')
    [[ -z $listener ]] && { print "$name: FAIL pid $pid is not listening on $port"; exit 1; }
    print "$name: listening $listener"
  fi
  ;;
stop)
  name=${3:?name required}
  record="$run/owned/$name.json"
  [[ -f $record ]] || { print -u2 "own.sh: no record for $name"; exit 1; }
  pid=$(field "$record" pid)
  if [[ -z $(started_of $pid) ]]; then print "$name pid=$pid already gone"; exit 0; fi
  matches "$record" || { print -u2 "own.sh: pid $pid no longer matches $name's record (pid reuse); not killing"; exit 1; }
  kill -TERM $pid
  for _ in {1..50}; do [[ -z $(started_of $pid) ]] && break; sleep 0.1; done
  [[ -n $(started_of $pid) ]] && { print -u2 "own.sh: $name pid=$pid ignored TERM"; exit 1; }
  print "$name pid=$pid stopped"
  ;;
stop-all)
  rc=0
  for record in "$run"/owned/*.json(N); do "$0" stop "$run" "${record:t:r}" || rc=1; done
  exit $rc
  ;;
*) print -u2 "own.sh: unknown command $cmd"; exit 2 ;;
esac
