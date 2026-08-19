#!/usr/bin/env bun
/**
 * Teach CCS what each event-watch worker is working on, and when it happens.
 *
 * An event-watch worker's identity names its event (`event-watch:event-worker:<slug>`), but a slug
 * is not a name and carries no date, so the sidebar can only list events alphabetically. This fills
 * the grouping row behind each one — display name, link, start date — from the event folder's
 * `hub.json`, which the loop already reconciles from Airtable. Reading the reconciled file rather
 * than Airtable itself keeps this offline, credential-free, and agreeable to run on a timer.
 *
 * Idempotent: re-running rewrites the same rows. Safe to run whenever events are added or moved.
 *
 * This is an event-watch adapter living in the CCS repo because CCS is what consumes the data. The
 * cluster's own sensor is the right long-term home — grouping display metadata belongs to whoever
 * owns the cluster (ADR-0051/0070) — at which point this becomes the backfill it started as.
 *
 *   bun run scripts/sync-event-groupings.ts [--events-dir <path>] [--dry-run]
 */
import { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "../src/catalogue/db-schema.ts";
import { CATALOGUE_PATH, ensureDataDir } from "../src/paths.ts";
import { setIdentityFields } from "../src/catalogue/identities.ts";
import { upsertGrouping } from "../src/state/groupings-db.ts";

const CLUSTER = "event-watch";
const ROLE = "event-worker";
const DEFAULT_EVENTS_DIR = join(
  homedir(),
  "Documents/milad-vault/Workspaces/Events/events",
);

interface EventFacts {
  readonly slug: string;
  readonly name: string | null;
  readonly url: string | null;
  readonly startsAt: string | null;
}

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** What one event folder knows about itself. Absent facts stay absent rather than being guessed. */
function factsFor(eventsDir: string, slug: string): EventFacts | null {
  const hub = readJson(join(eventsDir, slug, "hub.json"));
  const meta = readJson(join(eventsDir, slug, "meta.json"));
  if (hub === null && meta === null) return null;
  const identity = (hub?.identity ?? {}) as Record<string, unknown>;
  const name = typeof identity.name === "string"
    ? identity.name
    : typeof meta?.name === "string"
    ? meta.name
    : null;
  const startsAt = typeof identity.startDate === "string" ? identity.startDate : null;
  const url = typeof meta?.airtableUrl === "string" ? meta.airtableUrl : null;
  return { slug, name, url, startsAt };
}

/** Beyond this a header stops being scannable, and the billing after the colon is what to drop. */
const SHORT_NAME_LIMIT = 28;

/**
 * A column-friendly name.
 *
 * Event names carry their billing — "AUF x SIS Present: Kiki Factory", "Umbrellavation By The Bay:
 * UV x Resonant Underground (FREE W/ RSVP)" — which is right on a flyer and useless as a header.
 * Parentheses are always trailing commentary and the presenter clause is always a prefix, so both
 * go. What remains is kept whole while it still reads as a header: "Daisychain: Zachfox" names the
 * night and its artist, and cutting at the colon would throw away the half people say out loud.
 * Only when the remainder is too long to scan does the leading segment stand in for it.
 */
function shortNameFor(name: string | null): string | null {
  if (!name) return null;
  const withoutParens = name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  const withoutPresenter = withoutParens.replace(/^.*?\bpresents?\b:?\s*/i, "").trim();
  const candidate = withoutPresenter || withoutParens;
  if (candidate.length <= SHORT_NAME_LIMIT) return candidate || null;
  const lead = candidate.split(/\s*[:—]\s*/)[0]?.trim();
  return (lead || candidate) || null;
}

function main(): void {
  const eventsDir = flag("events-dir") ?? DEFAULT_EVENTS_DIR;
  const dryRun = process.argv.includes("--dry-run");

  ensureDataDir();
  const db: Database = openCatalogue(CATALOGUE_PATH());
  try {
    // Only events some identity actually references: a folder nobody works is not a grouping, and
    // minting rows for archived events would pad the sidebar with bands holding nothing.
    const identities = db.query(
      `SELECT identity_key FROM identities WHERE cluster = $cluster AND role = $role`,
    ).all({ $cluster: CLUSTER, $role: ROLE }) as { identity_key: string }[];

    const slugs = identities
      .map((row) => row.identity_key.split(":").slice(2).join(":"))
      .filter((slug) => slug.length > 0);

    if (slugs.length === 0) {
      console.log("no slugged event-worker identities; nothing to sync");
      return;
    }

    let synced = 0;
    const missing: string[] = [];
    for (const slug of slugs) {
      let exists = false;
      try {
        exists = statSync(join(eventsDir, slug)).isDirectory();
      } catch {
        exists = false;
      }
      const facts = exists ? factsFor(eventsDir, slug) : null;
      if (!facts) {
        missing.push(slug);
        continue;
      }
      const short = shortNameFor(facts.name);
      console.log(
        `${dryRun ? "PLAN " : "SYNC "} ${slug.padEnd(24)} ${(facts.startsAt ?? "no date").padEnd(26)} ${short ?? ""}`,
      );
      if (dryRun) continue;
      upsertGrouping(
        db,
        slug,
        {
          cluster: CLUSTER,
          role: ROLE,
          label: facts.name,
          url: facts.url,
          shortName: short,
          // The date is a cluster fact about its own grouping, so it rides meta rather than
          // asking every cluster to grow a column it will never use.
          ...(facts.startsAt === null ? {} : { meta: { startsAt: facts.startsAt } }),
        },
        new Date().toISOString(),
      );
      // Through the sanctioned setter rather than raw SQL: the identity tables have one writer
      // by design, and the boundary test enforces it.
      setIdentityFields(
        db,
        `${CLUSTER}:${ROLE}:${slug}`,
        { grouping_id: slug },
        new Date().toISOString(),
      );
      synced += 1;
    }

    // Named rather than counted: a worker whose event folder has gone is the one case here that
    // needs a person, and a bare number would not say which.
    for (const slug of missing) console.log(`SKIP  ${slug} — no event folder under ${eventsDir}`);
    console.log(`${dryRun ? "would sync" : "synced"} ${dryRun ? slugs.length - missing.length : synced} of ${slugs.length}`);
  } finally {
    db.close();
  }
}

main();
