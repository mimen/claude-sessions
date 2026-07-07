import type { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Mines the Store's transcripts for three usage signals per skill:
 *  - "invoke":  Skill tool invocations (the model ran the skill)
 *  - "command": slash commands in user turns (<command-name>, how loops fire)
 *  - "read":    Read tool access into a skill's directory (loops treat SKILL.md as reference docs)
 *
 * Incremental: a transcript is re-parsed only when its (size, mtime) changed; its previous
 * contributions are replaced atomically. First run pays the full corpus, later runs are cheap.
 */

export interface MineStats {
  parsed: number;
  skipped: number;
  events: number;
}

interface LineEvent {
  skill: string;
  kind: "invoke" | "command" | "read";
  ts: string;
}

const INVOKE_RE = /"name":"Skill","input":\{[^{}]*?"skill":"([^"]+)"/g;
const COMMAND_RE = /<command-name>\/?([^<\s]+)<\/command-name>/g;
const FILE_PATH_RE = /"file_path":"([^"]+)"/g;
const TS_RE = /"timestamp":"([^"]+)"/;

/** Extract usage events from one transcript line. Exported for tests. */
export function extractEvents(line: string, skillDirOf: (path: string) => string | undefined): LineEvent[] {
  const events: LineEvent[] = [];
  const ts = TS_RE.exec(line)?.[1] ?? "";
  if (line.includes('"name":"Skill"')) {
    for (const m of line.matchAll(INVOKE_RE)) {
      events.push({ skill: stripNamespace(m[1]!), kind: "invoke", ts });
    }
  }
  if (line.includes("<command-name>")) {
    for (const m of line.matchAll(COMMAND_RE)) {
      events.push({ skill: stripNamespace(m[1]!), kind: "command", ts });
    }
  }
  if (line.includes('"name":"Read"') && line.includes("file_path")) {
    for (const m of line.matchAll(FILE_PATH_RE)) {
      const skill = skillDirOf(m[1]!);
      if (skill) events.push({ skill, kind: "read", ts });
    }
  }
  return events;
}

/** `plugin:skill` → `skill`; a bare slug passes through. */
function stripNamespace(raw: string): string {
  const i = raw.lastIndexOf(":");
  return i === -1 ? raw : raw.slice(i + 1);
}

/**
 * Prefix matcher from every known skill directory (primary, aliases, realpath) to its slug.
 * Walks a file path upward segment by segment until it hits a registered skill dir.
 */
export function makeSkillDirMatcher(dirsToName: Map<string, string>): (path: string) => string | undefined {
  return (filePath: string): string | undefined => {
    let p = filePath;
    for (let depth = 0; depth < 12; depth++) {
      const hit = dirsToName.get(p);
      if (hit) return hit;
      const cut = p.lastIndexOf("/");
      if (cut <= 0) return undefined;
      p = p.slice(0, cut);
    }
    return undefined;
  };
}

/** Every *.jsonl under the Store (sessions + subagent transcripts). */
function listTranscripts(storePath: string): Array<{ path: string; size: number; mtime: number }> {
  const out: Array<{ path: string; size: number; mtime: number }> = [];
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4) walk(full, depth + 1);
      } else if (e.name.endsWith(".jsonl")) {
        try {
          const st = statSync(full);
          out.push({ path: full, size: st.size, mtime: st.mtimeMs });
        } catch {
          // racing delete
        }
      }
    }
  };
  walk(storePath, 0);
  return out;
}

export async function mineUsage(
  db: Database,
  storePath: string,
  dirsToName: Map<string, string>,
  onProgress?: (done: number, total: number) => void,
): Promise<MineStats> {
  const matcher = makeSkillDirMatcher(dirsToName);
  const transcripts = listTranscripts(storePath);
  const cached = new Map(
    (db.query("SELECT path, size, mtime FROM usage_files").all() as Array<{ path: string; size: number; mtime: number }>).map(
      (r) => [r.path, r],
    ),
  );

  const stale = transcripts.filter((t) => {
    const c = cached.get(t.path);
    return !c || c.size !== t.size || c.mtime !== t.mtime;
  });

  // Drop contributions from transcripts that no longer exist.
  const live = new Set(transcripts.map((t) => t.path));
  const gone = [...cached.keys()].filter((p) => !live.has(p));
  const deleteCounts = db.prepare("DELETE FROM usage_counts WHERE file = ?");
  const deleteFile = db.prepare("DELETE FROM usage_files WHERE path = ?");
  for (const p of gone) {
    deleteCounts.run(p);
    deleteFile.run(p);
  }

  const insertCount = db.prepare(
    "INSERT OR REPLACE INTO usage_counts (file, skill, kind, count, last_ts) VALUES (?, ?, ?, ?, ?)",
  );
  const upsertFile = db.prepare("INSERT OR REPLACE INTO usage_files (path, size, mtime) VALUES (?, ?, ?)");

  let events = 0;
  let done = 0;
  for (const t of stale) {
    const agg = new Map<string, { count: number; last: string }>();
    await eachLine(t.path, (line) => {
      for (const e of extractEvents(line, matcher)) {
        const key = `${e.skill}\x00${e.kind}`;
        const cur = agg.get(key) ?? { count: 0, last: "" };
        cur.count++;
        if (e.ts > cur.last) cur.last = e.ts;
        agg.set(key, cur);
        events++;
      }
    });
    const tx = db.transaction(() => {
      deleteCounts.run(t.path);
      for (const [key, v] of agg) {
        const [skill, kind] = key.split("\x00") as [string, string];
        insertCount.run(t.path, skill, kind, v.count, v.last);
      }
      upsertFile.run(t.path, t.size, t.mtime);
    });
    tx();
    done++;
    onProgress?.(done, stale.length);
  }
  return { parsed: stale.length, skipped: transcripts.length - stale.length, events };
}

/** Stream a file line by line without holding the whole transcript in memory. */
async function eachLine(path: string, fn: (line: string) => void): Promise<void> {
  const stream = Bun.file(path).stream();
  const decoder = new TextDecoder();
  let carry = "";
  for await (const chunk of stream) {
    carry += decoder.decode(chunk, { stream: true });
    let nl = carry.indexOf("\n");
    while (nl !== -1) {
      fn(carry.slice(0, nl));
      carry = carry.slice(nl + 1);
      nl = carry.indexOf("\n");
    }
  }
  if (carry) fn(carry);
}
