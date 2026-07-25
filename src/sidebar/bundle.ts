/**
 * Building the browser bundle.
 *
 * The sidebar is small enough to compile at startup and serve from memory, which keeps the
 * repository free of build artifacts and guarantees the page always matches the source on disk.
 * Failure is reported rather than silently serving a stale or empty page.
 */
import { join } from "node:path";
import { err, ok, type Result } from "../result.ts";

export interface BundledAsset {
  readonly body: string;
  readonly type: string;
}

const WEB_DIR = join(import.meta.dir, "web");
const REPOSITORY_DIR = join(import.meta.dir, "..", "..");
const SCRIPT_ENTRY = join(WEB_DIR, "main.tsx");
const STYLE_ENTRY = join(WEB_DIR, "app.css");
const WEB_TSCONFIG = join(WEB_DIR, "tsconfig.json");
const TAILWIND_CLI = join(REPOSITORY_DIR, "node_modules", ".bin", "tailwindcss");

/**
 * tweakcn's live preview is an external script, which the page otherwise never has. It is opt-in
 * through `CCS_SIDEBAR_TWEAKCN=1` so the shipped Dock page stays self-contained and makes no
 * network request unless someone is deliberately theming.
 */
function tweakcnTag(): string {
  return process.env.CCS_SIDEBAR_TWEAKCN === "1"
    ? '\n    <script src="https://tweakcn.com/live-preview.min.js"></script>'
    : "";
}

/** The page shell links only assets held by the loopback server. */
function page(script: string, stylesheet: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CCS sessions</title>
    <link rel="stylesheet" href="${stylesheet}" />${tweakcnTag()}
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${script}"></script>
  </body>
</html>
`;
}

/** Compile Tailwind to stdout so startup creates no generated files. */
async function buildStylesheet(): Promise<Result<string>> {
  try {
    // The official pinned CLI is more stable here than a Bun plugin: it is Tailwind's supported
    // v4 compiler, needs no plugin API compatibility, and an absolute path prevents bunx/network
    // resolution when `ccs sidebar serve` starts from an arbitrary working directory.
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        TAILWIND_CLI,
        "--input",
        STYLE_ENTRY,
        "--output",
        "-",
        "--minify",
        "--silent",
        "--cwd",
        WEB_DIR,
      ],
      cwd: WEB_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, body, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    if (exitCode !== 0) {
      return err(new Error(`sidebar stylesheet failed: ${stderr.trim() || `exit ${exitCode}`}`));
    }
    if (body.trim().length === 0) {
      return err(new Error("sidebar stylesheet produced no output"));
    }
    return ok(body);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(new Error(`sidebar stylesheet failed to start: ${message}`));
  }
}

/** Bundle the sidebar app for the browser and return the assets the server should serve. */
export async function buildSidebarAssets(): Promise<Result<Map<string, BundledAsset>>> {
  try {
    const [result, stylesheet] = await Promise.all([
      Bun.build({
        entrypoints: [SCRIPT_ENTRY],
        target: "browser",
        format: "esm",
        minify: true,
        define: { "process.env.NODE_ENV": '"production"' },
        tsconfig: WEB_TSCONFIG,
        // LobeHub's package ships raw SVG files. Text loading embeds the exact markup in main.js
        // instead of emitting URLs the in-memory server would not know how to resolve.
        loader: { ".svg": "text" },
      }),
      buildStylesheet(),
    ]);

    if (!result.success) {
      const messages = result.logs.map((entry) => entry.message).join("; ");
      return err(new Error(`sidebar bundle failed: ${messages || "unknown error"}`));
    }
    if (!stylesheet.ok) return stylesheet;

    const script = result.outputs[0];
    if (!script) return err(new Error("sidebar bundle produced no output"));

    const assets = new Map<string, BundledAsset>();
    assets.set("/main.js", { body: await script.text(), type: "text/javascript; charset=utf-8" });
    assets.set("/app.css", { body: stylesheet.value, type: "text/css; charset=utf-8" });
    assets.set("/index.html", {
      body: page("/main.js", "/app.css"),
      type: "text/html; charset=utf-8",
    });
    return ok(assets);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(new Error(`sidebar bundle failed to start: ${message}`));
  }
}
