/**
 * T-1821: the shell every page of a project is rendered inside, against the UI contract
 * (UI-11, UI-15, UI-16).
 *
 * The shell is the only chrome a person never leaves, so its contract is the keyboard one: the
 * skip link before everything, one real control per action, the phone menu closing on Escape with
 * the focus back where it came from, and a footer whose address comes from a branding file and is
 * therefore rendered through `safeHref` (UI-48).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { SUPPORTED_LOCALES } from "../src/i18n";
import { App } from "../src/App";
import { expectNoRawKeys, expectNoViolations } from "./checks";

const IDENTITY = {
  subject: "b7c1e0f4",
  username: "jana.kovacova",
  name: "Jana Kováčová",
  roles: ["portal-viewer"],
};

const PROJECTS = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "List",
  items: [{ name: "helsinki" }, { name: "banskabystrica" }],
};

const EMPTY_LIST = { apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] };

const BRANDING = {
  instanceName: "Mesto Banská Bystrica — joinedcontext",
  shortName: "BB kontext",
  organisation: "Mesto Banská Bystrica",
  contactEmail: "data@banskabystrica.sk",
};

let branding: Record<string, unknown>;

/** The shell of one project, up once its sidebar is. */
async function shell(path = "/projects/banskabystrica/spaces") {
  window.history.pushState({}, "", path);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const href = input instanceof Request ? input.url : String(input);
      const url = new URL(href, window.location.origin);
      const body = url.pathname.endsWith("/auth/me")
        ? IDENTITY
        : url.pathname === "/api/v1/branding"
          ? branding
          : url.pathname === "/api/v1/projects"
            ? PROJECTS
            : EMPTY_LIST;
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(screen.getByRole("navigation", { name: i18n.t("nav.main") })).toBeInTheDocument(),
  );
  return { ...view, user: userEvent.setup() };
}

/** The chrome itself: the header, the sidebar and the footer, without the page inside it. */
function chrome(): HTMLElement[] {
  const header = document.querySelector("header") as HTMLElement;
  const sidebar = document.getElementById("portal-sidebar") as HTMLElement;
  const footer = document.querySelector("footer") as HTMLElement;
  return [header, sidebar, footer].filter(Boolean);
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.localStorage.removeItem("jc-lang");
  branding = { ...BRANDING };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the shell against the UI contract", () => {
  it("puts the skip link before everything, and it lands on the page", async () => {
    const { user } = await shell();

    await user.tab();
    const first = document.activeElement as HTMLElement;
    expect(first).toHaveTextContent(i18n.t("nav.skipToContent"));
    expect(first.getAttribute("href")).toBe("#main");
    expect(document.getElementById("main")).not.toBeNull();
    // Out of sight until it has the focus, never out of the tab order.
    expect(first.className).toContain("sr-only");
    expect(first.className).toContain("focus:not-sr-only");
  });

  it("has no axe violation in the header, the sidebar or the footer", async () => {
    await shell();

    for (const part of chrome()) {
      await expectNoViolations(part);
    }
  });

  it("names every control of the chrome, and hand-makes none of them", async () => {
    await shell();

    const header = document.querySelector("header") as HTMLElement;
    for (const control of Array.from(header.querySelectorAll("button, a"))) {
      expect(control, control.outerHTML).toHaveAccessibleName();
    }
    // Every acting control of the header is the shared Button: one focus ring, one size scale.
    for (const button of Array.from(header.querySelectorAll("button"))) {
      expect(button.className, button.outerHTML).toContain("focus-ring");
    }
    expect(header.querySelectorAll("div[onclick], span[onclick]")).toHaveLength(0);
  });

  it("closes the phone menu with Escape and gives the focus back to the toggle", async () => {
    const { user } = await shell();

    const toggle = screen.getByRole("button", { name: i18n.t("nav.menu") });
    expect(toggle).toHaveAttribute("aria-controls", "portal-sidebar");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The way out leaves the focus where the way in was, not at the top of the document.
    expect(document.activeElement).toBe(toggle);
  });

  it("opens the project switcher and the account menu from the keyboard", async () => {
    const { user } = await shell();

    const switcher = screen.getByRole("button", { name: i18n.t("nav.projects") });
    switcher.focus();
    await user.keyboard("{Enter}");
    const projects = await screen.findByRole("menu");
    expect(within(projects).getByRole("menuitem", { name: "helsinki" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    const account = screen.getByRole("button", {
      name: i18n.t("auth.signedInAs", { name: IDENTITY.name }),
    });
    account.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });

  it("writes the installation's address as a mail link, never as whatever the file said", async () => {
    // A branding file is edited by hand, so the footer's address is untrusted text (UI-48).
    branding = { ...BRANDING, contactEmail: "javascript:alert(1)" };
    await shell();

    const link = within(document.querySelector("footer") as HTMLElement).getByRole("link");
    expect(link.getAttribute("href")).toBe("mailto:javascript:alert(1)");
    expect(link.getAttribute("href")).not.toMatch(/^javascript:/);
  });

  it("says nothing in the footer when the installation configured nothing", async () => {
    branding = { instanceName: "joinedcontext", shortName: "joinedcontext" };
    await shell();

    expect(document.querySelector("footer")).toBeNull();
  });

  it("shows the installation's own name and keeps a long project name in its own width", async () => {
    await shell();

    expect(screen.getAllByText(BRANDING.shortName).length).toBeGreaterThan(0);
    const switcher = screen.getByRole("button", { name: i18n.t("nav.projects") });
    // The name is cut in the button rather than pushing the account menu off the header.
    expect(switcher.querySelector(".truncate")).not.toBeNull();
    const logo = document.querySelector("header img");
    if (logo) {
      expect(logo).toHaveAttribute("alt", "");
      expect(logo).toHaveAttribute("aria-hidden", "true");
    }
  });

  it.each(SUPPORTED_LOCALES)("writes the chrome's own words in %s", async (locale) => {
    window.localStorage.setItem("jc-lang", locale);
    await i18n.changeLanguage(locale);
    await shell();

    for (const part of chrome()) {
      expectNoRawKeys(part);
    }
  });
});
