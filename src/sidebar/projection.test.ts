import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { StoredEnrichment } from "../catalogue/enrichment.ts";
import {
  cleanSessionName,
  directoriesToResolve,
  directoryLabel,
  modelOf,
  projectSidebar,
  sectionForStatus,
  sidebarLifecycleOf,
  type IndexedSessionInput,
  type LiveSessionInput,
  type LiveWorkspaceInput,
  type ProjectionInput,
  type SidebarRow,
  type SidebarSessionRow,
} from "./projection.ts";
import { familyOf } from "../display/format.ts";

/** Narrow to the session rows an assertion is about; sessionless workspaces carry no model. */
function sessionRows(rows: readonly SidebarRow[]): SidebarSessionRow[] {
  return rows.filter((row): row is SidebarSessionRow => row.kind === "session");
}

function workspace(overrides: Partial<LiveWorkspaceInput> = {}): LiveWorkspaceInput {
  return {
    workspaceId: "ws-plain",
    workspaceRef: "workspace:9",
    workspaceTitle: "zsh",
    windowId: "win-uuid",
    windowRef: "window:1",
    pinned: false,
    focused: false,
    shortcut: null,
    cwd: null,
    surfaceKinds: ["terminal"],
    ...overrides,
  };
}

function live(overrides: Partial<LiveSessionInput> = {}): LiveSessionInput {
  return {
    sessionId: "live-1",
    workspaceId: "ws-uuid",
    workspaceRef: "workspace:1",
    windowId: "win-uuid",
    windowRef: "window:1",
    workspaceTitle: "Design the sidebar",
    pinned: false,
    focused: false,
    shortcut: null,
    cwd: "/Users/m/Repos/claude-sessions",
    status: { label: "Running", icon: "bolt.fill", color: "#4C8DFF" },
    statusAvailability: "published",
    updatedAt: 1_700_000_000,
    ...overrides,
  };
}

function indexed(overrides: Partial<IndexedSessionInput> = {}): IndexedSessionInput {
  return {
    sessionId: "live-1",
    resumeId: "live-1",
    title: "Indexed title",
    cwd: "/Users/m/Repos/claude-sessions",
    lastTs: "2026-07-24T20:00:00.000Z",
    models: ["gpt-5.6-sol"],
    costByModel: {},
    ...overrides,
  };
}

function input(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    live: [],
    indexed: [],
    checkouts: new Map(),
    livenessReadable: true,
    now: 1_700_000_500_000,
    ...overrides,
  };
}

function storedEnrichment(
  recommendation: StoredEnrichment["recommendation"],
  declined: StoredEnrichment["declined"] = null,
): StoredEnrichment {
  return {
    title: null,
    state: "Mixed fixture state",
    history: "Mixed fixture history",
    next: "Mixed fixture next",
    remaining: null,
    recommendation,
    reason: "Mixed fixture reason",
    junk: false,
    cwdCorrect: true,
    suggestedLocation: null,
    suggestedCwd: null,
    atMessages: 10,
    at: "2026-08-05T11:00:00.000Z",
    legacyShape: false,
    declined,
  };
}

