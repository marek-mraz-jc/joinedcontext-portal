/**
 * UI-02, UI-11, UI-12, UI-44: the forms a page builds by hand carry the same help as the forms
 * built from a schema.
 *
 * `tests/form_help.test.ts` holds the seven schema-driven forms to one sentence of help and one
 * example per field. Four kinds are filled in by hand instead — a catalogue, a role binding, a
 * role and a group — and had labels and nothing else: measured on main on 2026-09-20, 11 of their
 * 11 fields showed no description at all (T-1624, T-1625, T-1626, T-1632).
 *
 * A control is judged the way a person meets it: the accessible description a screen reader
 * announces, and the placeholder a sighted person reads before typing. The help is asserted in
 * all four languages, because help that only exists in English is help for some of the people.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { App } from "../src/App";
import cs from "../src/locales/cs.json";
import de from "../src/locales/de.json";
import en from "../src/locales/en.json";
import sk from "../src/locales/sk.json";
import { findFormPage } from "./formPage";

const LOCALES = ["en", "sk", "cs", "de"] as const;

const IDENTITY = {
  subject: "b7c1e0f4",
  username: "jana.kovacova",
  name: "Jana Kováčová",
  roles: ["portal-approver"],
};

const LIST = "joinedcontext.com/v1alpha1";
const list = (items: unknown[]) => ({ apiVersion: LIST, kind: "List", items });

const ROLES = list([
  {
    apiVersion: LIST,
    kind: "Role",
    metadata: { name: "space-reader", namespace: "banskabystrica" },
    spec: { rules: [{ kinds: ["ContextSpace"], verbs: ["read"] }] },
  },
]);

/** Everything these four pages read, answered from one place. */
function renderPortal(path: string) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = typeof input === "string" || input instanceof URL ? null : input;
    const href = request ? request.url : String(input);
    const url = new URL(href, window.location.origin);
    const method = request?.method ?? init?.method ?? "GET";
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (url.pathname.endsWith("/auth/me")) {
      return json(IDENTITY);
    }
    if (url.pathname.endsWith("/branding")) {
      return json({
        instanceName: "joinedcontext",
        languages: { default: "en", offered: ["en", "sk", "cs", "de"] },
      });
    }
    if (url.pathname.endsWith("/permissions/me")) {
      return json({
        project: "banskabystrica",
        bootstrap: false,
        grants: [
          {
            role: "keeper",
            binding: "keepers",
            scope: "organization",
            rule: {
              kinds: ["Group", "Role", "RoleBinding", "CkanInstance"],
              verbs: ["read", "propose"],
            },
          },
        ],
      });
    }
    if (url.pathname.endsWith("/ckan/status")) {
      return json({ instances: [], publications: [] });
    }
    if (url.pathname.endsWith("/roles")) {
      return json(ROLES);
    }
    if (method !== "GET") {
      return json({ apiVersion: LIST, kind: "Change", metadata: { name: "chg-1" } }, 202);
    }
    return json(list([]));
  });
  vi.stubGlobal("fetch", fetchMock);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.history.pushState({}, "", path);
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/** What a screen reader announces after the control's own name. */
function describedText(control: HTMLElement): string {
  const ids = (control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  return ids
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .join(" ")
    .trim();
}

/** Every control a person fills inside one region, by the accessible name of its label. */
function controls(region: HTMLElement): HTMLElement[] {
  return [
    ...region.querySelectorAll<HTMLElement>("input, select, textarea"),
  ].filter((control) => !control.hasAttribute("hidden") && control.getAttribute("type") !== "hidden");
}

function bundleOf(locale: (typeof LOCALES)[number]) {
  return { en, sk, cs, de }[locale] as unknown as Record<string, unknown>;
}

/** The string a key names in one bundle, so a missing translation fails rather than falls back. */
function stringAt(locale: (typeof LOCALES)[number], key: string): string {
  const value = key
    .split(".")
    .reduce<unknown>(
      (node, step) => (node as Record<string, unknown> | undefined)?.[step],
      bundleOf(locale),
    );
  expect(typeof value, `${locale}: ${key}`).toBe("string");
  return value as string;
}

describe("the help beside a hand-built form field", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("describes every field of the catalogue form and shows an example to type", async () => {
    renderPortal("/projects/banskabystrica/ckan");

    const submit = await screen.findByRole("button", { name: en.ckan.instances.propose });
    const form = submit.closest("form") as HTMLElement;
    const fields = controls(form);
    expect(fields.length).toBe(4);
    for (const field of fields) {
      expect(describedText(field).length, field.id).toBeGreaterThan(15);
      expect(field.getAttribute("placeholder"), `${field.id} shows an example`).toBeTruthy();
    }
    // The example is a name, never a credential: the token itself is a secret the operator loads.
    expect(
      (form.querySelector("#ckan-instance-secret") as HTMLInputElement).placeholder,
    ).toBe("ckan-api-token");
  });

  it("describes every field of the role binding form", async () => {
    const person = userEvent.setup();
    renderPortal("/projects/banskabystrica/access");

    await person.click(await screen.findByRole("button", { name: en.access.roles.grant }));
    const dialog = await findFormPage(new RegExp(en.access.roles.grantTitle));
    const fields = controls(dialog);
    expect(fields.length).toBe(5);
    for (const field of fields) {
      expect(describedText(field).length, field.id).toBeGreaterThan(15);
    }
    // The one field a person types into freely: the others offer their own values.
    const subject = fields.find((field) => field.tagName === "INPUT" && field.getAttribute("type") !== "date");
    expect(subject?.getAttribute("placeholder")).toBeTruthy();
  });

  it("describes every field of the new role and the new group forms", async () => {
    // Both used to be one textarea holding a manifest, and the help was a sentence about that
    // textarea. They are schema-driven forms now (T-2400), so the help is the arrangement's, one
    // sentence per field in four languages, which `tests/form_help.test.ts` holds them to. What is
    // asserted here is what a person meets: every control of the open dialog carries it.
    const person = userEvent.setup();
    renderPortal("/projects/banskabystrica/access");

    for (const [button, title] of [
      [en.access.projectRoles.new, en.access.projectRoles.newTitle],
      [en.access.groups.new, en.access.groups.newTitle],
    ] as const) {
      await person.click(await screen.findByRole("button", { name: button }));
      const dialog = await findFormPage(new RegExp(title));
      const fields = controls(dialog).filter((field) => field.id.startsWith("root"));
      expect(fields.length, `${title} renders its fields`).toBeGreaterThan(0);
      for (const field of fields) {
        expect(describedText(field).length, `${title}: ${field.id}`).toBeGreaterThan(15);
      }
      await person.click(within(dialog).getByRole("button", { name: en.form.backToList }));
    }
  });

  it("writes that help in all four languages, each in its own words", () => {
    const keys = [
      "access.roles.subjectKindHelp",
      "access.roles.personHelp",
      "access.roles.groupHelp",
      "access.roles.roleHelp",
      "access.roles.whereHelp",
      "access.roles.untilHelp",
      "ckan.instances.nameHelp",
      "ckan.instances.urlHelp",
      "ckan.instances.organizationHelp",
      "ckan.instances.tokenHelp",
    ];
    for (const key of keys) {
      const written = LOCALES.map((locale) => stringAt(locale, key));
      for (const sentence of written) {
        expect(sentence.length, `${key} is one sentence a person can read`).toBeGreaterThan(30);
      }
      expect(new Set(written).size, `${key} is translated, not copied`).toBe(4);
    }
  });
});
