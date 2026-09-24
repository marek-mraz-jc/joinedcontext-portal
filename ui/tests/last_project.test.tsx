/**
 * T-2753: a page that belongs to no project opens on the project the person last worked in.
 *
 * The organization's tabs, `/endpoints` and `/` took the first project of the list, so a person
 * working in helsinki who opened the Organization page found the header switched to banskabystrica
 * (the first one alphabetically) and every link from there led into the wrong project.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { App } from "../src/App";
import { preferredProject, rememberProject } from "../src/api/projects";

const IDENTITY = { subject: "b7c1e0f4", username: "jana.kovacova", roles: ["portal-viewer"] };
const LIST = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });
const PROJECTS = LIST([{ name: "banskabystrica" }, { name: "helsinki" }]);

function renderAt(path: string) {
  window.history.pushState({}, "", path);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = url.includes("/auth/me")
        ? IDENTITY
        : url.endsWith("/api/v1/projects")
          ? PROJECTS
          : url.includes("/permissions/me")
            ? { project: "helsinki", bootstrap: true, grants: [] }
            : LIST([]);
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/** The project the header's switcher names. */
async function selected(): Promise<string> {
  const switcher = await screen.findByRole("button", { name: en.nav.projects });
  return switcher.textContent ?? "";
}

describe("the project a page outside any project opens on (T-2753)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    window.history.pushState({}, "", "/");
  });

  it("remembers the project a page was drawn for", async () => {
    renderAt("/projects/helsinki/spaces");
    await waitFor(async () => expect(await selected()).toContain("helsinki"));
    expect(preferredProject(["banskabystrica", "helsinki"])).toBe("helsinki");
  });

  for (const path of ["/organization/settings", "/organization/members", "/endpoints"]) {
    it(`keeps helsinki on ${path}`, async () => {
      rememberProject("helsinki");
      renderAt(path);
      await waitFor(async () => expect(await selected()).toContain("helsinki"));
      expect(await selected()).not.toContain("banskabystrica");
    });
  }

  it("sends / to the spaces of the project last worked in", async () => {
    rememberProject("helsinki");
    renderAt("/");
    await waitFor(() => expect(window.location.pathname).toBe("/projects/helsinki/spaces"));
  });

  it("falls back to the first project when the remembered one is not readable any more", () => {
    rememberProject("praha");
    expect(preferredProject(["banskabystrica", "helsinki"])).toBe("banskabystrica");
    expect(preferredProject([])).toBeUndefined();
  });

  it("keeps working when the browser refuses storage", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => rememberProject("helsinki")).not.toThrow();
    expect(preferredProject(["banskabystrica", "helsinki"])).toBe("banskabystrica");
    get.mockRestore();
    set.mockRestore();
  });
});
