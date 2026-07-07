import { realpathSync, statSync, readFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import { type Result, ok, err } from "../result.ts";

/** Which world a skill belongs to, classified from its path. */
export type Ecosystem =
  | "claude-user" // ~/.claude/skills or its canonical source (the vault ClaudeConfig)
  | "claude-project" // a repo's .claude/skills (workspace/project-local)
  | "agents" // ~/.agents/skills (Agent Skills standard harnesses)
  | "plugin" // ~/.claude/plugins marketplaces
  | "codex"
  | "cursor"
  | "hermes"
  | "archive" // _archive / deprecated corpses
  | "download" // ~/Downloads copies
  | "other";

export interface SkillRecord {
  /** Slug = the skill directory's basename; how transcripts refer to it. */
  name: string;
  /** Primary path (the first/most canonical place we saw it). */
  path: string;
  /** Symlink-resolved path; two paths with one realPath are one skill. */
  realPath: string;
  ecosystem: Ecosystem;
  description: string;
  /** Other paths that resolve to the same skill (symlink farms, copies are NOT aliases). */
  aliases: string[];
  mtimeMs: number;
  /** Hash of SKILL.md content — same-name records with different hashes have drifted. */
  contentHash: string;
}

const EXCLUDES = ["*/node_modules/*", "*/Library/*", "*/.Trash/*", "*/.git/*", "*/.archive/*"];

/** Classify a skill directory into its ecosystem. Pure; exported for tests. */
export function classifyPath(path: string, home: string = homedir()): Ecosystem {
  const p = path.startsWith(home) ? "~" + path.slice(home.length) : path;
  if (p.includes("/_archive/") || p.includes("/deprecated/")) return "archive";
  if (p.startsWith("~/Downloads/")) return "download";
  if (p.startsWith("~/.claude/plugins/")) return "plugin";
  if (p.startsWith("~/.claude/skills/")) return "claude-user";
  if (p.startsWith("~/.agents/")) return "agents";
  if (p.startsWith("~/.codex/")) return "codex";
  if (p.startsWith("~/.cursor/")) return "cursor";
  if (p.startsWith("~/.hermes/")) return "hermes";
  // The vault's ClaudeConfig is the canonical source behind ~/.claude/skills.
  if (p.includes("/ClaudeConfig/skills/")) return "claude-user";
  if (p.includes("/.claude/skills/") || p.includes("/.claude/commands/")) return "claude-project";
  if (p.includes("/.agents/skills/")) return "agents";
  if (p.includes("/skills/")) return "claude-project";
  return "other";
}

/**
 * Minimal YAML frontmatter reader for SKILL.md: top `---` block, `key: value` lines,
 * folded blocks (`key: >-` / `|`) joined from their indented continuation lines.
 */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = text.slice(text.indexOf("\n") + 1, end);
  const lines = block.split("\n");
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    let value = m[2]!.trim();
    if (value === "" || value === ">-" || value === ">" || value === "|" || value === "|-") {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) {
        parts.push(lines[i + 1]!.trim());
        i++;
      }
      value = parts.join(" ");
    }
    out[key] = value.replace(/^["']|["']$/g, "");
  }
  return { name: out["name"], description: out["description"] };
}

/**
 * Whether a directory sits inside a LINKED git worktree (not the main checkout):
 * a linked worktree's `.git` is a file (`gitdir:` pointer), the main repo's is a directory.
 * Worktree copies of repo-local skills are pure duplication noise in a skill census.
 */
export function isInLinkedWorktree(dir: string, cache?: Map<string, boolean>): boolean {
  let d = dir;
  for (let depth = 0; depth < 12; depth++) {
    const cached = cache?.get(d);
    if (cached !== undefined) return cached;
    let result: boolean | null = null;
    try {
      const st = statSync(join(d, ".git"));
      result = st.isFile();
    } catch {
      // no .git here — keep walking up
    }
    if (result !== null) {
      cache?.set(dir, result);
      cache?.set(d, result);
      return result;
    }
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  cache?.set(dir, false);
  return false;
}

/**
 * Full-machine discovery: every directory containing a SKILL.md under `root`,
 * deduped by realpath (symlink farms collapse to one record with aliases).
 */
export async function discoverSkills(root: string = homedir()): Promise<Result<SkillRecord[]>> {
  const args = [root, "-maxdepth", "9", "-name", "SKILL.md"];
  for (const pattern of EXCLUDES) args.push("-not", "-path", pattern);
  const proc = Bun.spawn(["find", ...args], { stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  // find exits non-zero on permission errors while still printing matches; only fail on empty+error.
  if (code !== 0 && stdout.trim() === "") {
    return err(new Error(`find exited ${code} with no results under ${root}`));
  }

  const byReal = new Map<string, SkillRecord>();
  for (const line of stdout.split("\n")) {
    if (!line.endsWith("/SKILL.md")) continue;
    const dir = dirname(line);
    let real: string;
    let mtimeMs = 0;
    try {
      real = realpathSync(dir);
      mtimeMs = statSync(line).mtimeMs;
    } catch {
      continue; // dangling symlink or racing delete
    }
    const existing = byReal.get(real);
    if (existing) {
      if (dir !== existing.path && !existing.aliases.includes(dir)) existing.aliases.push(dir);
      continue;
    }
    let fm: { name?: string; description?: string } = {};
    let contentHash = "";
    try {
      const text = readFileSync(line, "utf8");
      fm = parseFrontmatter(text);
      contentHash = Bun.hash(text).toString(36);
    } catch {
      // unreadable SKILL.md — keep the record with defaults
    }
    byReal.set(real, {
      name: fm.name?.trim() || basename(dir),
      path: dir,
      realPath: real,
      ecosystem: classifyPath(real),
      description: fm.description ?? "",
      aliases: [],
      mtimeMs,
      contentHash,
    });
  }

  // Prefer the runtime path (~/.claude/skills/...) as primary when it's among the aliases,
  // since that's the name/location Claude Code actually discovers.
  const home = homedir();
  const runtimePrefix = `${home}/.claude/skills/`;
  for (const rec of byReal.values()) {
    const runtime = [rec.path, ...rec.aliases].find((p) => p.startsWith(runtimePrefix));
    if (runtime && rec.path !== runtime) {
      rec.aliases = [rec.path, ...rec.aliases.filter((a) => a !== runtime)];
      rec.path = runtime;
    }
  }
  return ok([...byReal.values()].sort((a, b) => a.name.localeCompare(b.name)));
}
