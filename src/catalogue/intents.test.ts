import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue, getRow } from "./db.ts";
import { sendIntent, applyIntents, applyIntentsFromInbox } from "./intents.ts";

const FLEET_CLI = join(
  process.env.HOME!,
  "Documents/milad-vault/ClaudeConfig/machine-adapter/scripts/fleet.py",
);

/** A minimal vault with one manifested role, enough for fleet.py send/drain. */
function makeVault(base: string, role: string): { vault: string; rolesDir: string; inbox: string } {
  const vault = join(base, "vault");
  const rolesDir = join(base, "roles");
  const stateDir = "state/" + role;
  mkdirSync(join(vault, stateDir, "inbox"), { recursive: true });
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(
    join(rolesDir, `${role}.md`),
    [
      "---",
      "kind: role",
      `name: ${role}`,
      "archetype: manager",
      "skill: none",
      "lifecycle: standing",
      "seat: utility",
      "host: Milads-Mac-mini",
      `state_dir: ${stateDir}`,
      "---",
      "",
      `# ${role}`,
      "",
    ].join("\n"),
  );
  return { vault, rolesDir, inbox: join(vault, stateDir, "inbox") };
}

// Rides the real fleet CLI — skipped on hosts without the vault (CI, fresh machines).
test.skipIf(!existsSync(FLEET_CLI))("edit-intent round-trip: send via fleet.py → drain → apply to the owning catalogue", async () => {
  const base = mkdtempSync(join(tmpdir(), "ccs-intent-"));
  try {
    const { vault, rolesDir, inbox } = makeVault(base, "test-manager");

    // 1. Laptop side: emit the intent (a foreign mini-owned row's role edge).
    const sent = sendIntent({
      fleetCli: FLEET_CLI,
      toRole: "test-manager",
      fromLabel: "ccs-laptop",
      ownerHost: "Milads-Mac-mini",
      mutations: [{ sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", op: "role", value: "ops-watch" }],
      fleetArgs: ["--vault", vault, "--roles-dir", rolesDir],
    });
    expect(sent.ok).toBe(true);
    expect(readdirSync(inbox).filter((f) => f.startsWith("msg-")).length).toBe(1);

    // 2. Owning-machine side: drain the inbox (the real fleet CLI), pipe into apply.
    const drain = Bun.spawnSync(
      ["python3", FLEET_CLI, "--vault", vault, "--roles-dir", rolesDir, "drain", "test-manager", "--mark"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(drain.exitCode).toBe(0);
    const lines = new TextDecoder().decode(drain.stdout).trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    const catalogue = openCatalogue(":memory:");
    const summary = applyIntents(catalogue, lines, {
      localHost: "Milads-Mac-mini",
      ownerOf: () => "Milads-Mac-mini", // the merge view agrees this row is ours
      now: "2026-07-08T12:00:00Z",
    });
    expect(summary.applied).toBe(1);
    expect(getRow(catalogue, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")!.role).toBe("ops-watch");
    catalogue.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("applyIntents skips wrong-host envelopes, poison shapes, and other types — batch survives", () => {
  const catalogue = openCatalogue(":memory:");
  const envelope = (over: Record<string, unknown>) =>
    JSON.stringify({
      id: "abc123def456",
      from: "ccs-laptop",
      to: "test-manager",
      ts: "2026-07-08T12:00:00Z",
      type: "edit-intent",
      body: {
        host: "Milads-Mac-mini",
        mutations: [{ sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", op: "role", value: "x" }],
      },
      ...over,
    });

  const summary = applyIntents(
    catalogue,
    [
      envelope({}), // fine
      envelope({ body: { host: "SomeOtherMac", mutations: [{ sessionId: "s2", op: "role", value: "y" }] } }),
      envelope({ type: "ping", body: "hello" }), // not an intent — ignored, open vocabulary
      envelope({ body: { host: true, mutations: [] } }), // non-string host: poison, must not throw
      envelope({ body: "just a string" }), // string body is legal protocol — but not a valid intent
      envelope({ body: { host: "Milads-Mac-mini", mutations: [{ sessionId: "s3", op: "title", value: 42 }] } }), // bad value type
      "not json at all", // malformed line must not abort the batch
    ],
    {
      localHost: "Milads-Mac-mini",
      ownerOf: (id) => (id === "s2" ? "SomeOtherMac" : "Milads-Mac-mini"),
      now: "2026-07-08T12:00:00Z",
    },
  );
  expect(summary.applied).toBe(1);
  expect(summary.skipped).toBe(5); // wrong-host + poison host + string body + bad value + unparseable
  expect(getRow(catalogue, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")!.role).toBe("x");
  expect(getRow(catalogue, "s2")).toBeNull(); // foreign row untouched
  expect(getRow(catalogue, "s3")).toBeNull(); // bad-typed mutation never applied
  catalogue.close();
});

test("applyIntents normalizes value spellings on apply ('yes' means completed, not un-completed)", () => {
  const catalogue = openCatalogue(":memory:");
  const line = JSON.stringify({
    id: "abc123def456",
    from: "x",
    to: "m",
    ts: "2026-07-08T12:00:00Z",
    type: "edit-intent",
    body: {
      host: "Milads-Mac-mini",
      mutations: [{ sessionId: "s1", op: "completed", value: "yes" }],
    },
  });
  applyIntents(catalogue, [line], {
    localHost: "Milads-Mac-mini",
    ownerOf: () => null,
    now: "2026-07-08T12:00:00Z",
  });
  expect(getRow(catalogue, "s1")!.completed).toBe(true);
  catalogue.close();
});

test("inbox apply is SELECTIVE: consumes this host's envelopes, leaves other hosts', dedupes", () => {
  const base = mkdtempSync(join(tmpdir(), "ccs-inbox-"));
  try {
    const stateDir = join(base, "state");
    const inbox = join(stateDir, "inbox");
    mkdirSync(inbox, { recursive: true });
    const put = (name: string, id: string, host: string, mutations: unknown[]) =>
      writeFileSync(
        join(inbox, name),
        JSON.stringify({
          id, from: "ccs-x", to: "fleet-manager", ts: "2026-07-08T12:00:00Z",
          type: "edit-intent", body: { host, mutations },
        }),
      );
    put("msg-1-ours.json", "id-ours-000001", "Milads-Mac-mini", [
      { sessionId: "s-ours", op: "role", value: "ops-watch" },
    ]);
    put("msg-2-theirs.json", "id-theirs-0001", "Milads-M3-2", [
      { sessionId: "s-theirs", op: "role", value: "x" },
    ]);
    writeFileSync(join(inbox, "msg-3-ping.json"), JSON.stringify({ id: "id-ping-000001", type: "ping", body: "hi" }));

    const catalogue = openCatalogue(":memory:");
    const opts = { localHost: "Milads-Mac-mini", ownerOf: () => null, now: "2026-07-08T12:00:00Z" };
    const summary = applyIntentsFromInbox(catalogue, stateDir, opts);
    expect(summary.applied).toBe(1);
    expect(getRow(catalogue, "s-ours")!.role).toBe("ops-watch");
    expect(getRow(catalogue, "s-theirs")).toBeNull();
    // Ours consumed (processed/ + ledger); theirs and the ping left in place.
    expect(existsSync(join(inbox, "processed", "msg-1-ours.json"))).toBe(true);
    expect(existsSync(join(inbox, "msg-2-theirs.json"))).toBe(true);
    expect(existsSync(join(inbox, "msg-3-ping.json"))).toBe(true);
    // A second pass applies nothing (ledger dedupe) and still leaves the others alone.
    const again = applyIntentsFromInbox(catalogue, stateDir, opts);
    expect(again.applied).toBe(0);
    expect(existsSync(join(inbox, "msg-2-theirs.json"))).toBe(true);
    catalogue.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("inbox apply dead-letters malformed intents and refused-foreign mutations (never drops)", () => {
  const base = mkdtempSync(join(tmpdir(), "ccs-inbox-"));
  try {
    const stateDir = join(base, "state");
    const inbox = join(stateDir, "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(
      join(inbox, "msg-1-bad.json"),
      JSON.stringify({
        id: "id-badbody-0001", from: "x", to: "m", ts: "t", type: "edit-intent", body: "not an object",
      }),
    );
    writeFileSync(
      join(inbox, "msg-2-mixed.json"),
      JSON.stringify({
        id: "id-mixed-00001", from: "x", to: "m", ts: "t", type: "edit-intent",
        body: {
          host: "Milads-Mac-mini",
          mutations: [
            { sessionId: "s-ok", op: "skill", value: "fine" },
            { sessionId: "s-foreign", op: "skill", value: "nope" },
          ],
        },
      }),
    );
    const catalogue = openCatalogue(":memory:");
    const summary = applyIntentsFromInbox(catalogue, stateDir, {
      localHost: "Milads-Mac-mini",
      ownerOf: (id) => (id === "s-foreign" ? "Milads-M3-2" : null),
      now: "2026-07-08T12:00:00Z",
    });
    expect(summary.applied).toBe(1); // s-ok
    expect(getRow(catalogue, "s-ok")!.skill).toBe("fine");
    expect(getRow(catalogue, "s-foreign")).toBeNull();
    // Both envelopes consumed; both have dead-letter records (nothing vanished silently).
    expect(existsSync(join(stateDir, "dead-letter", "msg-1-bad.json"))).toBe(true);
    expect(existsSync(join(stateDir, "dead-letter", "msg-2-mixed.json"))).toBe(true);
    expect(existsSync(join(inbox, "processed", "msg-2-mixed.json"))).toBe(true);
    catalogue.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("applyIntents refuses a locally-foreign mutation even inside a correctly-addressed envelope", () => {
  const catalogue = openCatalogue(":memory:");
  const line = JSON.stringify({
    id: "abc123def456",
    from: "ccs-laptop",
    to: "m",
    ts: "2026-07-08T12:00:00Z",
    type: "edit-intent",
    body: {
      host: "Milads-Mac-mini",
      mutations: [
        { sessionId: "ours", op: "skill", value: "ok" },
        { sessionId: "theirs", op: "skill", value: "nope" }, // merge says another machine owns it
      ],
    },
  });
  const summary = applyIntents(catalogue, [line], {
    localHost: "Milads-Mac-mini",
    ownerOf: (id) => (id === "theirs" ? "Milads-M3-2" : null), // unknown → assumed local
    now: "2026-07-08T12:00:00Z",
  });
  expect(summary.applied).toBe(1);
  expect(getRow(catalogue, "ours")!.skill).toBe("ok");
  expect(getRow(catalogue, "theirs")).toBeNull();
  catalogue.close();
});
