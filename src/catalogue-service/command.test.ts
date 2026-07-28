import { expect, test } from "bun:test";
import { catalogueRefreshCommandOptions } from "./command.ts";

test("refresh --if-stale maps to a non-forced authority refresh", () => {
  expect(catalogueRefreshCommandOptions(["refresh", "--if-stale"])).toEqual({
    force: false,
    titles: false,
  });
  expect(catalogueRefreshCommandOptions(["refresh", "--if-stale", "--titles"])).toEqual({
    force: false,
    titles: true,
  });
  expect(catalogueRefreshCommandOptions(["refresh"])).toEqual({
    force: true,
    titles: false,
  });
});
