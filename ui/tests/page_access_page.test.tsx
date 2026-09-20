/**
 * T-1777: Project → Access against the page contract (UI-11, UI-15, UI-16, UI-44).
 *
 * `AccessPage` composes the five panels that answer one question — who may do what here — so
 * what it owns is the frame: the H1 and the tab, one heading outline over five sections, the
 * keyboard reaching every panel in the order they are read, the four languages, and axe over
 * the whole page rather than over one panel at a time. Each panel's own cases stay in its own
 * test (`role_bindings`, `access_groups`, `service_accounts_view`, `effective_permissions`);
 * what is asserted here is that the four states each panel can be in reach the page at all,
 * because the page is where a person meets them.
 */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { AccessPage } from "../src/pages/access/AccessPage";
import {
  expectHeadingOutline,
  expectNoAxeViolations,
  inEveryLocale,
  json,
  list,
  problem,
  renderPage,
  tabOrder,
} from "./page_contract";

const PROJECT = "helsinki";

function binding(name: string, user: string, role: string) {
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "RoleBinding",
    metadata: { name, namespace: "org" },
    spec: { subjects: [{ user }], role, scope: { project: PROJECT } },
  };
}

const ENDPOINT = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Endpoint",
  metadata: { name: "bikes-public", namespace: PROJECT, title: { en: "Bikes, open data" } },
  spec: { contextSpaceRef: "mobility", slug: "k7m2qz4tv6xh3n5jb2ryd3wcfa", audience: "public" },
};

const GRANTS = {
  subject: { type: "role", id: "public" },
  resource: { type: "endpoint", id: ENDPOINT.spec.slug, space: PROJECT },
  permissions: [
    {
      resource: { type: "BikeHireDockingStation" },
      actions: ["retrieveEntity", "queryEntity"],
      attributes: ["availableBikeNumber", "name"],
      constraints: { scopeQ: "/helsinki/#" },
    },
  ],
  prohibitions: [],
};

/** How many role bindings the project holds; `pending` keeps every request on its way. */
interface World {
  rows?: number;
  /** A fresh answer per request: a `Response` body can be read once, and panels retry. */
  fails?: { status: number; detail: string };
  pending?: boolean;
  grants?: "ok" | "forbidden";
}

function renderAccess(world: World = {}) {
  const { rows = 1, fails, pending = false, grants = "ok" } = world;
  return renderPage(<AccessPage project={PROJECT} />, {
    path: `/projects/${PROJECT}/access`,
    answer: async (url) => {
      if (pending) return new Promise<Response>(() => undefined);
      if (url.pathname.endsWith("/rolebindings")) {
        if (fails) return problem(fails.status, fails.detail);
        return json(
          list(
            Array.from({ length: rows }, (_, index) =>
              binding(`grant-${index}`, `person.${index}@helsinki.fi`, "domain-editor"),
            ),
          ),
        );
      }
      if (url.pathname.endsWith("/endpoints")) return json(list([ENDPOINT]));
      if (url.pathname.includes("/api/endpoint/")) {
        return grants === "forbidden"
          ? problem(403, "You may not read the grants of this endpoint.")
          : json(GRANTS);
      }
      return undefined;
    },
  });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.title = "";
});

