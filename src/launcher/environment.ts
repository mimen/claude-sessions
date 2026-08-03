/**
 * Launcher environment — the ONE compile step between `[[launcher]].env`/`clears` in config.toml
 * and every consumer that has to apply a launcher's environment.
 *
 * THERE ARE TWO CONSUMERS AND EXACTLY ONE RULE. The `~/.ccs/bin/claude` shim applies a launcher's
 * environment to an interactive launch; the ccs spawn paths (resume, birth, respawn) apply it to a
 * process they start themselves. Both derive from the SAME compiled directive list produced here —
 * the shim by rendering it to a spec file, the spawn paths by resolving it into assignments and
 * unsets. Letting either side re-derive the rule from `Launcher` directly is how `clears` came to
 * be honored on one path and silently dropped on the other.
 *
 * WHY A COMPILE STEP AT ALL. The shim is plain bash on the hottest path on this machine: every
 * interactive `claude`, every resume, every managed birth passes through it. It cannot parse
 * TOML, and it must not shell out to `ccs` merely to learn its environment — that would put a
 * Bun start-up (and a total dependency on ccs being healthy) in front of paths that today have
 * neither, including `claude --version` and `claude --resume`. So `ccs launcher install`
 * MATERIALIZES each launcher's environment as a tiny directive file the shim reads with no
 * parser, no eval, and no subprocess.
 *
 * WHY DIRECTIVES INSTEAD OF A SOURCEABLE SCRIPT. A generated `.sh` that the shim `source`s
 * would be arbitrary code execution seeded by config. The directive format below is read
 * line-by-line and dispatched over a fixed three-verb vocabulary, so a malformed or hostile
 * spec can set a variable this file already validated and nothing else.
 *
 * The file format (one directive per line, `#` comments and blank lines ignored):
 *
 *   set     KEY=literal value
 *   setfile KEY=/absolute/path/to/a/secret
 *   clear   KEY
 */
import { readFileSync } from "node:fs";
import { type Result, err, ok } from "../result.ts";
import { expandHome } from "../paths.ts";

/** POSIX-portable environment variable names only; matches the cmux transport's own gate. */
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Marks a value as the CONTENTS OF A FILE rather than the value itself. The secret is then
 * named in config and read by the shim at exec time — it is never written into config.toml, never
 * copied into the materialized spec, and never sits at rest in a second place that has to be
 * rotated in step with the first. `~` is expanded at compile time so the shim resolves nothing.
 */
const FILE_VALUE_PREFIX = "@file:";

/** Escape hatch for a literal value that genuinely begins with `@file:`. */
const LITERAL_VALUE_PREFIX = "@literal:";

/** One resolved environment assignment, before it is rendered into the spec file. */
export type LauncherEnvValue =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "file"; readonly path: string };

/**
 * ONE directive — the atom every consumer shares.
 *
 * The shim reads these back from a spec file; the ccs spawn paths get them straight from
 * `compileLauncherEnvDirectives`. Both therefore obey the same ordering and the same three-verb
 * vocabulary, which is the point: an `unset` cannot be expressed as an assignment, so a consumer
 * that only ever saw a `Record<string, string>` was structurally incapable of honoring `clears`.
 */
export type LauncherEnvDirective =
  | { readonly verb: "clear"; readonly key: string }
  | { readonly verb: "set"; readonly key: string; readonly value: string }
  | { readonly verb: "setfile"; readonly key: string; readonly path: string };

/**
 * Classify one configured `env` value. Deliberately total and non-throwing: the only failure a
 * caller can hit is an empty file path, which would otherwise render an unreadable directive.
 */
export function parseLauncherEnvValue(value: string): Result<LauncherEnvValue> {
  if (value.startsWith(LITERAL_VALUE_PREFIX)) {
    return ok({ kind: "literal", value: value.slice(LITERAL_VALUE_PREFIX.length) });
  }
  if (value.startsWith(FILE_VALUE_PREFIX)) {
    const raw = value.slice(FILE_VALUE_PREFIX.length).trim();
    if (raw.length === 0) return err(new Error(`"${FILE_VALUE_PREFIX}" needs a file path`));
    return ok({ kind: "file", path: expandHome(raw) });
  }
  return ok({ kind: "literal", value });
}

/** The launcher facts this module compiles. Structurally a subset of `Launcher`. */
export interface LauncherEnvSpecInput {
  readonly name: string;
  readonly env: Readonly<Record<string, string>>;
  readonly clears: readonly string[];
}

function validateKey(name: string, key: string): Result<void> {
  if (!ENVIRONMENT_KEY_PATTERN.test(key)) {
    return err(new Error(`launcher "${name}" has an invalid environment key: ${JSON.stringify(key)}`));
  }
  return ok(undefined);
}

/**
 * A directive is one line, so a value carrying a newline (or a NUL) would silently become a
 * second directive. Reject it at compile time rather than let the shim misread it.
 */
function validateSingleLine(name: string, key: string, value: string): Result<void> {
  if (/[\n\r\0]/.test(value)) {
    return err(new Error(`launcher "${name}" environment value for "${key}" must be a single line`));
  }
  return ok(undefined);
}

