/// <reference types="bun" />
/**
 * `ContextMenuLabel` is Base UI's `GroupLabel`, and it throws at render time when no
 * `Menu.Group` is above it. That crash reached a release once: the menu lives behind a portal,
 * every other component test renders to a static string, and `renderToStaticMarkup` emits
 * nothing at all for portal children — so an open menu is invisible to the suite and a broken
 * one looks identical to a working one.
 *
 * These two tests close that gap from the only direction the current harness allows. The first
 * pins the primitive's contract by rendering the label outside a portal, where SSR does execute
 * it. The second reads the sources, because the contract test cannot see how the rows nest
 * their own markup, and reintroducing a bare label there is the mistake that actually shipped.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextMenuGroup, ContextMenuLabel } from "./ui/context-menu.tsx";

describe("context menu labels", () => {
  test("a label outside a group throws", () => {
    expect(() => renderToStaticMarkup(<ContextMenuLabel>Lifecycle</ContextMenuLabel>)).toThrow(
      /MenuGroupContext is missing/,
    );
  });

  test("a label inside a group renders", () => {
    const markup = renderToStaticMarkup(
      <ContextMenuGroup>
        <ContextMenuLabel>Lifecycle</ContextMenuLabel>
      </ContextMenuGroup>,
    );
    expect(markup).toContain("Lifecycle");
  });

  test("every rendered label in this directory sits inside a group", () => {
    const dir = import.meta.dir;
    const offenders: string[] = [];

    // Tests are excluded: the contract test above renders a bare label on purpose.
    const components = readdirSync(dir).filter(
      (name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"),
    );

    for (const file of components) {
      const source = readFileSync(join(dir, file), "utf8");
      // Walk the tags in source order and track group depth. Import statements never match,
      // since these patterns all carry the opening angle bracket.
      const tags = [...source.matchAll(/<(\/?)ContextMenu(Group|Label)\b/g)];
      let depth = 0;

      for (const tag of tags) {
        const closing = tag[1] === "/";
        const part = tag[2];

        if (part === "Group") {
          depth += closing ? -1 : 1;
          continue;
        }
        if (!closing && depth === 0) {
          const line = source.slice(0, tag.index).split("\n").length;
          offenders.push(`${file}:${line}`);
        }
      }

      expect(depth, `unbalanced ContextMenuGroup tags in ${file}`).toBe(0);
    }

    expect(offenders).toEqual([]);
  });
});