describe("the Access page", () => {
  // UI-15: the page names itself once, to the screen and to the tab.
  it("has one H1 and names the page and the project in the tab", async () => {
    renderAccess();
    const heading = await screen.findByRole("heading", { level: 1, name: en.access.title });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText(en.access.lead)).toBeInTheDocument();
    await waitFor(() => {
      expect(document.title).toBe(`${en.access.title} · ${PROJECT} · Helsinki Region Context`);
    });
  });

  // UI-16: one H1 and five H2s, in the order a heading list reads them, nothing skipped.
  it("reads as one outline over its five panels", async () => {
    const { container } = renderAccess();
    await screen.findByRole("heading", { level: 1, name: en.access.title });
    await screen.findByRole("heading", { level: 2, name: en.access.roles.title });
    await screen.findByRole("heading", { level: 2, name: en.access.accounts.title });
    expectHeadingOutline(container);
    for (const section of [
      en.access.roles.title,
      en.access.projectRoles.title,
      en.access.groups.title,
      en.access.accounts.title,
      en.access.matrix.title,
    ]) {
      expect(screen.getByRole("heading", { level: 2, name: section })).toBeInTheDocument();
    }
  });

  // UI-16: every panel is a region a screen reader can jump to, named by its own heading.
  it("gives every panel a named region", async () => {
    const { container } = renderAccess();
    await screen.findByRole("heading", { level: 2, name: en.access.roles.title });
    await screen.findByRole("heading", { level: 2, name: en.access.accounts.title });
    const named = [...container.querySelectorAll("section[aria-labelledby]")].map(
      (section) => section.querySelector("h2")?.textContent,
    );
    expect(named).toHaveLength(5);
    expect(named).toContain(en.access.roles.title);
    expect(named).toContain(en.access.matrix.title);
  });

  // The loading state: a skeleton, and a table that says it is still loading rather than
  // claiming the project holds nobody.
  it("says the lists are loading rather than showing them empty", async () => {
    renderAccess({ pending: true });
    const loading = await screen.findAllByText(en.app.loading);
    expect(loading.length).toBeGreaterThan(0);
    expect(screen.queryByText(en.access.roles.empty)).not.toBeInTheDocument();
  });

  // The empty state: what this is, and what to do first.
  it("offers the first action when nobody holds a role yet", async () => {
    renderAccess({ rows: 0 });
    expect(await screen.findByText(en.access.roles.empty)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.access.roles.grant })).toBeInTheDocument();
  });

  // The error state: the API's own sentence, not "something went wrong", and never an empty
  // list — a list that failed is not "you have nothing".
  it("shows the reason a list failed instead of an empty list", async () => {
    renderAccess({ fails: { status: 503, detail: "The configuration store is not answering." } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The configuration store is not answering.");
    expect(screen.queryByText(en.access.roles.empty)).not.toBeInTheDocument();
  });

  // UI-44: what a person may not read says so in words; the server stays the judge.
  it("says who may grant what when the grants are refused", async () => {
    renderAccess({ grants: "forbidden" });
    expect(await screen.findByText(en.access.matrix.forbidden)).toBeInTheDocument();
  });

  // A list that holds one row and a list that holds many read the same way.
  it.each([0, 1, 500])("draws %i rows without changing how the page reads", async (rows) => {
    const { container } = renderAccess({ rows });
    await screen.findByRole("heading", { level: 2, name: en.access.roles.title });
    const table = await screen.findByRole("table", {
      name: en.access.roles.caption.replace("{project}", PROJECT),
    });
    await waitFor(() => {
      expect(within(table).queryByText(en.app.loading)).not.toBeInTheDocument();
    });
    const body = table.querySelector("tbody");
    expect(body?.querySelectorAll("tr")).toHaveLength(Math.max(rows, 1));
    expectHeadingOutline(container);
  });

  // UI-16: the keyboard reaches the page's controls in the order the panels are read, and
  // nothing takes focus on arrival.
  it("is reachable by keyboard in the order the panels are read", async () => {
    const { container } = renderAccess();
    await screen.findByRole("button", { name: en.access.roles.grant });
    expect(document.activeElement).toBe(document.body);
    const reached = await tabOrder(container);
    const labels = reached.map((element) => element.textContent?.trim() ?? "");
    expect(labels).toContain(en.access.roles.grant);
    expect(reached.indexOf(screen.getByRole("button", { name: en.access.roles.grant }))).toBe(0);
  });

  // UI-11: every string of the page comes from the bundle, in all four languages.
  it("says the same things in every language", async () => {
    await inEveryLocale(async (locale) => {
      cleanup();
      renderAccess({ rows: 0 });
      const title = i18n.t("access.title");
      expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
      expect(
        screen.getByText(i18n.t("access.lead")),
        `the lead is missing in ${locale}`,
      ).toBeInTheDocument();
      if (locale !== "en") {
        expect(title, `${locale} still shows the English title`).not.toBe(en.access.title);
      }
    });
  });

  // PF-50: a name that arrived as markup is read as text, never parsed.
  it("renders a role holder that arrived as markup as text", async () => {
    renderPage(<AccessPage project={PROJECT} />, {
      path: `/projects/${PROJECT}/access`,
      answer: (url) =>
        url.pathname.endsWith("/rolebindings")
          ? json(list([binding("x", "<img src=x onerror=alert(1)>", "domain-editor")]))
          : undefined,
    });
    expect(
      await screen.findByText("<img src=x onerror=alert(1)>"),
    ).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("has no axe violations with its lists full", async () => {
    const { container } = renderAccess({ rows: 3 });
    await screen.findByRole("heading", { level: 2, name: en.access.matrix.title });
    await waitFor(() => {
      expect(screen.queryAllByText(en.app.loading)).toHaveLength(0);
    });
    await expectNoAxeViolations(container);
  });

  it("has no axe violations while it is empty", async () => {
    const { container } = renderAccess({ rows: 0 });
    await screen.findByText(en.access.roles.empty);
    await expectNoAxeViolations(container);
  });

  // The grant form the page's primary action opens is the same form the assistant's draft
  // opens; pressing it from here has to reach it (UI-44, the parity table).
  it("opens the grant form from the page's own action", async () => {
    renderAccess({ rows: 0 });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.access.roles.grant }));
    expect(await screen.findByRole("dialog", { name: en.access.roles.grantTitle })).toBeInTheDocument();
  });
});