/** One deliberately cross-cutting input used to freeze the projection's serialized contract. */
function mixedProjectionInput(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  const root = "/Users/m/Repos/mixed";
  return input({
    live: [
      live({
        sessionId: "resume-live",
        workspaceId: "ws-live",
        workspaceRef: "workspace:1",
        workspaceTitle: "⠐ Live alias",
        pinned: true,
        shortcut: 1,
        updatedAt: 1_785_931_199,
      }),
      live({
        sessionId: "terminal-live",
        workspaceId: "ws-terminal",
        workspaceRef: "workspace:2",
        workspaceTitle: "Terminal live",
        status: null,
        statusAvailability: "absent",
        updatedAt: 1_785_931_100,
      }),
      live({
        sessionId: "declined-live",
        workspaceId: "ws-declined",
        workspaceRef: "workspace:3",
        workspaceTitle: "Declined live",
        status: { label: "Needs input", icon: null, color: "#f00" },
        updatedAt: 1_785_931_050,
      }),
    ],
    workspaces: [workspace({
      workspaceId: "ws-browser",
      workspaceRef: "workspace:4",
      workspaceTitle: "Reference browser",
      cwd: root,
      surfaceKinds: ["browser", "terminal"],
    })],
    liveSessionIds: new Set([
      "resume-live",
      "terminal-live",
      "declined-live",
      "secondary-resume",
    ]),
    indexed: [
      indexed({
        sessionId: "canonical-live",
        resumeId: "resume-live",
        title: "Indexed alias",
        cwd: root,
        lastTs: "2026-08-05T11:59:00.000Z",
        messageCount: 14,
        transcriptMtimeMs: Date.parse("2026-08-05T11:30:00.000Z"),
      }),
      indexed({
        sessionId: "declined-live",
        resumeId: "declined-resume",
        title: "Declined indexed",
        cwd: root,
        lastTs: "2026-08-05T11:58:00.000Z",
      }),
      indexed({
        sessionId: "closed-triage",
        resumeId: "closed-triage-resume",
        title: "Closed triage",
        cwd: root,
        lastTs: "2026-08-05T11:57:00.000Z",
      }),
      indexed({
        sessionId: "secondary-file",
        resumeId: "secondary-resume",
        title: "Non-primary live surface",
        cwd: root,
        lastTs: "2026-08-05T11:56:00.000Z",
      }),
      indexed({
        sessionId: "terminal-closed",
        resumeId: "terminal-closed-resume",
        title: "Terminal closed",
        cwd: root,
        lastTs: "2026-08-05T11:55:00.000Z",
      }),
      indexed({
        sessionId: "archived-id",
        resumeId: "archived-resume",
        title: "Archived closed",
        cwd: root,
        lastTs: "2026-08-05T11:54:00.000Z",
      }),
      indexed({
        sessionId: "identity-file",
        resumeId: "identity-resume",
        title: "Parked identity",
        cwd: root,
        lastTs: "2026-08-05T11:53:00.000Z",
      }),
    ],
    lifecycles: new Map([
      ["terminal-live", "completed"],
      ["terminal-closed-resume", "completed"],
      ["archived-resume", "archived"],
    ]),
    catalogueLifecycles: new Map([
      ["resume-live", "idle"],
      ["terminal-live", "completed"],
      ["declined-resume", "idle"],
      ["closed-triage-resume", "idle"],
      ["terminal-closed-resume", "completed"],
      ["archived-resume", "archived"],
      ["identity-resume", "parked"],
    ]),
    canonicalSessionIds: new Map([
      ["canonical-live", "canonical-live"],
      ["resume-live", "canonical-live"],
      ["terminal-live", "terminal-live"],
      ["closed-triage-resume", "closed-triage"],
    ]),
    summaries: new Map([
      ["resume-live", storedEnrichment("archive")],
      ["declined-resume", storedEnrichment("archive", "archive")],
      ["closed-triage-resume", storedEnrichment("complete")],
      ["identity-resume", storedEnrichment("complete")],
    ]),
    preferredTitles: new Map([["resume-live", "Canonical live title"]]),
    memberships: new Map([["resume-live", {
      identityKey: "identity:live",
      cluster: "projection",
      role: "core",
      kind: "core",
    }]]),
    checkouts: new Map([[root, { project: "mixed", worktree: "projection", branch: "phase-5" }]]),
    faviconDirectories: new Set([root]),
    unreadByWorkspaceId: new Map([["ws-live", 2], ["ws-browser", 1]]),
    includeLifecycles: ["completed", "archived"],
    lifecycleCounts: { active: 5, completed: 2, archived: 1 },
    recentLimit: 4,
    historyLimit: 2,
    hasMoreRows: true,
    ...overrides,
  });
}

describe("modelOf", () => {
  test("resolves gateway models to their short name and provider", () => {
    expect(modelOf("gpt-5.6-sol")).toMatchObject({ label: "Sol", provider: "openai" });
    expect(modelOf("gpt-5.6-terra")).toMatchObject({ label: "Terra", provider: "openai" });
  });

  test("resolves Claude families to their short name and provider", () => {
    expect(modelOf("claude-opus-5")).toMatchObject({ label: "Opus", provider: "anthropic" });
    expect(modelOf("claude-fable-5")).toMatchObject({ label: "Fable", provider: "anthropic" });
  });

  test("keeps an unknown model id visible rather than hiding it", () => {
    expect(modelOf("some-new-model")).toMatchObject({ label: "some-new-model", provider: "unknown" });
  });
});

