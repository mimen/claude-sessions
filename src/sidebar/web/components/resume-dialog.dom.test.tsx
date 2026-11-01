/// <reference types="bun" />
import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ResumeDialog } from "./resume-dialog.tsx";

// Runs under `bun run test:dom`; the main suite has no DOM and skips it.
const mounted = typeof document === "undefined" ? test.skip : test;

mounted("the dialog takes focus on open and returns it to the opener on close", async () => {
  const opener = document.createElement("input");
  const host = document.createElement("div");
  document.body.append(opener, host);
  opener.focus();
  const root = createRoot(host);

  await act(async () => {
    root.render(<ResumeDialog name="A done session" onCancel={() => {}} onConfirm={() => {}} phase="completed" />);
  });
  expect(document.activeElement?.textContent).toBe("Resume");

  await act(async () => root.unmount());
  expect(document.activeElement).toBe(opener);
  opener.remove();
  host.remove();
});
