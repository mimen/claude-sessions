import type { StartCandidates, StartProjectCandidate, StartSessionCandidate } from "./candidates.ts";
import type { StartRouteDecision } from "./gateway.ts";

export type StartChoice =
  | { readonly kind: "resume"; readonly session: StartSessionCandidate }
  | { readonly kind: "new"; readonly project: StartProjectCandidate }
  | { readonly kind: "directory" };

/** Build a compact picker with the model recommendation first and only verified alternatives. */
export function buildStartChoices(
  decision: StartRouteDecision,
  candidates: StartCandidates,
): StartChoice[] {
  const sessions = new Map([
    ...candidates.autoResumeSessions.map((session) => [session.id, session] as const),
    ...candidates.manualOnlySessions.map((session) => [session.id, session] as const),
  ]);
  const projects = new Map(candidates.projects.map((project) => [project.id, project] as const));
  const choices: StartChoice[] = [];
  const seen = new Set<string>();

  const append = (choice: StartChoice | null): void => {
    if (!choice) return;
    const key = choiceKey(choice);
    if (seen.has(key)) return;
    seen.add(key);
    choices.push(choice);
  };

  append(choiceForDecision(decision, sessions, projects));
  for (const id of decision.alternativeSessionIds) {
    const session = sessions.get(id);
    append(session ? { kind: "resume", session } : null);
  }
  for (const session of candidates.autoResumeSessions.slice(0, 3)) append({ kind: "resume", session });
  for (const session of candidates.manualOnlySessions.slice(0, 2)) append({ kind: "resume", session });
  for (const project of candidates.projects.slice(0, 3)) append({ kind: "new", project });
  const directory: StartChoice = { kind: "directory" };
  const nonDirectory = choices.filter((choice) => choice.kind !== "directory");
  return choices[0]?.kind === "directory"
    ? [directory, ...nonDirectory.slice(0, 8)]
    : [...nonDirectory.slice(0, 8), directory];
}

export function choiceLabel(choice: StartChoice): string {
  switch (choice.kind) {
    case "resume":
      return `Resume: ${choice.session.title} [${choice.session.lifecycle}]`;
    case "new":
      return `New session: ${choice.project.name}`;
    case "directory":
      return "New session in another directory";
  }
}

export function choiceDetail(choice: StartChoice): string {
  switch (choice.kind) {
    case "resume":
      return `${choice.session.projectName} · ${choice.session.cwd}`;
    case "new":
      return choice.project.path;
    case "directory":
      return "Enter an existing directory manually";
  }
}

function choiceForDecision(
  decision: StartRouteDecision,
  sessions: ReadonlyMap<string, StartSessionCandidate>,
  projects: ReadonlyMap<string, StartProjectCandidate>,
): StartChoice | null {
  switch (decision.action) {
    case "resume": {
      const session = sessions.get(decision.sessionId);
      return session ? { kind: "resume", session } : null;
    }
    case "new": {
      const project = projects.get(decision.projectId);
      return project ? { kind: "new", project } : null;
    }
    case "ask_directory":
      return { kind: "directory" };
  }
}

function choiceKey(choice: StartChoice): string {
  switch (choice.kind) {
    case "resume": return `resume:${choice.session.id}`;
    case "new": return `new:${choice.project.path}`;
    case "directory": return "directory";
  }
}