describe("sidebarLifecycleOf", () => {
  test("maps terminal catalogue states and collapses idle or parked to active", () => {
    expect(sidebarLifecycleOf("idle")).toBe("active");
    expect(sidebarLifecycleOf("parked")).toBe("active");
    expect(sidebarLifecycleOf("completed")).toBe("completed");
    expect(sidebarLifecycleOf("archived")).toBe("archived");
  });
});

describe("model colours", () => {
  test("takes its colour from CCS rather than a copy that can drift", () => {
    for (const id of [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "some-unrecognised-model",
    ]) {
      expect(modelOf(id).color).toBe(familyOf(id).color);
    }
  });
});

describe("sectionForStatus", () => {
  test("routes cmux's own status words", () => {
    expect(sectionForStatus({ label: "Needs input", icon: null, color: null })).toBe("needs-you");
    expect(sectionForStatus({ label: "Running", icon: null, color: null })).toBe("working");
    expect(sectionForStatus({ label: "Idle", icon: null, color: null })).toBe("ready");
  });

  test("keeps a successful no-status result distinct from an unreadable command", () => {
    expect(sectionForStatus(null, "absent")).toBe("ready");
    expect(sectionForStatus({ label: "", icon: null, color: null }, "published")).toBe("ready");
    expect(sectionForStatus(null, "unreadable")).toBe("needs-you");
  });
});

describe("cleanSessionName", () => {
  test("drops cmux's activity glyphs, which the status pill already says", () => {
    expect(cleanSessionName("✳ Reduce idle session RAM usage")).toBe("Reduce idle session RAM usage");
    expect(cleanSessionName("⠐ Design Cmux sidebar integration")).toBe("Design Cmux sidebar integration");
    expect(cleanSessionName("⠂ Debug managed session verification")).toBe("Debug managed session verification");
  });

  test("leaves an ordinary title untouched", () => {
    expect(cleanSessionName("Messaging App CRM")).toBe("Messaging App CRM");
    expect(cleanSessionName("  Add safe close-workspace command ")).toBe("Add safe close-workspace command");
  });

  test("keeps a title that is only glyphs rather than blanking the row", () => {
    expect(cleanSessionName("✳")).toBe("✳");
  });
});

describe("directoryLabel", () => {
  test("reduces a path to its final segment", () => {
    expect(directoryLabel("/Users/m/Repos/claude-sessions")).toBe("claude-sessions");
    expect(directoryLabel("/Users/m/Repos/claude-sessions/")).toBe("claude-sessions");
  });

  test("returns null when there is no directory", () => {
    expect(directoryLabel(null)).toBeNull();
    expect(directoryLabel("/")).toBeNull();
  });
});

