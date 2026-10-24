// T-5122: main.tsx boots the small public router for exactly the pages it draws.
import { describe, expect, it } from "vitest";
import { createPublicRouter, isPublicPath } from "../src/publicRouter";

describe("the public entry", () => {
  it("claims the pages anybody may open and nothing a person signs in for", () => {
    for (const path of ["/catalogue", "/catalogue/", "/catalogue/bb-pocasie", "/glossary", "/accessibility", "/v/abc", "/f/abc", "/d/abc", "/connect/p/n"]) {
      expect(isPublicPath(path), path).toBe(true);
    }
    for (const path of ["/", "/login", "/projects/p/home", "/catalogue/a/b", "/organization", "/v", "/endpoints"]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });

  it("routes every path it claims, so a claimed page never reloads into itself", () => {
    const router = createPublicRouter();
    for (const path of ["/catalogue", "/catalogue/bb-pocasie", "/glossary", "/accessibility", "/v/abc", "/f/abc", "/d/abc", "/connect/p/n"]) {
      const matches = router.matchRoutes(path, {});
      expect(matches.at(-1)?.routeId, path).not.toBe("__root__");
    }
  });
});
