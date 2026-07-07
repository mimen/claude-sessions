import { describe, expect, test } from "bun:test";
import { classifyPath, parseFrontmatter } from "./scan.ts";
import { extractEvents, makeSkillDirMatcher } from "./usage.ts";

const HOME = "/Users/mimen";

describe("classifyPath", () => {
  test("runtime user skills", () => {
    expect(classifyPath(`${HOME}/.claude/skills/beeper`, HOME)).toBe("claude-user");
  });
  test("vault ClaudeConfig source resolves to claude-user", () => {
    expect(classifyPath(`${HOME}/Documents/milad-vault/ClaudeConfig/skills/beeper`, HOME)).toBe("claude-user");
  });
  test("workspace-local project skills", () => {
    expect(classifyPath(`${HOME}/Documents/milad-vault/Workspaces/Events/.claude/skills/event-prep`, HOME)).toBe(
      "claude-project",
    );
  });
  test("marketplace catalogs vs installed plugin copies", () => {
    expect(classifyPath(`${HOME}/.claude/plugins/marketplaces/anthropic-agent-skills/skills/pdf`, HOME)).toBe(
      "marketplace",
    );
    expect(classifyPath(`${HOME}/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1/skills/brainstorming`, HOME)).toBe(
      "plugin",
    );
  });
  test("other-harness ecosystems", () => {
    expect(classifyPath(`${HOME}/.agents/skills/grill-me`, HOME)).toBe("agents");
    expect(classifyPath(`${HOME}/.codex/skills/.system/imagegen`, HOME)).toBe("codex");
    expect(classifyPath(`${HOME}/.cursor/skills-cursor/loop`, HOME)).toBe("cursor");
    expect(classifyPath(`${HOME}/.hermes/skills/apple/imessage`, HOME)).toBe("hermes");
  });
  test("codex catalog caches are marketplace, not installs", () => {
    expect(classifyPath(`${HOME}/.codex/.tmp/plugins/plugins/hubspot/skills/hubspot`, HOME)).toBe("marketplace");
    expect(classifyPath(`${HOME}/.codex/vendor_imports/skills/skills/.curated/figma`, HOME)).toBe("marketplace");
  });
  test("archives and downloads", () => {
    expect(classifyPath(`${HOME}/Documents/milad-vault/_archive/Sol/skills/heartbeat`, HOME)).toBe("archive");
    expect(classifyPath(`${HOME}/Downloads/skills-main/pdf`, HOME)).toBe("download");
  });
  test("loop-repo skills classify as project-local", () => {
    expect(classifyPath(`${HOME}/Documents/event-watch/skills/event-worker`, HOME)).toBe("claude-project");
  });
});

describe("parseFrontmatter", () => {
  test("simple key: value", () => {
    const fm = parseFrontmatter("---\nname: beeper\ndescription: Send messages.\n---\n# Body\n");
    expect(fm.name).toBe("beeper");
    expect(fm.description).toBe("Send messages.");
  });
  test("folded multi-line description", () => {
    const fm = parseFrontmatter("---\nname: x\ndescription: >-\n  line one\n  line two\n---\n");
    expect(fm.description).toBe("line one line two");
  });
  test("no frontmatter", () => {
    expect(parseFrontmatter("# Just a doc\n")).toEqual({});
  });
  test("quoted values are unquoted", () => {
    const fm = parseFrontmatter('---\nname: "quoted"\n---\n');
    expect(fm.name).toBe("quoted");
  });
});

describe("extractEvents", () => {
  const matcher = makeSkillDirMatcher(
    new Map([
      [`${HOME}/.claude/skills/cmux`, "cmux"],
      [`${HOME}/Documents/milad-vault/ClaudeConfig/skills/looping`, "looping"],
    ]),
  );

  test("Skill invocation", () => {
    const line = `{"timestamp":"2026-07-06T01:02:03Z","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"beeper"}}]}}`;
    expect(extractEvents(line, matcher)).toEqual([{ skill: "beeper", kind: "invoke", ts: "2026-07-06T01:02:03Z" }]);
  });

  test("plugin-namespaced invocation is stripped to the slug", () => {
    const line = `{"timestamp":"t","x":[{"type":"tool_use","name":"Skill","input":{"skill":"superpowers:brainstorming"}}]}`;
    expect(extractEvents(line, matcher)[0]?.skill).toBe("brainstorming");
  });

  test("slash command", () => {
    const line = `{"timestamp":"2026-07-05T00:00:00Z","message":{"content":"<command-name>/event-watch</command-name><command-args>tick</command-args>"}}`;
    expect(extractEvents(line, matcher)).toEqual([{ skill: "event-watch", kind: "command", ts: "2026-07-05T00:00:00Z" }]);
  });

  test("Read into a skill dir counts as a doc read", () => {
    const line = `{"timestamp":"t2","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"${HOME}/.claude/skills/cmux/SKILL.md"}}]}}`;
    expect(extractEvents(line, matcher)).toEqual([{ skill: "cmux", kind: "read", ts: "t2" }]);
  });

  test("Read into a nested reference file still attributes to the skill", () => {
    const line = `{"timestamp":"t3","x":[{"name":"Read","input":{"file_path":"${HOME}/Documents/milad-vault/ClaudeConfig/skills/looping/references/tenets.md"}}]}`;
    expect(extractEvents(line, matcher)).toEqual([{ skill: "looping", kind: "read", ts: "t3" }]);
  });

  test("Read outside any skill dir is ignored", () => {
    const line = `{"timestamp":"t4","x":[{"name":"Read","input":{"file_path":"/tmp/notes.md"}}]}`;
    expect(extractEvents(line, matcher)).toEqual([]);
  });

  test("plain lines produce nothing", () => {
    expect(extractEvents('{"timestamp":"t","type":"user","message":{"content":"hello"}}', matcher)).toEqual([]);
  });
});
