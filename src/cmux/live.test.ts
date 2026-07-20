import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cmuxVersion, liveBridgeAsync, type AsyncCmuxIo } from "./live.ts";

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
