#!/usr/bin/env bash
# Stage a sidebar release and install (or reinstall) its LaunchAgent.
#
# Usage: install-sidebar-agent.sh [main|fork] [<commit-ish>]
#
# Two instances run side by side, each serving a different cmux application: `main` on 8787
# against the official cmux socket, `fork` on 8788 against the isolated `cmux CCS.app` socket.
# They differ only in port, socket, and identity ref, so they share one plist template rather
# than drifting as two hand-maintained files.
#
# A release is a `git archive` export of one commit into ~/.local/share/ccs/sidebar-releases/<sha>,
# never a worktree: worktrees are disposable and must not be load-bearing for a long-lived service.
# Staging and installing live in one script because doing them separately is how a plist ends up
# pointing at a SHA nobody exported.
set -euo pipefail

INSTANCE="${1:-main}"
COMMITISH="${2:-HEAD}"

case "$INSTANCE" in
  main) PORT=8787; SOCKET="${HOME}/.local/state/cmux/cmux.sock"; LABEL="com.milad.ccs.sidebar" ;;
  fork) PORT=8788; SOCKET="/tmp/cmux-staging-ccs.sock";          LABEL="com.milad.ccs.sidebar-fork" ;;
  *) echo "usage: $(basename "$0") [main|fork] [<commit-ish>]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO_ROOT" rev-parse --short "$COMMITISH")"
RELEASE_ROOT="${HOME}/.local/share/ccs/sidebar-releases"
RELEASE="${RELEASE_ROOT}/${SHA}"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
CCS_BIN="${RELEASE}/bin/ccs"
LOCK_FILE="${HOME}/.local/state/ccs/sidebar-installer.lock"
STAGING=""
NEW_PLIST=""
PREVIOUS_PLIST=""
HAD_PREVIOUS=0
DEPLOYMENT_STARTED=0
INSTALL_VALIDATED=0
LOCK_HELD=0

bootout_agent() {
  local _

  if ! launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
    return 0
  fi

  launchctl bootout "gui/$(id -u)/${LABEL}" || return 1
  for _ in $(seq 1 40); do
    if ! launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done

  echo "${LABEL} did not finish unloading" >&2
  return 1
}

