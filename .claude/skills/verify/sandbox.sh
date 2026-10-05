#!/bin/zsh -f
# Build an isolated ccs world and print the env that points the CLI, the catalogue daemon,
# the Go TUI and the sidebar server at it. Usage:
#   eval "$(.claude/skills/verify/sandbox.sh <dir>)"
# Creates <dir> with two synthetic sessions; refuses any path that already exists.
set -eu
dir=${1:?usage: sandbox.sh <dir>}
dir=${dir:A}
skill=${0:A:h}
repo=${skill:h:h:h}

if [[ -e $dir ]]; then
  print -u2 "sandbox.sh: $dir exists; every drive uses a fresh path"
  exit 1
fi
mkdir -p "$dir"/{root,store/-tmp-ccs-verify-alpha,store/-tmp-ccs-verify-beta,tasks,xdg,bin}
touch "$dir/.ccs-verify-sandbox"
print -r -- '{"sessions":{},"activeSessionsBySurface":{}}' > "$dir/cmux-hook-sessions.json"

cat > "$dir/root/config.toml" <<EOF
[store]
path = "$dir/store"
[host]
label = "ccs-verify"
[resume]
target = "inline"
[inference.codex]
binary = "$dir/bin/no-inference"
[inference.claude]
binary = "$dir/bin/no-inference"
EOF
ln -s "$repo/src/models/fixtures/models.toml" "$dir/root/models.toml"

# Two transcripts in Claude Code's JSONL shape. Ids are fixed so drives can name them.
write_session() {
  local file=$1 cwd=$2 title=$3 first=$4 when=$5
  {
    print -r -- "{\"type\":\"user\",\"cwd\":\"$cwd\",\"gitBranch\":\"main\",\"version\":\"2.1.156\",\"timestamp\":\"${when}T10:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"$first\"}}"
    print -r -- "{\"type\":\"assistant\",\"timestamp\":\"${when}T10:00:05Z\",\"message\":{\"model\":\"claude-opus-5-5\",\"content\":[{\"type\":\"text\",\"text\":\"Synthetic verify reply.\"}],\"usage\":{\"input_tokens\":1200,\"output_tokens\":300}}}"
    print -r -- "{\"type\":\"ai-title\",\"aiTitle\":\"$title\"}"
  } > "$file"
}
write_session "$dir/store/-tmp-ccs-verify-alpha/11111111-1111-4111-8111-111111111111.jsonl" \
  /tmp/ccs-verify-alpha "Verify alpha session" "Plan the alpha checkout flow" 2026-10-03
write_session "$dir/store/-tmp-ccs-verify-beta/22222222-2222-4222-8222-222222222222.jsonl" \
  /tmp/ccs-verify-beta "Verify beta session" "Debug the beta importer" 2026-10-04

# cmux guard: reads pass to the real cmux so liveness logic runs, every write is refused and logged.
real_cmux=$(command -v cmux || true)
cat > "$dir/bin/cmux" <<EOF
#!/bin/zsh -f
print -r -- "\$(date -u +%FT%TZ) \$*" >> "$dir/cmux-calls.log"
case "\$1" in
  tree|events|list-status|list-notifications|sidebar-state|--version)
    [[ -n "$real_cmux" ]] && exec "$real_cmux" "\$@"; exit 1 ;;
  *) print -u2 "ccs-verify cmux guard: refused write verb '\$1'"; exit 97 ;;
esac
EOF
# t3 and inference guards: a sandbox never opens T3 or calls a model provider.
for guard in t3 no-inference; do
  print -r -- "#!/bin/sh
echo \"ccs-verify $guard guard: refused \$*\" >&2; exit 97" > "$dir/bin/$guard"
done
# ccs wrapper: lifecycle verbs detach `ccs enrich`, which posts a transcript to the model gateway.
cat > "$dir/bin/ccs" <<EOF
#!/bin/zsh -f
if [[ "\$1" == enrich ]]; then
  print -r -- "\$(date -u +%FT%TZ) refused ccs \$*" >> "$dir/enrich-refused.log"
  exit 97
fi
exec "$repo/bin/ccs" "\$@"
EOF
chmod +x "$dir/bin/cmux" "$dir/bin/t3" "$dir/bin/no-inference" "$dir/bin/ccs"

cat <<EOF
export CCS_VERIFY_SANDBOX='$dir'
export CCS_ROOT='$dir/root'
export CCS_TASKS_PATH='$dir/tasks'
export CCS_SKILLS_DB_PATH='$dir/root/cache/skills.db'
export CCS_MODEL_REGISTRY_PATH='$dir/root/models.toml'
export CCS_CONFIG_ROOT='$dir/root/config-root'
export CCS_AGENTS_ROOT='$dir/root/agents'
export CCS_BIN='$dir/bin/ccs'
export CCS_BINARY='$dir/bin/ccs'
export CCS_INFERENCE_ENGINE=claude
export CMUX_BIN='$dir/bin/cmux'
export CMUX_HOOK_STORE_PATH='$dir/root/../cmux-hook-sessions.json'
export T3_BIN='$dir/bin/t3'
export XDG_CONFIG_HOME='$dir/xdg'
export PATH='$dir/bin':"\$PATH"
unset CLAUDE_CODE_SESSION_ID CMUX_WORKSPACE_ID CMUX_SURFACE_ID
EOF
