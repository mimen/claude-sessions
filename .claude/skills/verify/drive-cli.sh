#!/bin/zsh -f
# Drive the core CLI path end to end in a fresh sandbox and write a transcript plus proof.json.
#   drive-cli.sh <evidence-dir>
# Discover two synthetic transcripts, index them, list, search-read one, attach it to the
# catalogue, retitle it, read the title back from the CLI and from SQLite, then try `session save`
# to record the cmux boundary. Evidence lands in <evidence-dir>; the sandbox is removed afterwards.
set -u
out=${1:?usage: drive-cli.sh <evidence-dir>}
out=${out:A}
[[ -e $out ]] && { print -u2 "drive-cli.sh: $out exists; evidence is never reused"; exit 1; }
mkdir -p "$out"
skill=${0:A:h}
repo=${skill:h:h:h}
sandbox=$(mktemp -d /tmp/ccs-verify-cli.XXXXXX)
rmdir "$sandbox"
sandbox_env=$("$skill/sandbox.sh" "$sandbox") || { print -u2 "drive-cli.sh: sandbox setup failed; no ccs ran"; rm -rf "$sandbox"; exit 1; }
eval "$sandbox_env"
cd "$repo"
mkdir -p "$out/owned"

alpha=11111111-1111-4111-8111-111111111111
title="Renamed by verify $(date -u +%H%M%S)"
transcript=$out/cli-transcript.txt
step() {
  local name=$1; shift
  print -r -- "\$ $*" >> "$transcript"
  "$@" >> "$transcript" 2>&1
  local rc=$?
  print -r -- "[exit $rc]" >> "$transcript"
  print -r -- "" >> "$transcript"
  print -r -- "$name $rc" >> "$out/steps.txt"
  return 0
}

"$skill/doctor.sh" > "$out/doctor.txt" 2>&1 || { cat "$out/doctor.txt"; "$skill/teardown.sh" "$out" "$sandbox"; exit 1; }
step reindex ccs reindex
step ls ccs ls
step read ccs session $alpha --json
step attach ccs session-fields $alpha --json '{"customTitle":null}'
step title ccs session title $alpha "$title"
step readback ccs session $alpha --json
step ls-after ccs ls
step save-boundary ccs session save $alpha
step ls-all ccs ls --all
sqlite3 -readonly "$CCS_ROOT/cache/catalogue.db" \
  "select session_id, custom_title from catalogue where session_id='$alpha'" > "$out/catalogue-row.txt"
cp "$sandbox/cmux-calls.log" "$out/cmux-calls.log" 2>/dev/null || : > "$out/cmux-calls.log"
cp "$sandbox/enrich-refused.log" "$out/enrich-refused.log" 2>/dev/null || : > "$out/enrich-refused.log"

python3 - "$out" "$repo" "$skill" "$title" "$sandbox" <<'EOF'
import hashlib, json, pathlib, subprocess, sys
out, repo, skill = (pathlib.Path(p) for p in sys.argv[1:4])
title, sandbox = sys.argv[4], sys.argv[5]
steps = dict(line.split() for line in (out / "steps.txt").read_text().splitlines())
transcript = (out / "cli-transcript.txt").read_text()
row = (out / "catalogue-row.txt").read_text().strip()
writes = [l for l in (out / "cmux-calls.log").read_text().splitlines()
          if l.split()[1:2] and l.split()[1] not in ("tree", "events", "--version", "list-status", "list-notifications", "sidebar-state")]
alpha = "11111111-1111-4111-8111-111111111111"
refused = (out / "enrich-refused.log").read_text().splitlines()
checks = {
    "indexed both transcripts": "Indexed 2 sessions" in transcript,
    "ls lists both": transcript.count("Verify beta session") >= 1 and "Verify alpha session" in transcript,
    "title persisted in catalogue.db": row.endswith("|" + title),
    "title read back through ccs session": f'"customTitle": "{title}"' in transcript,
    "core steps exit 0": all(steps[s] == "0" for s in ("reindex", "ls", "read", "attach", "title", "readback", "ls-after")),
    "no cmux write verbs reached cmux": not writes,
    # rc 1 + "close refused" without a reachable cmux socket; rc 0 when live cmux says session-not-live.
    "save recorded lifecycle, closed no workspace": steps["ls-all"] == "0"
        and " saved " in transcript.split("$ ccs ls --all")[1]
        and (steps["save-boundary"] == "0" or "workspace close refused" in transcript),
    "save's enrichment was refused, not sent": any(l.endswith(f"refused ccs enrich {alpha}") for l in refused),
}
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
proof = {
    "source_sha": subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip(),
    "source_dirty": subprocess.run(["git", "-C", str(repo), "status", "--porcelain", "--", "src", "tui-go", "bin"], capture_output=True, text=True).stdout.strip() != "",
    "helper_sha256": {p.name: sha(p) for p in sorted(skill.glob("*.sh"))},
    "sandbox": sandbox,
    "title": title,
    "steps": steps,
    "checks": checks,
    "passed": all(checks.values()),
}
(out / "proof.json").write_text(json.dumps(proof, indent=2) + "\n")
print(json.dumps({"passed": proof["passed"], "checks": checks}, indent=2))
sys.exit(0 if proof["passed"] else 1)
EOF
rc=$?
cd /
"$skill/teardown.sh" "$out" "$sandbox" > "$out/teardown.txt" 2>&1 || rc=1
cat "$out/teardown.txt"
print "evidence: $out"
exit $rc
