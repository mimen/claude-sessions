/**
 * The confirmation in front of the only irreversible action the sidebar can take.
 *
 * It exists to make the reader look at what dies before they can agree to it, so it does not open
 * with a confirm button: the preflight runs first, and the destructive control only appears once
 * there are real figures beside it. That is the browser's counterpart to the CLI making you retype
 * the session id -- a second, informed act rather than a second click in the same place.
 *
 * What it deliberately does not do is carry the manifest back to the server. The server rebuilds
 * it, because a client-supplied list of paths to delete is a list of paths to delete arriving over
 * HTTP, and a session can go live in the seconds a dialog sits open.
 */
import { useEffect, useState } from "react";
import type React from "react";
import { Button } from "@/components/ui/button";
import {
  actionErrorMessage,
  postDestroyPreflight,
  postDestroySession,
  type ActionTransportError,
} from "../action-transport.ts";

interface Preflight {
  readonly status: string;
  readonly sessionCount?: number;
  readonly pathCount?: number;
  readonly liveCount?: number;
  readonly survivingIdentities?: readonly string[];
}

interface DestroyResult {
  readonly status: string;
  readonly sessionIds?: readonly string[];
  readonly filesRemoved?: number;
  readonly reason?: string;
}

type DialogState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly preflight: Preflight }
  | { readonly phase: "working" }
  | { readonly phase: "error"; readonly message: string };

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function DestroyDialog({ sessionId, name, onCancel, onDestroyed }: {
  readonly sessionId: string;
  readonly name: string;
  readonly onCancel: () => void;
  /** Called only after the server reports the rows and files actually went away. */
  readonly onDestroyed: (message: string) => void;
}): React.ReactElement {
  const [state, setState] = useState<DialogState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    const describe = (error: ActionTransportError): string => actionErrorMessage(error);
    void postDestroyPreflight<Preflight>(sessionId).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setState({ phase: "error", message: describe(result.error) });
        return;
      }
      setState({ phase: "ready", preflight: result.value });
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  // Escape cancels, matching every other dismissible surface. Enter deliberately does not confirm:
  // the whole point of this dialog is that agreeing to it takes a deliberate act.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const confirm = (): void => {
    setState({ phase: "working" });
    void postDestroySession<DestroyResult>(sessionId).then((result) => {
      if (!result.ok) {
        setState({ phase: "error", message: actionErrorMessage(result.error) });
        return;
      }
      const value = result.value;
      if (value.status === "destroyed") {
        onDestroyed(
          `Destroyed ${plural(value.sessionIds?.length ?? 1, "session", "sessions")}`
            + `, ${plural(value.filesRemoved ?? 0, "path", "paths")} removed.`,
        );
        return;
      }
      // The abort path is not an error to apologise for: it is the guarantee working. Say what it
      // means, because "nothing was deleted" is the part that matters.
      setState({
        phase: "error",
        message: value.status === "aborted"
          ? `${value.reason ?? "A live workspace would not close."} Nothing was deleted.`
          : value.status === "not-found"
          ? "That session no longer exists."
          : "The destroy failed. Nothing was deleted.",
      });
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}
      role="presentation"
    >
      <div
        aria-labelledby="destroy-dialog-title"
        aria-modal="true"
        className="w-full max-w-sm rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg"
        role="dialog"
      >
        <h2 className="text-sm font-medium" id="destroy-dialog-title">Destroy this session?</h2>
        <p className="mt-1 truncate text-[12px] text-muted-foreground" title={name}>{name}</p>

        {state.phase === "loading" ? (
          <p className="mt-3 text-[12px] text-muted-foreground">Working out what would be removed…</p>
        ) : null}

        {state.phase === "working" ? (
          <p className="mt-3 text-[12px] text-muted-foreground">Destroying…</p>
        ) : null}

        {state.phase === "error" ? (
          <p className="mt-3 text-[12px] text-destructive">{state.message}</p>
        ) : null}

        {state.phase === "ready" ? (
          <div className="mt-3 space-y-2 text-[12px] leading-[1.5]">
            <p>
              This erases {plural(state.preflight.sessionCount ?? 1, "session", "sessions")}
              {" "}and {plural(state.preflight.pathCount ?? 0, "path", "paths")} from this machine:
              the transcript, its subagent sidechains, task state, edit history, and logs.
            </p>
            {(state.preflight.sessionCount ?? 1) > 1 ? (
              <p className="text-muted-foreground">
                The extra {plural((state.preflight.sessionCount ?? 1) - 1, "session is", "sessions are")}
                {" "}descendants of this one.
              </p>
            ) : null}
            {(state.preflight.liveCount ?? 0) > 0 ? (
              <p className="text-muted-foreground">
                {plural(state.preflight.liveCount ?? 0, "workspace is", "workspaces are")} still
                running and will be closed first. If a close fails, nothing is deleted.
              </p>
            ) : null}
            {(state.preflight.survivingIdentities?.length ?? 0) > 0 ? (
              <p className="text-muted-foreground">
                The identity it belongs to survives — identities outlive their sessions.
              </p>
            ) : null}
            <p className="font-medium text-destructive">This cannot be undone.</p>
          </div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onCancel} size="sm" variant="outline">
            {state.phase === "error" ? "Close" : "Cancel"}
          </Button>
          {state.phase === "ready" ? (
            <Button onClick={confirm} size="sm" variant="destructive">Destroy</Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
