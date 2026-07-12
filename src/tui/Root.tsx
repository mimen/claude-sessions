import React, { useMemo, useState } from "react";
import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import type { Titler } from "../titler/codex.ts";
import type { ResumeCommand } from "../resume/command.ts";
import { buildEngine, resolveEngine, type EngineName, type InferenceEngine } from "../inference/engine.ts";
import { createTitler } from "../titler/codex.ts";
import { App } from "./App.tsx";
import { SkillsPanel } from "./skills/SkillsPanel.tsx";
import { loadPrefs, savePrefs } from "./prefs.ts";

export type TuiMode = "sessions" | "skills";

interface RootProps {
  db: Database;
  catalogue?: Database;
  skillsDb: Database;
  config: Config;
  resumeRequest: { current: ResumeCommand | null };
  initialMode?: TuiMode;
}

/**
 * The active inference engine (Codex or Claude) that backs titling + the catalogue command,
 * plus everything the UI needs to render and cycle it. Owned by Root so a toggle rebuilds
 * the titler and the metadata engine together and both panels see the same choice.
 */
export interface EngineState {
  titler: Titler;
  engine: InferenceEngine | null;
  active: EngineName | null;
  /** Installed engines, in preference order. A toggle is only meaningful when length > 1. */
  available: EngineName[];
  cycle: () => void;
}

/**
 * Mode switcher above the two panels. Only one panel is mounted at a time, so each panel's
 * useInput is the sole key handler. Tab toggles; a skills cross-jump lands in sessions
 * pre-pinned to the sessions that used the chosen skill.
 */
export function Root({ db, catalogue, skillsDb, config, resumeRequest, initialMode }: RootProps): React.ReactElement {
  const [mode, setMode] = useState<TuiMode>(initialMode ?? "sessions");
  const [pinned, setPinned] = useState<{ paths: ReadonlySet<string>; label: string } | null>(null);

  // Persisted TUI toggle overrides config; resolveEngine still falls back if it isn't installed.
  const saved = loadPrefs().engine;
  const savedEngine: EngineName | null = saved === "codex" || saved === "claude" ? saved : null;
  const initial = useMemo(() => resolveEngine(config, savedEngine), [config, savedEngine]);
  const [active, setActive] = useState<EngineName | null>(initial.name);

  const engineState: EngineState = useMemo(() => {
    const engine = active ? buildEngine(active, config) : null;
    return {
      engine,
      titler: engine ? createTitler(engine) : { available: () => false, async generate() { return null; } },
      active,
      available: initial.available,
      cycle: () => {
        if (initial.available.length < 2) return;
        setActive((cur) => {
          const idx = cur ? initial.available.indexOf(cur) : -1;
          const next = initial.available[(idx + 1) % initial.available.length]!;
          savePrefs({ engine: next });
          return next;
        });
      },
    };
  }, [active, config, initial.available]);

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
      engineState={engineState}
      resumeRequest={resumeRequest}
      onSwitchMode={() => setMode("skills")}
      pinned={pinned}
      onClearPinned={() => {
        // The pin came from a skills cross-jump — esc is "go back", not just "unfilter".
        setPinned(null);
        setMode("skills");
      }}
    />
  );
}
