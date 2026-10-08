import { expect, test } from "bun:test";
import { buildSidebarAssets } from "./bundle.ts";

// A runtime import from server code once dragged the logger into main.js, whose top-level
// `process.env` read threw in the browser and left the page blank.
test("the browser bundle reads no Node process state", async () => {
  const built = await buildSidebarAssets();
  if (!built.ok) throw built.error;
  const script = built.value.get("/main.js")?.body ?? "";

  expect(script.length).toBeGreaterThan(0);
  expect(script).not.toMatch(/\bprocess\.(env|cwd)\b/);
}, 30_000);
