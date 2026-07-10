import { describe, expect, test } from "bun:test";
import { mergeManagedHooks, MANAGED_TAG, type HookEntry } from "./hook-materialize.ts";

/** A ccs-managed hook entry carries the sentinel tag so re-sync can find + replace only its own. */
const ccsHook = (event: string, cmd: string): { event: string; entry: HookEntry } => ({
  event,
  entry: { matcher: "*", hooks: [{ type: "command", command: cmd, [MANAGED_TAG]: true }] },
});

describe("mergeManagedHooks", () => {
  test("adds ccs hooks into an empty settings object", () => {
    const out = mergeManagedHooks({}, [ccsHook("SessionStart", "ccs register-session")]);
    expect(out.hooks.SessionStart!).toHaveLength(1);
    expect(out.hooks.SessionStart![0]!.hooks[0]!.command).toBe("ccs register-session");
  });

  test("preserves the user's existing NON-ccs hooks on the same event", () => {
    const existing = {
      hooks: {
        SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "user-island-hook" }] }],
      },
    };
    const out = mergeManagedHooks(existing, [ccsHook("SessionStart", "ccs register-session")]);
    const cmds = out.hooks.SessionStart!.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds).toContain("user-island-hook"); // user's hook untouched
    expect(cmds).toContain("ccs register-session"); // ccs's hook added
  });

  test("re-sync REPLACES ccs's own managed entries, not duplicating them", () => {
    const first = mergeManagedHooks({}, [ccsHook("SessionStart", "ccs register-session")]);
    const second = mergeManagedHooks(first, [ccsHook("SessionStart", "ccs register-session --v2")]);
    // only ONE ccs-managed SessionStart entry survives, with the new command
    const managed = second.hooks.SessionStart!.filter((e: any) => e.hooks.some((h: any) => h[MANAGED_TAG]));
    expect(managed).toHaveLength(1);
    expect(managed[0]!.hooks[0]!.command).toBe("ccs register-session --v2");
  });

  test("removing a ccs hook from the desired set prunes it on re-sync (user hooks stay)", () => {
    const withCcs = mergeManagedHooks(
      { hooks: { Stop: [{ matcher: "*", hooks: [{ type: "command", command: "user-stop" }] }] } },
      [ccsHook("Stop", "ccs worker-stop")],
    );
    // now re-sync with NO ccs Stop hook desired -> ccs's is pruned, user's remains
    const pruned = mergeManagedHooks(withCcs, []);
    const cmds = pruned.hooks.Stop!.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds).toContain("user-stop");
    expect(cmds).not.toContain("ccs worker-stop");
  });

  test("prunes a whole event key if only ccs hooks were there", () => {
    const withCcs = mergeManagedHooks({}, [ccsHook("SessionStart", "ccs register-session")]);
    const pruned = mergeManagedHooks(withCcs, []);
    // SessionStart had only ccs's hook -> the event key is gone (or empty), not a dangling []
    expect(pruned.hooks.SessionStart === undefined || pruned.hooks.SessionStart.length === 0).toBe(true);
  });

  test("never mutates non-hook settings keys", () => {
    const existing = { model: "opus", permissions: { allow: ["x"] }, hooks: {} };
    const out = mergeManagedHooks(existing, [ccsHook("SessionStart", "ccs register-session")]);
    expect(out.model).toBe("opus");
    expect(out.permissions).toEqual({ allow: ["x"] });
  });
});
