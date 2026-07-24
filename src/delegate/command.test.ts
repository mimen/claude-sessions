import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { openCatalogue, setSessionClass } from "../catalogue/db.ts";
import { delegateCommand } from "./command.ts";

const PARENT = "754b9a1a-e5e0-49b7-8e45-d433e82621bf";
const SHIM = resolve(import.meta.dir, "../../bin/ccs-claude-shim");
const CCS_BIN = resolve(import.meta.dir, "../../bin/ccs");
const roots: string[] = [];
const savedCcsRoot = process.env.CCS_ROOT;

afterEach(() => {
  if (savedCcsRoot === undefined) delete process.env.CCS_ROOT;
  else process.env.CCS_ROOT = savedCcsRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(exitCode = 0, withFallback = true): {
  readonly root: string;
  readonly seatsRoot: string;
  readonly bin: string;
  readonly observation: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ccs-delegate-command-"));
  roots.push(root);
  const seatsRoot = join(root, "seats");
  const seatDirectory = join(seatsRoot, "primary-review");
  const bin = join(root, "bin");
  const observation = join(root, "observation.json");
  mkdirSync(seatDirectory, { recursive: true });
  mkdirSync(bin);
  writeFileSync(
    join(seatDirectory, "seat.toml"),
    `name = "primary-review"
description = "Primary review"
tools = ["Bash", "Read"]

[routing.primary]
provider = "gpt"
launcher = "claude-gpt"
requested_model = "gpt-5.6-sol"
effort = "high"
${withFallback ? `
[routing.fallback]
provider = "gpt"
launcher = "claude-gpt"
requested_model = "gpt-5.6-terra"
effort = "xhigh"
` : ""}`,
  );
  writeFileSync(join(seatDirectory, "prompt.md"), "Review the implementation.");
  const executable = join(bin, "claude-gpt");
  writeFileSync(
    executable,
    `#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const id = argv[argv.indexOf("--session-id") + 1];
const db = new Database(join(process.env.CCS_ROOT, "cache", "catalogue.db"), { readonly: true });
const row = db.query("SELECT session_class, parent_session_id, creator_kind, creator_ref, launch_channel, meta FROM catalogue WHERE session_id = $id").get({ $id: id });
writeFileSync(process.env.OBSERVATION_PATH, JSON.stringify({ argv, cwd: process.cwd(), forbidden: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null, creatorKind: process.env.CCS_CREATOR_KIND ?? null, creatorRef: process.env.CCS_CREATOR_REF ?? null, launchCreatorKind: process.env.CCS_LAUNCH_CREATOR_KIND ?? null, launchCreatorRef: process.env.CCS_LAUNCH_CREATOR_REF ?? null, launchParent: process.env.CCS_LAUNCH_PARENT_SESSION_ID ?? null, row }));
db.close();
process.exit(${exitCode});
`,
  );
  chmodSync(executable, 0o755);
  return { root, seatsRoot, bin, observation };
}

function seedParent(root: string): void {
  mkdirSync(join(root, "runtime", "cache"), { recursive: true });
  const db = openCatalogue(join(root, "runtime", "cache", "catalogue.db"));
  try {
    setSessionClass(db, PARENT, "work_body", "2026-07-20T00:00:00Z");
  } finally {
    db.close();
  }
}

function childRows(root: string): Array<{ session_id: string; session_class: string; parent_session_id: string; meta: string }> {
  const db = new Database(join(root, "runtime", "cache", "catalogue.db"), { readonly: true });
  try {
    return db.query(
      "SELECT session_id, session_class, parent_session_id, meta FROM catalogue WHERE parent_session_id = $parent ORDER BY session_id",
    ).all({ $parent: PARENT }) as Array<{ session_id: string; session_class: string; parent_session_id: string; meta: string }>;
  } finally {
    db.close();
  }
}

describe("delegateCommand", () => {
  test("reserves primary auxiliary metadata before launch and preserves argv/cwd/exit status", () => {
    const f = fixture(7);
    process.env.CCS_ROOT = join(f.root, "runtime");
    seedParent(f.root);
    const prompt = "Review this diff.\nKeep 'quotes' literal.";
    const code = delegateCommand(
      ["primary-review", "--child-of", PARENT, "--cwd", f.root, "--prompt", prompt, "--seats-root", f.seatsRoot],
      {
        ...process.env,
        PATH: `${f.bin}:${process.env.PATH ?? ""}`,
        OBSERVATION_PATH: f.observation,
        CLAUDE_CODE_SUBAGENT_MODEL: "must-not-leak",
        CLAUDE_CODE_SESSION_ID: undefined,
        CCS_CREATOR_KIND: undefined,
        CCS_CREATOR_REF: undefined,
      },
    );

    expect(code).toBe(7);
    const observation = JSON.parse(readFileSync(f.observation, "utf8")) as {
      argv: string[];
      cwd: string;
      forbidden: string | null;
      launchCreatorKind: string | null;
      launchCreatorRef: string | null;
      launchParent: string | null;
      row: {
        session_class: string;
        parent_session_id: string;
        creator_kind: string;
        creator_ref: string;
        launch_channel: string;
        meta: string;
      };
    };
    expect(observation.cwd).toBe(realpathSync(f.root));
    expect(observation.forbidden).toBeNull();
    expect(observation.launchCreatorKind).toBe("agent");
    expect(observation.launchCreatorRef).toBe(PARENT);
    expect(observation.launchParent).toBe(PARENT);
    expect(observation.argv.slice(-2)).toEqual(["-p", prompt]);
    expect(observation.argv).not.toContain("--bare");
    expect(observation.row.session_class).toBe("auxiliary");
    expect(observation.row.parent_session_id).toBe(PARENT);
    expect(observation.row.creator_kind).toBe("agent");
    expect(observation.row.creator_ref).toBe(PARENT);
    expect(observation.row.launch_channel).toBe("ccs_delegate");
    expect(JSON.parse(observation.row.meta) as Record<string, string>).toMatchObject({
      launch_status: "reserved",
      seat: "primary-review",
      delegation_route: "primary",
      requested_model: "gpt-5.6-sol",
      compiled_model: "gpt-5.6-sol[1m]",
      effective_effort: "high",
    });

    const rows = childRows(f.root);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.meta) as Record<string, string | number>).toMatchObject({
      launch_status: "exited",
      exit_code: 7,
    });
  });

  test("records automation creator separately from the causal parent", () => {
    const f = fixture();
    process.env.CCS_ROOT = join(f.root, "runtime");
    seedParent(f.root);
    const code = delegateCommand(
      ["primary-review", "--child-of", PARENT, "--cwd", f.root, "--prompt", "Review.", "--seats-root", f.seatsRoot],
      {
        ...process.env,
        PATH: `${f.bin}:${process.env.PATH ?? ""}`,
        OBSERVATION_PATH: f.observation,
        CCS_CREATOR_KIND: "automation",
        CCS_CREATOR_REF: "imsg-server",
      },
    );

    expect(code).toBe(0);
    const observation = JSON.parse(readFileSync(f.observation, "utf8")) as {
      creatorKind: string | null;
      creatorRef: string | null;
      launchCreatorKind: string | null;
      launchCreatorRef: string | null;
      launchParent: string | null;
      row: {
        parent_session_id: string;
        creator_kind: string;
        creator_ref: string;
        launch_channel: string;
      };
    };
    expect(observation.row).toMatchObject({
      parent_session_id: PARENT,
      creator_kind: "automation",
      creator_ref: "imsg-server",
      launch_channel: "ccs_delegate",
    });
    expect(observation.creatorKind).toBeNull();
    expect(observation.creatorRef).toBeNull();
    expect(observation.launchCreatorKind).toBe("automation");
    expect(observation.launchCreatorRef).toBe("imsg-server");
    expect(observation.launchParent).toBe(PARENT);
  });

  test("automation delegation traverses the stable shim and strips all birth provenance", () => {
    const f = fixture();
    process.env.CCS_ROOT = join(f.root, "runtime");
    seedParent(f.root);

    const home = join(f.root, "home");
    const shimDirectory = join(home, ".ccs", "bin");
    mkdirSync(shimDirectory, { recursive: true });
    symlinkSync(SHIM, join(shimDirectory, "claude"));

    const launcher = join(f.bin, "claude-gpt");
    writeFileSync(launcher, "#!/bin/sh\nexec claude \"$@\"\n");
    chmodSync(launcher, 0o755);

    const raw = join(f.root, "raw-claude");
    writeFileSync(raw, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(process.env.OBSERVATION_PATH, JSON.stringify({
  argv: process.argv.slice(2),
  creatorKind: process.env.CCS_CREATOR_KIND ?? null,
  creatorRef: process.env.CCS_CREATOR_REF ?? null,
  launchCreatorKind: process.env.CCS_LAUNCH_CREATOR_KIND ?? null,
  launchCreatorRef: process.env.CCS_LAUNCH_CREATOR_REF ?? null,
  launchParent: process.env.CCS_LAUNCH_PARENT_SESSION_ID ?? null,
}));
`);
    chmodSync(raw, 0o755);

    const code = delegateCommand(
      ["primary-review", "--child-of", PARENT, "--cwd", f.root, "--prompt", "Review.", "--seats-root", f.seatsRoot],
      {
        ...process.env,
        HOME: home,
        PATH: `${f.bin}:${process.env.PATH ?? ""}`,
        OBSERVATION_PATH: f.observation,
        CCS_BIN,
        CCS_RAW_CLAUDE_PATH: raw,
        CCS_CREATOR_KIND: "automation",
        CCS_CREATOR_REF: "imsg-server",
        CLAUDE_CODE_SESSION_ID: undefined,
        CLAUDE_CODE_SKIP_PROMPT_HISTORY: "",
        CMUX_SURFACE_ID: "",
        CMUX_CUSTOM_CLAUDE_PATH: "",
        CCS_CLAUDE_SHIM_AFTER_CMUX: "",
        CCS_CMUX_CLAUDE_WRAPPER_PATH: "",
        CCS_LAUNCH_PARENT_SESSION_ID: undefined,
        CCS_LAUNCH_CREATOR_KIND: undefined,
        CCS_LAUNCH_CREATOR_REF: undefined,
      },
    );

    expect(code).toBe(0);
    const observation = JSON.parse(readFileSync(f.observation, "utf8")) as {
      argv: string[];
      creatorKind: string | null;
      creatorRef: string | null;
      launchCreatorKind: string | null;
      launchCreatorRef: string | null;
      launchParent: string | null;
    };
    expect(observation.argv.slice(-2)).toEqual(["-p", "Review."]);
    expect(observation.creatorKind).toBeNull();
    expect(observation.creatorRef).toBeNull();
    expect(observation.launchCreatorKind).toBeNull();
    expect(observation.launchCreatorRef).toBeNull();
    expect(observation.launchParent).toBeNull();
  });

  test("rejects automation delegation without a stable creator ref before reservation", () => {
    const f = fixture();
    process.env.CCS_ROOT = join(f.root, "runtime");
    seedParent(f.root);
    const code = delegateCommand(
      ["primary-review", "--child-of", PARENT, "--cwd", f.root, "--prompt", "Review.", "--seats-root", f.seatsRoot],
      {
        ...process.env,
        PATH: `${f.bin}:${process.env.PATH ?? ""}`,
        CCS_CREATOR_KIND: "automation",
        CCS_CREATOR_REF: "",
      },
    );
    expect(code).toBe(2);
    expect(childRows(f.root)).toHaveLength(0);
  });

  test("runs an explicit fallback as a separate Terra xhigh child", () => {
    const f = fixture();
    process.env.CCS_ROOT = join(f.root, "runtime");
    seedParent(f.root);
    const code = delegateCommand(
      ["primary-review", "--fallback", "--child-of", PARENT, "--cwd", f.root, "--prompt", "Review.", "--seats-root", f.seatsRoot],
      { ...process.env, PATH: `${f.bin}:${process.env.PATH ?? ""}`, OBSERVATION_PATH: f.observation },
    );
    expect(code).toBe(0);
    const observation = JSON.parse(readFileSync(f.observation, "utf8")) as { argv: string[]; row: { meta: string } };
    expect(observation.argv.join(" ")).toContain('"model":"gpt-5.6-terra[1m]"');
    expect(observation.argv.join(" ")).toContain('"effort":"xhigh"');
    expect(JSON.parse(observation.row.meta) as Record<string, string>).toMatchObject({
      delegation_route: "fallback",
      requested_model: "gpt-5.6-terra",
      compiled_model: "gpt-5.6-terra[1m]",
      effective_effort: "xhigh",
    });
    expect(childRows(f.root)).toHaveLength(1);
  });

  test("rejects explicit fallback for a seat without one before reservation", () => {
    const f = fixture(0, false);
    process.env.CCS_ROOT = join(f.root, "runtime");
    seedParent(f.root);
    const code = delegateCommand(
      ["primary-review", "--fallback", "--child-of", PARENT, "--cwd", f.root, "--prompt", "Review.", "--seats-root", f.seatsRoot],
      { ...process.env, PATH: `${f.bin}:${process.env.PATH ?? ""}` },
    );
    expect(code).toBe(1);
    expect(childRows(f.root)).toHaveLength(0);
  });

  test("keeps one failed reservation when the selected launcher cannot start", () => {
    const f = fixture();
    process.env.CCS_ROOT = join(f.root, "runtime");
    seedParent(f.root);
    const code = delegateCommand(
      ["primary-review", "--child-of", PARENT, "--cwd", f.root, "--prompt", "Review.", "--seats-root", f.seatsRoot],
      { ...process.env, PATH: "/definitely/missing" },
    );

    expect(code).toBe(1);
    const rows = childRows(f.root);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_class).toBe("auxiliary");
    expect(JSON.parse(rows[0]!.meta) as Record<string, string>).toMatchObject({
      launch_status: "failed",
      delegation_route: "primary",
    });
  });

  test("rejects a nonexistent explicit parent without creating a stub", () => {
    const f = fixture();
    process.env.CCS_ROOT = join(f.root, "runtime");
    const code = delegateCommand(
      ["primary-review", "--child-of", PARENT, "--cwd", f.root, "--prompt", "Review.", "--seats-root", f.seatsRoot],
      { ...process.env, PATH: `${f.bin}:${process.env.PATH ?? ""}` },
    );
    expect(code).toBe(2);
    expect(childRows(f.root)).toHaveLength(0);
  });

  test("resolves child-of dot without parent provider inference", () => {
    const f = fixture();
    process.env.CCS_ROOT = join(f.root, "runtime");
    const code = delegateCommand(
      ["primary-review", "--child-of", ".", "--cwd", f.root, "--prompt", "Review.", "--seats-root", f.seatsRoot],
      { ...process.env, CLAUDE_CODE_SESSION_ID: PARENT, PATH: `${f.bin}:${process.env.PATH ?? ""}`, OBSERVATION_PATH: f.observation },
    );
    expect(code).toBe(0);
    expect(childRows(f.root)).toHaveLength(1);
  });
});
