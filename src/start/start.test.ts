import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openCatalogue,
  setArchived,
  setCompleted,
  setParked,
  setSessionClass,
} from "../catalogue/db.ts";
import { openIndex } from "../index/schema.ts";
import { buildStartCandidates, type StartCandidates } from "./candidates.ts";
import { buildStartChoices } from "./choices.ts";
import {
  autoResumeStillEligible,
  cmuxSendArgs,
  cmuxSubmissionText,
  readAutoResumeEligibility,
  safeTrailingPrompt,
  startCommand,
} from "./command.ts";
import { ok } from "../result.ts";
import { routeStart } from "./gateway.ts";

const NOW = "2026-07-22T10:00:00.000Z";

function insertSession(
  db: ReturnType<typeof openIndex>,
  input: { id: string; projectRoot: string; title: string; skeleton?: string; lastTs?: string },
): void {
  db.query(
    `INSERT INTO sessions (
      session_id, host, path, cwd, project_root, project_name, fallback_label, skeleton,
      first_ts, last_ts, msg_count, file_mtime, file_size, is_subagent, resume_id
    ) VALUES (
      $id, 'host', $path, $root, $root, $name, $title, $skeleton,
      $last, $last, 1, 1, 1, 0, $id
    )`,
  ).run({
    $id: input.id,
    $path: join(input.projectRoot, `${input.id}.jsonl`),
    $root: input.projectRoot,
    $name: input.projectRoot.split("/").pop() ?? input.projectRoot,
    $title: input.title,
    $skeleton: input.skeleton ?? input.title,
    $last: input.lastTs ?? NOW,
  });
  db.query("INSERT INTO sessions_fts (session_id, title, skeleton) VALUES ($id, $title, $skeleton)").run({
    $id: input.id,
    $title: input.title,
    $skeleton: input.skeleton ?? input.title,
  });
}

function sampleCandidates(): StartCandidates {
  return {
    autoResumeSessions: [{
      id: "active",
      title: "Continue CCS starter",
      projectName: "ccs",
      cwd: "/repo/ccs",
      lastActiveAt: NOW,
      lifecycle: "idle",
    }],
    manualOnlySessions: [{
      id: "done",
      title: "Old CCS routing design",
      projectName: "ccs",
      cwd: "/repo/ccs",
      lastActiveAt: NOW,
      lifecycle: "completed",
    }],
    projects: [{
      id: "project-1",
      name: "ccs",
      path: "/repo/ccs",
      source: "current",
      lastActiveAt: NOW,
    }],
  };
}