rollback_install() {
  local rollback_pid=""
  local rollback_ready=0
  local _

  set +e
  bootout_agent >/dev/null 2>&1

  if [[ "$HAD_PREVIOUS" -eq 1 && -n "$PREVIOUS_PLIST" && -f "$PREVIOUS_PLIST" ]]; then
    if ! mv -f "$PREVIOUS_PLIST" "$DEST"; then
      echo "install failed; could not restore previous plist at ${DEST}" >&2
      return
    fi
    PREVIOUS_PLIST=""
    if launchctl bootstrap "gui/$(id -u)" "$DEST"; then
      for _ in $(seq 1 40); do
        rollback_pid="$(launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9]*\)$/\1/p')"
        if [[ -n "$rollback_pid" ]] && curl --fail --silent "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
          rollback_ready=1
          break
        fi
        sleep 0.25
      done
    fi

    if [[ "$rollback_ready" -eq 1 ]]; then
      echo "install failed; restored previous ${LABEL} (pid ${rollback_pid})" >&2
    else
      echo "install failed; previous plist was restored but ${LABEL} did not become healthy" >&2
    fi
  else
    rm -f "$DEST"
    echo "install failed; removed failed first-time ${LABEL} installation" >&2
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP

  if [[ "$DEPLOYMENT_STARTED" -eq 1 && "$INSTALL_VALIDATED" -eq 0 ]]; then
    rollback_install
  fi

  if [[ -n "$STAGING" && -d "$STAGING" ]]; then
    rm -rf "$STAGING"
  fi
  if [[ -n "$NEW_PLIST" && -f "$NEW_PLIST" ]]; then
    rm -f "$NEW_PLIST"
  fi
  if [[ -n "$PREVIOUS_PLIST" && -f "$PREVIOUS_PLIST" ]]; then
    rm -f "$PREVIOUS_PLIST"
  fi

  if [[ "$LOCK_HELD" -eq 1 ]]; then
    /usr/bin/shlock -u -f "$LOCK_FILE" || true
  fi

  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT TERM HUP

# One installer lock covers both immutable release publication and mutable launchd replacement.
# Installs are rare, and splitting the lock would permit a deploy to observe another invocation's
# half-published state without providing useful concurrency.
mkdir -p "$(dirname "$LOCK_FILE")"
if ! /usr/bin/shlock -p "$$" -f "$LOCK_FILE"; then
  LOCK_PID="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  if [[ "$LOCK_PID" =~ ^[0-9]+$ ]]; then
    echo "sidebar installer is already running as pid ${LOCK_PID}" >&2
  else
    echo "could not acquire sidebar installer lock at $LOCK_FILE" >&2
  fi
  exit 1
fi
LOCK_HELD=1

# Fail before installing rather than after, so a broken job never gets bootstrapped.
command -v bun >/dev/null || { echo "bun not found in PATH" >&2; exit 1; }

# Releases must be reachable from the fetched origin/master so another machine can reproduce them.
git -C "$REPO_ROOT" merge-base --is-ancestor "$SHA" origin/master 2>/dev/null \
  || { echo "$SHA is not contained in origin/master; fetch origin/master and merge the commit before releasing" >&2; exit 1; }

mkdir -p "$RELEASE_ROOT"
# A crashed older installer may have left scratch data. The age bound avoids removing a directory
# that an older, non-locking installer could still be actively populating.
find "$RELEASE_ROOT" -maxdepth 1 -type d -name '*.tmp.*' -mtime +1 -exec rm -rf {} +

if [[ ! -d "$RELEASE" ]]; then
  echo "staging release $SHA"
  STAGING="$(mktemp -d "${RELEASE}.tmp.XXXXXX")"
  git -C "$REPO_ROOT" archive "$SHA" | tar -x -C "$STAGING"
  ( cd "$STAGING" && bun install --frozen-lockfile )
  [[ -x "${STAGING}/bin/ccs" ]] || { echo "staged release is missing executable bin/ccs" >&2; exit 1; }
  [[ -x "${STAGING}/bin/ccs-launch" ]] || { echo "release $SHA predates bin/ccs-launch" >&2; exit 1; }
  mv "$STAGING" "$RELEASE"
  STAGING=""
fi

[[ -x "$CCS_BIN" ]] || { echo "missing executable ccs at $CCS_BIN" >&2; exit 1; }
# The identity seam lives in ccs-launch; a release without it would install as an anonymous `bun`.
[[ -x "${RELEASE}/bin/ccs-launch" ]] || { echo "release $SHA predates bin/ccs-launch" >&2; exit 1; }
[[ -d "${RELEASE}/node_modules" ]] || { echo "release $SHA is missing node_modules; remove it and stage again" >&2; exit 1; }

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"
NEW_PLIST="$(mktemp "${DEST}.new.XXXXXX")"

# ProgramArguments names bin/ccs directly rather than invoking bun against it. bin/ccs is a
# zsh/TypeScript polyglot whose first act is to re-exec through ccs-launch, which applies the
# process identity; putting `bun` first makes Bun the process before that seam runs and the
# server shows up as an anonymous `bun`.
#
# PROCID_REF is set explicitly because a release is a `git archive` export with no .git, so the
# identity script cannot derive a ref on its own. Without it both instances report a bare
# `ccs:sidebar` and become indistinguishable in `ps`, the exact failure this naming prevents.
cat > "$NEW_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<!-- Generated by scripts/launchd/install-sidebar-agent.sh. Re-run that script to change it;
     hand-edits are lost on the next release. -->
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${CCS_BIN}</string>
        <string>sidebar</string>
        <string>serve</string>
        <string>--port</string>
        <string>${PORT}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>CMUX_SOCKET_PATH</key>
        <string>${SOCKET}</string>
        <key>PROCID_REF</key>
        <string>${INSTANCE}</string>
        <key>CCS_SIDEBAR_RELEASE</key>
        <string>${SHA}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${HOME}/Library/Logs/${LABEL}.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/Library/Logs/${LABEL}.log</string>
</dict>
</plist>
PLIST

plutil -lint "$NEW_PLIST" >/dev/null

if [[ -f "$DEST" ]]; then
  PREVIOUS_PLIST="$(mktemp "${DEST}.previous.XXXXXX")"
  cp -p "$DEST" "$PREVIOUS_PLIST"
  HAD_PREVIOUS=1
fi

DEPLOYMENT_STARTED=1
mv -f "$NEW_PLIST" "$DEST"
NEW_PLIST=""

bootout_agent
launchctl bootstrap "gui/$(id -u)" "$DEST"

# Prove the exact release came back named and serving; identity alone cannot distinguish two
# concurrent replacements of the same instance.
PID=""
READY=0
for _ in $(seq 1 40); do
  PID="$(launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9]*\)$/\1/p')"
  if [[ -n "$PID" ]] && curl --fail --silent "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.25
done

[[ "$READY" -eq 1 ]] || { echo "agent did not become ready at http://127.0.0.1:${PORT}/; see ${HOME}/Library/Logs/${LABEL}.log" >&2; exit 1; }
PROCESS_ARGS="$(ps -p "$PID" -o args=)"
case "$PROCESS_ARGS" in
  *"ccs:sidebar@${INSTANCE}"*) ;;
  *) echo "process is not carrying identity ccs:sidebar@${INSTANCE}" >&2; exit 1 ;;
esac
case "$PROCESS_ARGS" in
  *"${CCS_BIN}"*) ;;
  *) echo "process is not running requested release binary ${CCS_BIN}" >&2; exit 1 ;;
esac

INSTALL_VALIDATED=1
DEPLOYMENT_STARTED=0

echo "installed ${LABEL}: release ${SHA}, port ${PORT}, pid ${PID}"
printf '%s\n' "$PROCESS_ARGS"