describe("projectSidebar", () => {
  test("builds a live row from cmux state joined to the index", () => {
    const snapshot = projectSidebar(input({
      live: [live()],
      indexed: [indexed()],
      checkouts: new Map([["/Users/m/Repos/claude-sessions", { project: "claude-sessions", worktree: "cmux-t3-sidebar-v1", branch: "wt" }]]),
    }));

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]).toMatchObject({
      sessionId: "live-1",
      lifecycle: "active",
      name: "Design the sidebar",
      directory: "claude-sessions",
      worktree: "cmux-t3-sidebar-v1",
      section: "working",
      workspaceRef: "workspace:1",
    });
    expect(sessionRows(snapshot.rows)[0]?.model).toMatchObject({ label: "Sol" });
    expect(snapshot.rows[0]?.status).toMatchObject({ label: "Running", icon: "bolt.fill" });
  });

  test("publishes the canonical catalogue id for a live resume alias", () => {
    const snapshot = projectSidebar(input({
      live: [live({ sessionId: "resume-id" })],
      indexed: [indexed({ sessionId: "canonical-id", resumeId: "resume-id" })],
      canonicalSessionIds: new Map([
        ["canonical-id", "canonical-id"],
        ["resume-id", "canonical-id"],
      ]),
    }));

    expect(sessionRows(snapshot.rows)[0]?.sessionId).toBe("canonical-id");
  });

  test("shows the project with no worktree line in the main checkout", () => {
    const snapshot = projectSidebar(input({
      live: [live({ cwd: "/Users/m/Repos/claude-sessions" })],
      checkouts: new Map([["/Users/m/Repos/claude-sessions", { project: "claude-sessions", worktree: null, branch: "main" }]]),
    }));

    expect(snapshot.rows[0]).toMatchObject({ directory: "claude-sessions", worktree: null });
  });

  test("names the project above the worktree, not the worktree folder", () => {
    const cwd = "/Users/m/Repos/claude-sessions/.claude/worktrees/sidebar-v2";
    const snapshot = projectSidebar(input({
      live: [live({ cwd })],
      checkouts: new Map([[cwd, { project: "claude-sessions", worktree: "sidebar-v2", branch: "wt" }]]),
    }));

    expect(snapshot.rows[0]).toMatchObject({ directory: "claude-sessions", worktree: "sidebar-v2" });
  });

  test("reads several worktrees of one repository as the same project", () => {
    const first = "/Users/m/Repos/app/.claude/worktrees/one";
    const second = "/Users/m/Repos/app/.claude/worktrees/two";
    const snapshot = projectSidebar(input({
      live: [live({ sessionId: "a", cwd: first }), live({ sessionId: "b", cwd: second })],
      checkouts: new Map([
        [first, { project: "app", worktree: "one", branch: null }],
        [second, { project: "app", worktree: "two", branch: null }],
      ]),
    }));

    expect(snapshot.rows.map((row) => row.directory)).toEqual(["app", "app"]);
    expect(snapshot.rows.map((row) => row.worktree)).toEqual(["one", "two"]);
  });

  test("falls back to the folder name outside a git checkout", () => {
    const snapshot = projectSidebar(input({ live: [live({ cwd: "/Users/m/scratch/notes" })] }));

    expect(snapshot.rows[0]).toMatchObject({ directory: "notes", worktree: null });
  });

  test("prefers the live cmux workspace title over the indexed title", () => {
    const snapshot = projectSidebar(input({
      live: [live({ workspaceTitle: "Live title" })],
      indexed: [indexed({ title: "Stale indexed title" })],
    }));

    expect(snapshot.rows[0]?.name).toBe("Live title");
  });

  test("falls back to the indexed title when cmux has no workspace title", () => {
    const snapshot = projectSidebar(input({
      live: [live({ workspaceTitle: null })],
      indexed: [indexed({ title: "Indexed title" })],
    }));

    expect(snapshot.rows[0]?.name).toBe("Indexed title");
  });

  test("preserves cmux ordering for live rows", () => {
    const snapshot = projectSidebar(input({
      live: [
        live({ sessionId: "a", workspaceTitle: "A", updatedAt: 1_000 }),
        live({ sessionId: "b", workspaceTitle: "B", updatedAt: 9_000 }),
      ],
    }));

    expect(sessionRows(snapshot.rows).map((row) => row.sessionId)).toEqual(["a", "b"]);
  });

  test("shelves recent sessions that are not live", () => {
    const snapshot = projectSidebar(input({
      live: [live({ sessionId: "live-1" })],
      indexed: [
        indexed({ sessionId: "live-1", resumeId: "live-1" }),
        indexed({ sessionId: "old-1", resumeId: "old-1", title: "Earlier work", cwd: "/Users/m/Repos/other" }),
      ],
    }));

    expect(snapshot.rows).toHaveLength(2);
    expect(snapshot.rows[1]).toMatchObject({
      sessionId: "old-1",
      name: "Earlier work",
      section: "recent",
      status: null,
      workspaceRef: null,
    });
  });

  test("active scope excludes completed and archived live or shelved rows", () => {
    const snapshot = projectSidebar(input({
      live: [
        live({ sessionId: "active-live", workspaceTitle: "Active live" }),
        live({ sessionId: "completed-live", workspaceTitle: "Completed live" }),
      ],
      indexed: [
        indexed({ sessionId: "active-live", resumeId: "active-live" }),
        indexed({ sessionId: "completed-live", resumeId: "completed-live" }),
        indexed({ sessionId: "active-closed", resumeId: "active-closed" }),
        indexed({ sessionId: "archived-closed", resumeId: "archived-closed" }),
      ],
      lifecycles: new Map([
        ["completed-live", "completed"],
        ["archived-closed", "archived"],
      ]),
      scope: "active",
    }));

    expect(sessionRows(snapshot.rows).map((row) => row.sessionId)).toEqual(["active-live", "active-closed"]);
    expect(sessionRows(snapshot.rows).every((row) => row.lifecycle === "active")).toBeTrue();
  });

  test("completed scope is newest first and keeps a completed live session reachable", () => {
    const snapshot = projectSidebar(input({
      live: [live({ sessionId: "completed-live", workspaceRef: "workspace:44" })],
      indexed: [
        indexed({
          sessionId: "completed-live",
          resumeId: "completed-live",
          lastTs: "2026-07-24T20:00:00.000Z",
        }),
        indexed({
          sessionId: "completed-newer",
          resumeId: "completed-newer",
          lastTs: "2026-07-24T21:00:00.000Z",
        }),
        indexed({
          sessionId: "active-newest",
          resumeId: "active-newest",
          lastTs: "2026-07-24T22:00:00.000Z",
        }),
      ],
      lifecycles: new Map([
        ["completed-live", "completed"],
        ["completed-newer", "completed"],
      ]),
      scope: "completed",
    }));

    expect(sessionRows(snapshot.rows).map((row) => row.sessionId)).toEqual([
      "completed-newer",
      "completed-live",
    ]);
    expect(sessionRows(snapshot.rows).every((row) => row.lifecycle === "completed")).toBeTrue();
    expect(snapshot.rows[1]).toMatchObject({
      workspaceRef: "workspace:44",
      statusAvailability: "published",
    });
  });

  test("completed scope keeps a live row even without an index join or remaining history capacity", () => {
    const newerClosed = indexed({
      sessionId: "completed-closed",
      resumeId: "completed-closed",
      lastTs: "2026-07-24T23:00:00.000Z",
    });
    const snapshot = projectSidebar(input({
      live: [live({
        sessionId: "completed-live",
        workspaceRef: "workspace:45",
        updatedAt: 1_700_000_000,
      })],
      indexed: [newerClosed],
      lifecycles: new Map([
        ["completed-live", "completed"],
        ["completed-closed", "completed"],
      ]),
      scope: "completed",
      historyLimit: 1,
    }));

    expect(sessionRows(snapshot.rows).map((row) => row.sessionId)).toEqual(["completed-live"]);
    expect(snapshot.rows[0]).toMatchObject({
      lifecycle: "completed",
      workspaceRef: "workspace:45",
    });
  });

  test("archived scope lists only archived rows and respects the history cap", () => {
    const snapshot = projectSidebar(input({
      indexed: [
        indexed({
          sessionId: "archived-newer",
          resumeId: "archived-newer",
          lastTs: "2026-07-24T21:00:00.000Z",
        }),
        indexed({
          sessionId: "completed",
          resumeId: "completed",
          lastTs: "2026-07-24T22:00:00.000Z",
        }),
        indexed({
          sessionId: "archived-older",
          resumeId: "archived-older",
          lastTs: "2026-07-24T20:00:00.000Z",
        }),
      ],
      lifecycles: new Map([
        ["archived-newer", "archived"],
        ["completed", "completed"],
        ["archived-older", "archived"],
      ]),
      scope: "archived",
      historyLimit: 1,
    }));

    expect(sessionRows(snapshot.rows).map((row) => row.sessionId)).toEqual(["archived-newer"]);
    expect(sessionRows(snapshot.rows)[0]?.lifecycle).toBe("archived");
  });

  test("does not represent lifecycle history as closed when liveness is unreadable", () => {
    const snapshot = projectSidebar(input({
      indexed: [indexed({ sessionId: "completed", resumeId: "completed" })],
      lifecycles: new Map([["completed", "completed"]]),
      scope: "completed",
      livenessReadable: false,
    }));

    expect(snapshot.rows).toEqual([]);
    expect(snapshot.livenessReadable).toBeFalse();
  });

  test("does not shelve a live session addressed by its resume id", () => {
    const snapshot = projectSidebar(input({
      live: [live({ sessionId: "resume-id" })],
      indexed: [indexed({ sessionId: "file-id", resumeId: "resume-id", title: "Same session" })],
    }));

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]?.section).toBe("working");
  });

  test("does not shelve a live non-primary surface that has no visible live row", () => {
    const snapshot = projectSidebar(input({
      live: [live({ sessionId: "primary" })],
      liveSessionIds: new Set(["primary", "secondary-resume-id"]),
      indexed: [
        indexed({ sessionId: "primary", resumeId: "primary" }),
        indexed({
          sessionId: "secondary-file-id",
          resumeId: "secondary-resume-id",
          title: "Secondary pane",
        }),
      ],
    }));

    expect(sessionRows(snapshot.rows).map((row) => row.sessionId)).toEqual(["primary"]);
  });

  test("marks a failed status read without claiming Ready or synthesizing a pill", () => {
    const snapshot = projectSidebar(input({
      live: [live({ status: null, statusAvailability: "unreadable" })],
    }));

    expect(snapshot.rows[0]).toMatchObject({
      section: "needs-you",
      status: null,
      statusAvailability: "unreadable",
    });
  });

  test("caps the resume shelf", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      indexed({ sessionId: `s-${i}`, resumeId: `s-${i}`, title: `Session ${i}` }));

    const snapshot = projectSidebar(input({ indexed: many, recentLimit: 3 }));

    expect(snapshot.rows).toHaveLength(3);
  });

  test("omits the resume shelf when liveness is unreadable", () => {
    const snapshot = projectSidebar(input({
      indexed: [indexed({ sessionId: "old-1", resumeId: "old-1" })],
      livenessReadable: false,
    }));

    expect(snapshot.rows).toHaveLength(0);
    expect(snapshot.livenessReadable).toBe(false);
  });

  test("uses cmux recency for live rows and indexed recency for shelved rows", () => {
    const snapshot = projectSidebar(input({
      live: [live({ updatedAt: 1_700_000_400 })],
      indexed: [
        indexed(),
        indexed({ sessionId: "old-1", resumeId: "old-1", lastTs: "2026-07-24T19:00:00.000Z" }),
      ],
    }));

    expect(snapshot.rows[0]?.lastActivityAt).toBe(1_700_000_400_000);
    expect(snapshot.rows[1]?.lastActivityAt).toBe(Date.parse("2026-07-24T19:00:00.000Z"));
  });

  test("shows a model even when no cost was recorded", () => {
    const snapshot = projectSidebar(input({
      live: [live()],
      indexed: [indexed({ models: ["claude-opus-5"], costByModel: {} })],
    }));

    expect(sessionRows(snapshot.rows)[0]?.model).toMatchObject({ label: "Opus" });
  });

  test("picks the dominant model by spend when several were used", () => {
    const snapshot = projectSidebar(input({
      live: [live()],
      indexed: [indexed({
        models: ["claude-haiku-4-5", "claude-opus-5"],
        costByModel: { "claude-haiku-4-5": 0.2, "claude-opus-5": 4.1 },
      })],
    }));

    expect(sessionRows(snapshot.rows)[0]?.model).toMatchObject({ label: "Opus" });
  });

  test("leaves the model absent when the session is not indexed", () => {
    const snapshot = projectSidebar(input({ live: [live()] }));

    expect(sessionRows(snapshot.rows)[0]?.model).toBeNull();
  });

  test("keeps the mixed projection byte-equivalent to the pre-staging golden", () => {
    const serialized = JSON.stringify([
      projectSidebar(mixedProjectionInput()),
      projectSidebar(mixedProjectionInput({ triageOnly: true })),
      projectSidebar(mixedProjectionInput({ scope: "completed" })),
      projectSidebar(mixedProjectionInput({ livenessReadable: false })),
      projectSidebar(mixedProjectionInput({ scope: "completed", livenessReadable: false })),
    ]);

    expect(createHash("sha256").update(serialized).digest("hex")).toBe("5e895d3a155745ea6a474ddf6e0613ca2709ad772d821a7510d485fbf675e2fe");
  });
});

