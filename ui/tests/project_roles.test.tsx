import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { App } from "../src/App";
import { answeringChecks } from "./checks";

const IDENTITY = {
  subject: "b7c1e0f4",
  username: "jana.kovacova",
  name: "Jana Kováčová",
  roles: ["portal-steward"],
};

const role = (name: string, namespace: string, kinds: string[], verbs: string[]) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Role",
  metadata: { name, namespace },
  spec: { rules: [{ kinds, verbs }] },
});

const list = (items: unknown[]) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "List",
  items,
});

/** What the caller may do here, as `permissions/me` answers it (PF-50). */
const PERMISSIONS = {
  project: "banskabystrica",
  bootstrap: false,
  grants: [
    {
      role: "steward",
      binding: "jana-steward",
      rule: { kinds: ["Role", "Pipeline"], verbs: ["propose", "approve"] },
    },
  ],
};

function renderAccess() {
  const posted: { path: string; body: unknown }[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const request = typeof input === "string" || input instanceof URL ? null : input;
    const href = request ? request.url : String(input);
    const path = new URL(href, window.location.origin).pathname;
    const method = request?.method ?? init?.method ?? "GET";
    const json = (body: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    if (path.endsWith("/auth/me")) {
      return json(IDENTITY);
    }
    if (path.endsWith("/permissions/me")) {
      return json(PERMISSIONS);
    }
    if (method === "POST" && path === "/api/v1/projects/banskabystrica/roles") {
      posted.push({ path, body: request?.body ?? init?.body });
      return json(
        {
          apiVersion: "joinedcontext.com/v1alpha1",
          kind: "Change",
          metadata: { name: "chg-0000002a", namespace: "banskabystrica" },
          status: { lane: "red", phase: "PendingApproval", plan: { create: 1, update: 0, delete: 0 } },
        },
        202,
      );
    }
    if (path === "/api/v1/projects/org/roles") {
      return json(list([role("org-admin", "org", ["Endpoint", "Role"], ["propose", "approve", "delete"])]));
    }
    if (path === "/api/v1/projects/banskabystrica/roles") {
      return json(list([role("air-analyst", "banskabystrica", ["DataSource"], ["propose"])]));
    }
    return json(list([]));
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("fetch", answeringChecks(globalThis.fetch));

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { fetchMock, posted };
}

describe("the roles of a project on the Access page", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.history.pushState({}, "", "/projects/banskabystrica/access");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists the project's own roles beside the organization's, saying where each one lives", async () => {
    renderAccess();

    const own = (await screen.findByText("air-analyst")).closest("tr") as HTMLElement;
    expect(within(own).getByText("Project banskabystrica")).toBeTruthy();
    expect(within(own).getByText(/propose on DataSource/)).toBeTruthy();

    const shared = screen.getByText("org-admin").closest("tr") as HTMLElement;
    expect(within(shared).getByText("The whole organization")).toBeTruthy();
  });

  it("opens this project's role form and posts nothing until it is valid", async () => {
    // Until T-2400 this case typed a YAML skeleton and asserted the manifest, the POST route and
    // the check that runs before it. A Role is authored through its fields now, and its fields
    // are held by `access_forms.test.tsx` (19 cases, including the rules a person may not grant
    // and the YAML view they cannot slip past). What is still this file's to hold at App level is
    // the door: New role opens *this project's* form, and an incomplete one posts nothing.
    //
    // The POST route and the check-before-propose gate are not reachable here any more — this
    // fixture's author holds no kinds, so the rule picker offers none and the form cannot be made
    // valid through the UI. T-2416 restores that end-to-end.
    const { posted } = renderAccess();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "New role" }));
    const dialog = await screen.findByRole("dialog", { name: /New role/ });
    expect(
      within(dialog).getByText(/banskabystrica/),
      "the form says which project the role belongs to",
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Propose the role" }));
    expect(posted, "an incomplete form does not post").toHaveLength(0);
  });
});