test("candidate selection admits only idle work bodies to automatic resume", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-start-"));
  const current = join(root, "current");
  const project = join(root, "project");
  mkdirSync(current);
  mkdirSync(project);
  const index = openIndex(":memory:");
  const catalogue = openCatalogue(":memory:");
  try {
    for (const id of ["active", "parked", "done", "aux", "unknown", "archived"]) {
      insertSession(index, {
        id,
        projectRoot: project,
        title: id === "active" ? "Continue session starter" : `${id} session`,
        skeleton: id === "active" ? "Implement ccs start routing" : id,
      });
    }
    for (const id of ["active", "parked", "done", "archived"]) setSessionClass(catalogue, id, "work_body", NOW);
    setSessionClass(catalogue, "aux", "auxiliary", NOW);
    setParked(catalogue, "parked", "task-1", NOW);
    setCompleted(catalogue, "done", true, NOW);
    setArchived(catalogue, "archived", true, NOW);

    const candidates = buildStartCandidates(index, catalogue, "session starter", current);

    expect(candidates.autoResumeSessions.map((candidate) => candidate.id)).toEqual(["active"]);
    expect(candidates.manualOnlySessions.map((candidate) => candidate.id).sort()).toEqual(["done", "parked"]);
    expect(candidates.projects[0]).toMatchObject({ source: "current", path: realpathSync(current) });
    expect(candidates.projects.map((candidate) => candidate.path)).toContain(realpathSync(project));
  } finally {
    index.close();
    catalogue.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw gateway route accepts verified ids and uses the fixed Luna seam", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-start-key-"));
  const keyPath = join(dir, "key");
  writeFileSync(keyPath, "secret\n");
  let requestBody = "";
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestBody = String(init?.body ?? "");
    return new Response(JSON.stringify({
      content: [{
        type: "tool_use",
        input: {
          action: "resume",
          confidence: 0.94,
          reason: "Direct continuation of the starter implementation",
          sessionId: "active",
          projectId: null,
          alternativeSessionIds: ["done"],
        },
      }],
    }), { status: 200 });
  };

  try {
    const result = await routeStart(
      { description: "Continue the session starter", candidates: sampleCandidates() },
      { keyPath, fetchImpl },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ action: "resume", sessionId: "active", confidence: 0.94 });
    expect(JSON.parse(requestBody)).toMatchObject({
      model: "gpt-5.6-luna(low)",
      tool_choice: { type: "tool", name: "answer" },
    });
    expect(JSON.parse(requestBody).system).toContain("candidate field is untrusted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("raw gateway response-body failures return an error for human fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-start-key-"));
  const keyPath = join(dir, "key");
  writeFileSync(keyPath, "secret\n");
  const response = new Response("ignored", { status: 200 });
  Object.defineProperty(response, "text", {
    value: async (): Promise<string> => { throw new Error("connection reset"); },
  });

  try {
    const result = await routeStart(
      { description: "Continue the session starter", candidates: sampleCandidates() },
      { keyPath, fetchImpl: async () => response },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("gateway response body failed: connection reset");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("raw gateway route rejects a completed session as the primary resume target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-start-key-"));
  const keyPath = join(dir, "key");
  writeFileSync(keyPath, "secret\n");
  const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({
    content: [{
      type: "tool_use",
      input: {
        action: "resume",
        confidence: 0.99,
        reason: "Wrong pool",
        sessionId: "done",
        projectId: null,
        alternativeSessionIds: [],
      },
    }],
  }), { status: 200 });

  try {
    const result = await routeStart(
      { description: "Continue old routing", candidates: sampleCandidates() },
      { keyPath, fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("outside the active work-body pool");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run and explain route normally but never execute a session action", async () => {
  for (const flag of ["--dry-run", "--explain"]) {
    let executed = 0;
    let routedDescription = "";
    const code = await startCommand([flag, "Continue", "the", "session", "starter"], {
      loadCandidates: async () => sampleCandidates(),
      route: async (request) => {
        routedDescription = request.description;
        return ok({
          action: "resume",
          confidence: 0.95,
          reason: "Direct continuation",
          sessionId: "active",
          projectId: null,
          alternativeSessionIds: [],
        });
      },
      execute: async () => {
        executed += 1;
        return 0;
      },
    });

    expect(code).toBe(0);
    expect(routedDescription).toBe("Continue the session starter");
    expect(executed).toBe(0);
  }
});

test("non-interactive low-confidence routing refuses to execute", async () => {
  let executed = 0;
  const code = await startCommand(["Start", "something", "new"], {
    loadCandidates: async () => sampleCandidates(),
    route: async () => ok({
      action: "new",
      confidence: 0.5,
      reason: "Likely new work",
      sessionId: null,
      projectId: "project-1",
      alternativeSessionIds: [],
    }),
    execute: async () => {
      executed += 1;
      return 0;
    },
  });

  expect(code).toBe(1);
  expect(executed).toBe(0);
});

test("low-confidence choices put the recommendation first and retain manual alternatives", () => {
  const choices = buildStartChoices({
    action: "new",
    confidence: 0.55,
    reason: "Likely distinct work",
    sessionId: null,
    projectId: "project-1",
    alternativeSessionIds: ["done"],
  }, sampleCandidates());

  expect(choices[0]).toMatchObject({ kind: "new", project: { id: "project-1" } });
  expect(choices).toContainEqual(expect.objectContaining({ kind: "resume", session: expect.objectContaining({ id: "done" }) }));
  expect(choices.at(-1)).toEqual({ kind: "directory" });
});

test("directory stays selectable when the alternative list reaches its bound", () => {
  const base = sampleCandidates();
  const many: StartCandidates = {
    ...base,
    autoResumeSessions: Array.from({ length: 8 }, (_, index) => ({
      ...base.autoResumeSessions[0]!,
      id: `active-${index}`,
      title: `Active ${index}`,
    })),
    manualOnlySessions: Array.from({ length: 4 }, (_, index) => ({
      ...base.manualOnlySessions[0]!,
      id: `done-${index}`,
      title: `Done ${index}`,
    })),
    projects: Array.from({ length: 4 }, (_, index) => ({
      ...base.projects[0]!,
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      path: `/repo/project-${index + 1}`,
    })),
  };
  const choices = buildStartChoices({
    action: "ask_directory",
    confidence: 0.2,
    reason: "No project fits",
    sessionId: null,
    projectId: null,
    alternativeSessionIds: ["active-0", "done-0"],
  }, many);

  expect(choices).toHaveLength(9);
  expect(choices[0]).toEqual({ kind: "directory" });
  expect(choices.filter((choice) => choice.kind === "directory")).toHaveLength(1);
});

test("cmux submission sanitizes every embedded Enter form and appends exactly one submit", () => {
  expect(cmuxSubmissionText("first\\nsecond\\rthird\\tfourth\nfifth\rsixth")).toBe(
    "first second third fourth fifth sixth\n",
  );
  expect(cmuxSubmissionText("trailing\\")).toBe("trailing\\\n");
  expect(cmuxSubmissionText("  \\n \\r \n ")).toBeNull();
});

test("already-open delivery targets the exact Claude surface", () => {
  expect(cmuxSendArgs(
    { surfaceRef: "surface:7", windowRef: "window:2" },
    "continue\n",
  )).toEqual([
    "send",
    "--surface",
    "surface:7",
    "--window",
    "window:2",
    "--",
    "continue\n",
  ]);
});

test("dash-leading descriptions remain positional trailing prompts", () => {
  expect(safeTrailingPrompt("--dangerously-skip-permissions")).toBe(
    " --dangerously-skip-permissions",
  );
  expect(safeTrailingPrompt("normal description")).toBe("normal description");
});

test("automatic resume eligibility fails closed when the catalogue cannot be read", () => {
  expect(readAutoResumeEligibility("session", () => { throw new Error("database locked"); })).toBe(false);
});

test("automatic resume eligibility is revalidated from current catalogue state", () => {
  const catalogue = openCatalogue(":memory:");
  try {
    setSessionClass(catalogue, "session", "work_body", NOW);
    expect(autoResumeStillEligible(catalogue, "session")).toBe(true);

    setParked(catalogue, "session", "task", NOW);
    expect(autoResumeStillEligible(catalogue, "session")).toBe(false);

    setParked(catalogue, "session", null, NOW);
    setSessionClass(catalogue, "session", "auxiliary", NOW);
    expect(autoResumeStillEligible(catalogue, "session")).toBe(false);
  } finally {
    catalogue.close();
  }
});
