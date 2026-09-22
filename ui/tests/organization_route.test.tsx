/**
 * T-2605, UI-75: the Organization page is reached from beside the project switcher, outside any
 * project. `/organization` opens on its first tab, a tab of its own address opens that tab, and
 * an address that names no tab is the Portal's not-found page rather than an empty frame.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { App } from "../src/App";

const IDENTITY = { subject: "b7c1e0f4", username: "jana.kovacova", roles: ["portal-viewer"] };
const EMPTY_LIST = { apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] };
const PROJECTS = { apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [{ name: "helsinki" }] };

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
          : EMPTY_LIST;
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

describe("the Organization page's addresses (T-2605)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens /organization on its Settings tab", async () => {
    renderAt("/organization");
    await waitFor(() => expect(window.location.pathname).toBe("/organization/settings"));
    expect(await screen.findByRole("tab", { name: en.organization.tab.settings })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("is linked beside the project switcher, marked as the page in hand", async () => {
    renderAt("/organization/members");
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    const link = await within(nav).findByRole("link", { name: en.nav.organization });
    expect(link).toHaveAttribute("href", "/organization/settings");
    expect(link).toHaveAttribute("aria-current", "page");
  });

  it("answers an address that names no tab with the not-found page", async () => {
    renderAt("/organization/billing");
    expect(await screen.findByText(en.app.notFound.title)).toBeInTheDocument();
  });
});
