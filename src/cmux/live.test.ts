import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cmuxVersion,
  createLiveBridgeReader,
  liveBridgeAsync,
  type AsyncCmuxIo,
} from "./live.ts";

const fixtures = join(import.meta.dir, "__fixtures__");
const tree = readFileSync(join(fixtures, "tree.json"), "utf8");
const store = readFileSync(join(fixtures, "hook-store.json"), "utf8");

interface FakeOptions {
  version?: string;
  tree?: string;
  treeOk?: boolean;
  store?: string | null;
  storeFailure?: boolean;
}

function fakeIo(options: FakeOptions = {}): AsyncCmuxIo & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    now: () => 10,
    async execFile(_file, args): Promise<{ ok: boolean; stdout: string }> {
      calls.push([...args]);
      if (args[0] === "--version") return { ok: true, stdout: options.version ?? "cmux 0.64.0" };
      return { ok: options.treeOk ?? true, stdout: options.tree ?? tree };
    },
    async readFile(): Promise<{ found: boolean; content: string | null }> {
      if (options.storeFailure) throw new Error("denied");
      return options.store === null ? { found: false, content: null } : { found: true, content: options.store ?? store };
    },
  };
}

type VersionStep =
  | { readonly kind: "output"; readonly value: string }
  | { readonly kind: "reject" };

interface ScriptedVersionIo extends AsyncCmuxIo {
  readonly calls: string[][];
  setNow(value: number): void;
}

function scriptedVersionIo(steps: readonly VersionStep[]): ScriptedVersionIo {
  const calls: string[][] = [];
  let currentNow = 0;
  let versionIndex = 0;
  return {
    calls,
    now: () => currentNow,
    setNow(value: number): void {
      currentNow = value;
    },
    async execFile(_file, args): Promise<{ ok: boolean; stdout: string }> {
      calls.push([...args]);
      if (args[0] !== "--version") return { ok: true, stdout: tree };
      const step = steps[Math.min(versionIndex, steps.length - 1)];
      versionIndex += 1;
      if (!step || step.kind === "reject") throw new Error("version probe failed");
      return { ok: true, stdout: step.value };
    },
    async readFile(): Promise<{ found: boolean; content: string | null }> {
      return { found: true, content: store };
    },
  };
}

describe("cmuxVersion", () => {
  test("returns a parsed version or null when cmux is unavailable", () => {
    const version = cmuxVersion();
    if (version) expect(version.major).toBeGreaterThanOrEqual(0);
  });
});

describe("liveBridgeAsync", () => {
  test("does not settle before deferred I/O and requests every workspace", async () => {
    const releases: Array<() => void> = [];
    const gate = new Promise<void>((resolve) => { releases.push(resolve); });
    const io: AsyncCmuxIo = {
      now: () => 0,
      async execFile(_file, args): Promise<{ ok: boolean; stdout: string }> {
        await gate;
        return { ok: true, stdout: args[0] === "--version" ? "cmux 0.64.0" : tree };
      },
      async readFile(): Promise<{ found: boolean; content: string | null }> {
        await gate;
        return { found: true, content: store };
      },
    };
    let settled = false;
    const bridge = liveBridgeAsync(io).then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releases[0]!();
    expect((await bridge).readable).toBe(true);
  });

  test("uses tree --all --json --id-format both", async () => {
    const io = fakeIo();
    await liveBridgeAsync(io);
    expect(io.calls).toContainEqual(["tree", "--all", "--json", "--id-format", "both"]);
  });

  test("retries a rejected version probe on the next read", async () => {
    const io = scriptedVersionIo([
      { kind: "reject" },
      { kind: "output", value: "cmux 0.64.0" },
    ]);
    const readBridge = createLiveBridgeReader({ io, versionTtlMs: 100 });

    expect((await readBridge()).readable).toBe(false);
    expect((await readBridge()).readable).toBe(true);
    expect(io.calls.filter((args) => args[0] === "--version")).toHaveLength(2);
    expect(io.calls.filter((args) => args[0] === "tree")).toHaveLength(2);
  });

  test("retries an unparseable version and never bypasses the pre-0.64 fail-closed check", async () => {
    const io = scriptedVersionIo([
      { kind: "output", value: "not a version" },
      { kind: "output", value: "cmux 0.63.9" },
    ]);
    const readBridge = createLiveBridgeReader({ io, versionTtlMs: 100 });

    expect((await readBridge()).readable).toBe(false);
    expect((await readBridge()).readable).toBe(false);
    expect(io.calls.filter((args) => args[0] === "--version")).toHaveLength(2);
  });

  test("single-flights concurrent version probes and reuses success within the TTL", async () => {
    const io = scriptedVersionIo([{ kind: "output", value: "cmux 0.64.0" }]);
    const readBridge = createLiveBridgeReader({ io, cmuxBin: "custom-cmux", versionTtlMs: 100 });

    const [first, concurrent] = await Promise.all([readBridge(), readBridge()]);
    expect(first.readable).toBe(true);
    expect(concurrent.readable).toBe(true);
    io.setNow(99);
    expect((await readBridge()).readable).toBe(true);

    expect(io.calls.filter((args) => args[0] === "--version")).toHaveLength(1);
    expect(io.calls.filter((args) => args[0] === "tree")).toHaveLength(3);
  });

  test("revalidates a successful version after TTL and observes a changed version", async () => {
    const io = scriptedVersionIo([
      { kind: "output", value: "cmux 0.64.0" },
      { kind: "output", value: "cmux 0.63.9" },
    ]);
    const readBridge = createLiveBridgeReader({ io, versionTtlMs: 100 });

    expect((await readBridge()).readable).toBe(true);
    io.setNow(100);
    expect((await readBridge()).readable).toBe(false);

    expect(io.calls.filter((args) => args[0] === "--version")).toHaveLength(2);
    expect(io.calls.filter((args) => args[0] === "tree")).toHaveLength(2);
  });

  test("is unreadable when tree fails or JSON is invalid", async () => {
    expect((await liveBridgeAsync(fakeIo({ treeOk: false }))).readable).toBe(false);
    expect((await liveBridgeAsync(fakeIo({ tree: "not-json" }))).readable).toBe(false);
  });

  test("treats missing store as empty but malformed or unreadable store as unreadable", async () => {
    expect((await liveBridgeAsync(fakeIo({ store: null }))).readable).toBe(true);
    expect((await liveBridgeAsync(fakeIo({ store: "not-json" }))).readable).toBe(false);
    expect((await liveBridgeAsync(fakeIo({ storeFailure: true }))).readable).toBe(false);
  });

  test("fails closed before cmux 0.64 and permits an untested major", async () => {
    expect((await liveBridgeAsync(fakeIo({ version: "cmux 0.63.9" }))).readable).toBe(false);
    expect((await liveBridgeAsync(fakeIo({ version: "cmux 1.0.0" }))).readable).toBe(true);
  });
});
