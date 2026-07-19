import { describe, expect, test } from "bun:test";
import { rewriteFrontmatterCategory } from "./category-write.ts";

describe("rewriteFrontmatterCategory", () => {
  const doc = "---\nname: x\ndescription: y\ncategory: dev\n---\n# Body\n";
  test("replaces an existing category", () => {
    expect(rewriteFrontmatterCategory(doc, "pocock")).toBe("---\nname: x\ndescription: y\ncategory: pocock\n---\n# Body\n");
  });
  test("removes on clear", () => {
    expect(rewriteFrontmatterCategory(doc, null)).toBe("---\nname: x\ndescription: y\n---\n# Body\n");
  });
  test("inserts when absent", () => {
    const noCat = "---\nname: x\n---\nBody\n";
    expect(rewriteFrontmatterCategory(noCat, "infra")).toBe("---\nname: x\ncategory: infra\n---\nBody\n");
  });
  test("clear when absent is a no-op", () => {
    const noCat = "---\nname: x\n---\nBody\n";
    expect(rewriteFrontmatterCategory(noCat, null)).toBe(noCat);
  });
  test("no frontmatter → null", () => {
    expect(rewriteFrontmatterCategory("# Just a doc", "dev")).toBeNull();
  });
});