/**
 * Compile one launcher into the ordered directive list EVERY consumer applies.
 *
 * `clears` is emitted BEFORE `set`/`setfile` so a launcher may legitimately clear a broad family
 * of inherited variables and then re-assert one of them; consumers apply directives in list
 * order, making that ordering the contract rather than an accident.
 *
 * This is the single rule. `compileLauncherEnvSpec` renders these to the shim's spec file and
 * `resolveLauncherEnvDirectives` turns them into a spawn-time environment mutation; neither
 * re-reads `env`/`clears` itself.
 */
export function compileLauncherEnvDirectives(
  input: LauncherEnvSpecInput,
): Result<readonly LauncherEnvDirective[]> {
  const directives: LauncherEnvDirective[] = [];

  for (const key of input.clears) {
    const valid = validateKey(input.name, key);
    if (!valid.ok) return valid;
    directives.push({ verb: "clear", key });
  }

  for (const [key, rawValue] of Object.entries(input.env)) {
    const valid = validateKey(input.name, key);
    if (!valid.ok) return valid;
    const parsed = parseLauncherEnvValue(rawValue);
    if (!parsed.ok) {
      return err(new Error(`launcher "${input.name}" environment value for "${key}": ${parsed.error.message}`));
    }
    const value = parsed.value.kind === "file" ? parsed.value.path : parsed.value.value;
    const singleLine = validateSingleLine(input.name, key, value);
    if (!singleLine.ok) return singleLine;
    directives.push(
      parsed.value.kind === "file"
        ? { verb: "setfile", key, path: parsed.value.path }
        : { verb: "set", key, value },
    );
  }

  return ok(directives);
}

/** Render one directive in the shim's line format. */
function renderDirective(directive: LauncherEnvDirective): string {
  switch (directive.verb) {
    case "clear":
      return `clear ${directive.key}`;
    case "set":
      return `set ${directive.key}=${directive.value}`;
    case "setfile":
      return `setfile ${directive.key}=${directive.path}`;
  }
}

/** Compile one launcher into its spec-file contents, from the shared directive list. */
export function compileLauncherEnvSpec(input: LauncherEnvSpecInput): Result<string> {
  const directives = compileLauncherEnvDirectives(input);
  if (!directives.ok) return directives;
  const lines: string[] = [
    "# Generated by `ccs launcher install`. Edit [[launcher]].env in ~/.ccs/config.toml instead.",
    `# launcher: ${input.name}`,
    ...directives.value.map(renderDirective),
  ];
  return ok(`${lines.join("\n")}\n`);
}

/**
 * A launcher's environment as a spawn path can apply it: values to assign, and names to UNSET.
 *
 * The two halves are separate on purpose. A spawn path builds an explicit environment map, and
 * "remove this variable" has no representation in a map of assignments — which is precisely how
 * `clears` was honored by the shim and silently dropped by `--via`. `unset` names the variables a
 * caller must DELETE from whatever it inherited before applying `assign`.
 */
export interface ResolvedLauncherEnv {
  readonly assign: Readonly<Record<string, string>>;
  readonly unset: readonly string[];
}

/** Reads the first line of a secret file; the trailing newline is normal and stripped. */
function readSecretFile(path: string): Result<string> {
  try {
    const contents = readFileSync(path, "utf8");
    const end = contents.search(/[\n\r]/);
    return ok(end === -1 ? contents : contents.slice(0, end));
  } catch (error) {
    return err(new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`));
  }
}

/**
 * Fold a directive list into assignments + unsets, reading any `setfile` secret from disk.
 *
 * Order is preserved exactly as the shim applies it: a later directive wins over an earlier one,
 * so a launcher that clears a family and then re-asserts one member gets the same result here as
 * it does in bash. A `set` after a `clear` of the same key removes it from `unset`, and vice
 * versa, because a spawn path applies both halves at once rather than sequentially.
 */
export function resolveLauncherEnvDirectives(
  directives: readonly LauncherEnvDirective[],
  readSecret: (path: string) => Result<string> = readSecretFile,
): Result<ResolvedLauncherEnv> {
  const assign: Record<string, string> = {};
  const unset = new Set<string>();

  for (const directive of directives) {
    switch (directive.verb) {
      case "clear":
        delete assign[directive.key];
        unset.add(directive.key);
        break;
      case "set":
        unset.delete(directive.key);
        assign[directive.key] = directive.value;
        break;
      case "setfile": {
        const secret = readSecret(directive.path);
        // FAIL LOUD (ADR-0066): an unreadable token file must not silently become an
        // unauthenticated launch against the gateway, which fails later and less legibly.
        if (!secret.ok) {
          return err(new Error(`launcher environment value for "${directive.key}": ${secret.error.message}`));
        }
        unset.delete(directive.key);
        assign[directive.key] = secret.value;
        break;
      }
    }
  }

  return ok({ assign, unset: [...unset] });
}

/** Compile + resolve one launcher in a single step — what every spawn path actually wants. */
export function resolveLauncherEnv(
  input: LauncherEnvSpecInput,
  readSecret?: (path: string) => Result<string>,
): Result<ResolvedLauncherEnv> {
  const directives = compileLauncherEnvDirectives(input);
  if (!directives.ok) return directives;
  return resolveLauncherEnvDirectives(directives.value, readSecret);
}

/** Spec filename for a launcher. Names are constrained so this can never escape its directory. */
export function launcherEnvSpecFilename(name: string): Result<string> {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    return err(new Error(`launcher name is not usable as a filename: ${JSON.stringify(name)}`));
  }
  return ok(`${name}.env`);
}