describe("directoriesToResolve", () => {
  test("collects live and recent directories without duplicates", () => {
    const directories = directoriesToResolve(
      [live({ cwd: "/a" }), live({ sessionId: "two", cwd: "/a" })],
      [indexed({ cwd: "/b" }), indexed({ sessionId: "x", cwd: null })],
    );

    expect(directories).toEqual(["/a", "/b"]);
  });
});

describe("declined verdicts", () => {
  /** The one enrichment field shape these tests care about; the rest is inert. */
  function enrichment(overrides: Record<string, unknown> = {}): never {
    return {
      title: null,
      state: "where it stands",
      history: null,
      next: null,
      remaining: null,
      recommendation: "archive",
      reason: "a dead end",
      junk: false,
      cwdCorrect: null,
      suggestedLocation: null,
      suggestedCwd: null,
      atMessages: null,
      at: null,
      legacyShape: false,
      declined: null,
      ...overrides,
    } as never;
  }

  test("serialized sidebar summaries keep the established wire shape", () => {
    const snapshot = projectSidebar(input({
      indexed: [indexed({ sessionId: "s1", resumeId: "s1" })],
      summaries: new Map([["s1", enrichment({
        title: "internal title",
        cwdCorrect: false,
        suggestedLocation: "repo",
        suggestedCwd: "/repo",
        legacyShape: true,
      })]]),
    }));
    const body = JSON.parse(JSON.stringify(snapshot)) as {
      rows: Array<{ summary?: Record<string, unknown> | null }>;
    };
    const summary = body.rows.find((row) => row.summary)?.summary;
    expect(summary).not.toBeNull();
    expect(Object.keys(summary ?? {}).sort()).toEqual([
      "at", "atMessages", "declined", "driftLabel", "history", "junk", "messagesSince",
      "next", "reason", "recommendation", "remaining", "state",
    ]);
    for (const internal of [
      "title", "cwdCorrect", "suggestedLocation", "suggestedCwd", "legacyShape",
    ]) {
      expect(summary).not.toHaveProperty(internal);
    }
  });

  test("a verdict that has not been declined is offered", () => {
    const snapshot = projectSidebar(input({
      indexed: [indexed({ sessionId: "s1", resumeId: "s1" })],
      summaries: new Map([["s1", enrichment()]]),
    }));
    const row = snapshot.rows.find((r) => r.id === "s1");
    expect(row?.kind === "session" && row.suggestion?.verb).toBe("archive");
  });

  test("declining a verdict withdraws that verdict", () => {
    const snapshot = projectSidebar(input({
      indexed: [indexed({ sessionId: "s1", resumeId: "s1" })],
      summaries: new Map([["s1", enrichment({ declined: "archive" })]]),
    }));
    const row = snapshot.rows.find((r) => r.id === "s1");
    expect(row?.kind === "session" && row.suggestion).toBeNull();
  });

  // The reason the column stores a verb rather than a flag: enrichment reaching a different
  // conclusion later is new information, and a boolean would have buried it.
  test("declining one verdict does not suppress a different one", () => {
    const snapshot = projectSidebar(input({
      indexed: [indexed({ sessionId: "s1", resumeId: "s1" })],
      summaries: new Map([["s1", enrichment({ recommendation: "complete", declined: "archive" })]]),
    }));
    const row = snapshot.rows.find((r) => r.id === "s1");
    expect(row?.kind === "session" && row.suggestion?.verb).toBe("complete");
  });

  test("parked and either terminal catalogue lifecycle suppress every recommendation", () => {
    for (const lifecycle of ["parked", "completed", "archived"] as const) {
      const browserLifecycle = lifecycle === "parked" ? "active" : lifecycle;
      const snapshot = projectSidebar(input({
        indexed: [indexed({ sessionId: "s1", resumeId: "s1" })],
        lifecycles: new Map([["s1", browserLifecycle]]),
        catalogueLifecycles: new Map([["s1", lifecycle]]),
        summaries: new Map([["s1", enrichment({ recommendation: "archive" })]]),
        scope: browserLifecycle,
      }));
      const row = snapshot.rows.find((candidate) => candidate.id === "s1");
      expect(row?.kind === "session" && row.suggestion).toBeNull();
    }
  });

  test("handoff stays visible but non-actionable", () => {
    const snapshot = projectSidebar(input({
      indexed: [indexed({ sessionId: "s1", resumeId: "s1" })],
      summaries: new Map([["s1", enrichment({ recommendation: "handoff" })]]),
    }));
    const row = snapshot.rows.find((candidate) => candidate.id === "s1");
    expect(row?.kind === "session" && row.suggestion).toMatchObject({
      verb: "handoff",
      actionable: false,
    });
  });

  test("junk and reason remain presentation metadata on an archive disagreement", () => {
    const snapshot = projectSidebar(input({
      indexed: [indexed({ sessionId: "s1", resumeId: "s1" })],
      summaries: new Map([["s1", enrichment({ junk: true, reason: "Probe" })]]),
    }));
    const row = snapshot.rows.find((candidate) => candidate.id === "s1");
    expect(row?.kind === "session" && row.suggestion).toMatchObject({
      verb: "archive",
      actionable: true,
      junk: true,
      reason: "Probe",
    });
  });
});
