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

  // UI-82, UI-83: the sidebar lists every tab in an Organization section, the tab in hand marked
  // as the page, and the profile block at the bottom links the organization and signs out.
  it("lists every tab in the sidebar's Organization section, marking the tab in hand", async () => {
    renderAt("/organization/members");
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    const section = await within(nav).findByRole("region", { name: en.nav.organization });
    for (const [tab, label] of Object.entries(en.organization.tab)) {
      expect(within(section).getByRole("link", { name: label })).toHaveAttribute("href", `/organization/${tab}`);
    }
    expect(within(section).getByRole("link", { name: en.organization.tab.members })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(section).getByRole("link", { name: en.organization.tab.settings })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("names the signed-in person at the bottom, with the organization and sign-out", async () => {
    renderAt("/organization/members");
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    const profile = await within(nav).findByRole("region", { name: en.nav.profile });
    expect(within(profile).getByText(IDENTITY.username)).toBeInTheDocument();
    expect(within(profile).getByRole("link", { name: en.nav.organization })).toHaveAttribute(
      "href",
      "/organization/settings",
    );
    expect(within(profile).getByRole("button", { name: en.auth.signOut })).toBeEnabled();
  });

  it("opens a tab's create form as a page of its own, the assistant's `…/new` address", async () => {
    renderAt("/organization/groups/new");
    expect(await screen.findByRole("heading", { name: en.access.groups.newTitle })).toBeInTheDocument();
  });

  it("answers a tab address with something that is no form with the not-found page", async () => {
    renderAt("/organization/groups/whatever/else");
    expect(await screen.findByText(en.app.notFound.title)).toBeInTheDocument();
  });

  it("answers an address that names no tab with the not-found page", async () => {
    renderAt("/organization/billing");
    expect(await screen.findByText(en.app.notFound.title)).toBeInTheDocument();
  });
});
