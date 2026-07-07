import React, { useState } from "react";
import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import type { Titler } from "../titler/codex.ts";
import type { ResumeCommand } from "../resume/command.ts";
import { App } from "./App.tsx";
import { SkillsPanel } from "./skills/SkillsPanel.tsx";

export type TuiMode = "sessions" | "skills";

interface RootProps {
  db: Database;
  catalogue?: Database;
  skillsDb: Database;
  config: Config;
  titler: Titler;
  resumeRequest: { current: ResumeCommand | null };
  initialMode?: TuiMode;
}

/**
 * Mode switcher above the two panels. Only one panel is mounted at a time, so each panel's
 * useInput is the sole key handler. Tab toggles; a skills cross-jump lands in sessions
 * pre-pinned to the sessions that used the chosen skill.
 */
export function Root({ db, catalogue, skillsDb, config, titler, resumeRequest, initialMode }: RootProps): React.ReactElement {
  const [mode, setMode] = useState<TuiMode>(initialMode ?? "sessions");
  const [pinned, setPinned] = useState<{ paths: ReadonlySet<string>; label: string } | null>(null);

  if (mode === "skills") {
    return (
      <SkillsPanel
        skillsDb={skillsDb}
        indexDb={db}
        config={config}
        onSwitchMode={() => setMode("sessions")}
        onShowSessions={(sessionPaths, label) => {
          setPinned({ paths: new Set(sessionPaths), label });
          setMode("sessions");
        }}
      />
    );
  }
  return (
    <App
      db={db}
      catalogue={catalogue}
      config={config}
      titler={titler}
      resumeRequest={resumeRequest}
      onSwitchMode={() => setMode("skills")}
      pinned={pinned}
      onClearPinned={() => setPinned(null)}
    />
  );
}
