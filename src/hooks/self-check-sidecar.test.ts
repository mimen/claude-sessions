import { describe, test, expect } from "bun:test";
import { parseCommands } from "./self-check-sidecar.ts";

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("parseCommands (self-check sidecar output → executable ccs argvs)", () => {
  test("NONE → empty", () => {
    expect(parseCommands("NONE", SID)).toEqual([]);
    expect(parseCommands("none", SID)).toEqual([]);
    expect(parseCommands("  NONE  ", SID)).toEqual([]);
  });

  test("empty output → empty", () => {
    expect(parseCommands("", SID)).toEqual([]);
    expect(parseCommands("\n\n", SID)).toEqual([]);
  });

  test("substitutes {SID}, parses double-quoted args", () => {
    const out = `ccs name {SID} "addons plan list + settings page"\nccs status {SID} "rebasing on main"`;
    expect(parseCommands(out, SID)).toEqual([
      ["ccs", "name", SID, "addons plan list + settings page"],
      ["ccs", "status", SID, "rebasing on main"],
    ]);
  });

  test("--off flags pass through", () => {
    const out = `ccs status {SID} --off`;
    expect(parseCommands(out, SID)).toEqual([
      ["ccs", "status", SID, "--off"],
    ]);
  });

  test("rejects non-whitelisted subcommands (activity, stage, and anything else)", () => {
    // Stage is engine-computed; activity is dead (2026-07-13). Whitelist is name + status only.
    const out = `ccs rm {SID}\nccs archive {SID}\nccs activity {SID} needs-you\nccs stage {SID} milad-review\nccs name {SID} "keep me"`;
    expect(parseCommands(out, SID)).toEqual([
      ["ccs", "name", SID, "keep me"],
    ]);
  });

  test("rejects commands missing {SID} (defense against model omitting the target)", () => {
    const out = `ccs name . "foo"\nccs status . "bar"\nccs name {SID} "keep me"`;
    expect(parseCommands(out, SID)).toEqual([
      ["ccs", "name", SID, "keep me"],
    ]);
  });

  test("rejects lines that aren't ccs commands", () => {
    const out = `Here are the updates:\nccs name {SID} "ok"\nThe end.`;
    expect(parseCommands(out, SID)).toEqual([
      ["ccs", "name", SID, "ok"],
    ]);
  });

  test("strips leading $ / > shell prompts", () => {
    const out = `$ ccs name {SID} "foo"\n> ccs status {SID} "bar"`;
    expect(parseCommands(out, SID)).toEqual([
      ["ccs", "name", SID, "foo"],
      ["ccs", "status", SID, "bar"],
    ]);
  });

  test("NONE mixed with commands: NONE is filtered, commands run", () => {
    // The model shouldn't do this, but if it does we take the commands.
    const out = `ccs name {SID} "foo"\nNONE`;
    expect(parseCommands(out, SID)).toEqual([
      ["ccs", "name", SID, "foo"],
    ]);
  });

  test("handles escaped quotes inside a shortname", () => {
    const out = `ccs name {SID} "call it \\"the thing\\""`;
    expect(parseCommands(out, SID)).toEqual([
      ["ccs", "name", SID, `call it "the thing"`],
    ]);
  });
});
