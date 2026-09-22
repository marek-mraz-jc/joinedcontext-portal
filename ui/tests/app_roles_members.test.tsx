/**
 * An application's roles and who holds them, on its App page (T-2595, AP-99, ADR-N-027): each
 * role with its description and members, Add member and Remove proposing the App manifest through
 * the checked propose, and every write control disabled with the reason for a person who may not
 * propose an App (PF-50, UI-44).
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { asUser, RolesAndMembers, withMember, withoutMember } from "../src/pages/apps/RolesAndMembers";
import type { RolesSpec } from "../src/pages/apps/RolesAndMembers";
import { expectNoViolations } from "./checks";
import { list, renderPage } from "./page_contract";

const APP = "/api/v1/projects/helsinki/apps/alerts";
const CHANGE = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Change",
  metadata: { name: "chg-42", namespace: "helsinki" },
  spec: { lane: "red" },
  status: { phase: "Pending" },
};

function manifest(spec: Partial<RolesSpec> = {}) {
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "App",
    metadata: { name: "alerts", namespace: "helsinki", title: "Alerts", labels: { team: "ops" } },
    spec: {
      kind: "static",
      visibility: "roles",
      roles: [
        { name: "viewer", title: { en: "Viewer" }, description: "Reads the alerts" },
        { name: "steward", title: { en: "Steward" }, description: "Writes the steward's note" },
      ],
      access: [{ role: "viewer", subjects: [{ group: "helsinki-operations" }, { user: "petra@hel.fi" }] }],
      dataNeeds: [],
      ...spec,
    },
  };
}

function renderSection({ app = manifest() as unknown, mayPropose = true } = {}) {
  const sent: { dryRun: boolean; body: unknown }[] = [];
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": status < 300 ? "application/json" : "application/problem+json" },
    });
  const view = renderPage(<RolesAndMembers project="helsinki" name="alerts" />, {
    path: "/projects/helsinki/apps/alerts",
    answer: async (url, request) => {
      if (url.pathname === "/api/v1/projects/helsinki/permissions/me") {
        return reply(200, {
          project: "helsinki",
          bootstrap: false,
          grants: [{ rule: { kinds: ["App"], verbs: mayPropose ? ["read", "propose"] : ["read"] } }],
        });
      }
      if (url.pathname === "/api/v1/projects/org/groups") {
        return reply(200, list([{ metadata: { name: "helsinki-operations" } }, { metadata: { name: "alert-editors" } }]));
      }
      if (url.pathname === APP && request.method === "GET") return reply(200, app);
      if (url.pathname === APP && request.method === "PUT") {
        const dryRun = url.searchParams.get("dryRun") === "All";
        sent.push({ dryRun, body: await request.json() });
        return reply(200, dryRun ? { valid: true, verdict: { ok: true } } : CHANGE);
      }
      return undefined;
    },
  });
  return { sent, view };
}

async function section(): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { name: en.apps.roles.title });
  return heading.closest("section") as HTMLElement;
}

describe("an application's roles and members", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // AP-99: every role with its description and members, a role nobody holds said so.
  it("lists each role with its description and its users and groups", async () => {
    renderSection();
    const viewer = within(await section()).getByRole("listitem", { name: "Viewer" });
    expect(within(viewer).getByText("Reads the alerts")).toBeInTheDocument();
    expect(within(viewer).getByText("Group helsinki-operations")).toBeInTheDocument();
    expect(within(viewer).getByText("petra@hel.fi")).toBeInTheDocument();
    expect(within(viewer).getByText("(Members: 2)")).toBeInTheDocument();
    const steward = within(await section()).getByRole("listitem", { name: "Steward" });
    expect(within(steward).getByText(en.apps.roles.nobody)).toBeInTheDocument();
    await expectNoViolations(await section());
  });

  // AP-99, PF-57: Add member checks, then proposes the App with the new access, metadata kept.
  it("proposes a new member through the checked propose and shows the change", async () => {
    const user = userEvent.setup();
    const { sent } = renderSection();
    const steward = within(await section()).getByRole("listitem", { name: "Steward" });
    await user.type(within(steward).getByLabelText(en.apps.roles.email), " Jana.Kovacova@Hel.fi ");
    await user.click(within(steward).getByRole("button", { name: en.apps.roles.add }));

    expect(await screen.findByRole("link", { name: /review/i })).toBeInTheDocument();
    expect(sent.map((s) => s.dryRun)).toEqual([true, false]);
    const body = sent[1].body as ReturnType<typeof manifest>;
    expect(body.metadata).toEqual(manifest().metadata);
    expect(body.spec.access).toEqual([
      { role: "viewer", subjects: [{ group: "helsinki-operations" }, { user: "petra@hel.fi" }] },
      { role: "steward", subjects: [{ user: "jana.kovacova@hel.fi" }] },
    ]);
    expect(body.spec.dataNeeds).toEqual([]);
  });

  // AP-99: Remove proposes the access without that member.
  it("proposes a removal", async () => {
    const user = userEvent.setup();
    const { sent } = renderSection();
    const viewer = within(await section()).getByRole("listitem", { name: "Viewer" });
    await user.click(within(viewer).getByRole("button", { name: "Remove petra@hel.fi from Viewer" }));
    await screen.findByRole("link", { name: /review/i });
    expect((sent[1].body as ReturnType<typeof manifest>).spec.access).toEqual([
      { role: "viewer", subjects: [{ group: "helsinki-operations" }] },
    ]);
  });

  // UI-44, PF-50: a reader reaches every write control, is told why, and nothing is sent.
  it("keeps Add member and Remove reachable but refused, with the reason, for a reader", async () => {
    const user = userEvent.setup();
    const { sent } = renderSection({ mayPropose: false });
    const viewer = within(await section()).getByRole("listitem", { name: "Viewer" });
    const remove = within(viewer).getByRole("button", { name: "Remove petra@hel.fi from Viewer" });
    await vi.waitFor(() => expect(remove).toHaveAttribute("aria-disabled", "true"));
    expect(within(viewer).getByRole("button", { name: en.apps.roles.add })).toHaveAttribute("aria-disabled", "true");
    expect(within(viewer).getAllByText(/propose/).length).toBeGreaterThan(0);
    await user.click(remove);
    expect(sent).toEqual([]);
  });

  // An app without roles has nothing to manage, and an unreadable one draws nothing.
  it("draws nothing for an app without roles or one the person may not read", async () => {
    const { view } = renderSection({ app: manifest({ roles: [], access: [] }) });
    await vi.waitFor(() => expect(view.container.innerHTML).toBe(""));
    expect(screen.queryByRole("heading", { name: en.apps.roles.title })).toBeNull();
  });
});

describe("the access a change proposes", () => {
  const spec: RolesSpec = { roles: [{ name: "viewer" }], access: [{ role: "viewer", subjects: [{ user: "a@hel.fi" }] }] };

  // AP-91: a member is added once; a role emptied of members loses its entry, not its declaration.
  it("adds once, removes to nothing, and keeps the role declared", () => {
    expect(withMember(spec, "viewer", { user: "a@hel.fi" })).toBeNull();
    expect(withMember(spec, "viewer", { group: "a" })?.access).toEqual([
      { role: "viewer", subjects: [{ user: "a@hel.fi" }, { group: "a" }] },
    ]);
    const emptied = withoutMember(spec, "viewer", { user: "a@hel.fi" });
    expect(emptied.access).toEqual([]);
    expect(emptied.roles).toEqual(spec.roles);
  });

  // AP-91: a person is an e-mail, lower case; anything else is not one.
  it("reads a typed e-mail and refuses what is not one", () => {
    expect(asUser("  Jana@Hel.FI ")).toBe("jana@hel.fi");
    for (const typed of ["", "jana", "jana@", "@hel.fi", "ja na@hel.fi", "*"]) {
      expect(asUser(typed)).toBeNull();
    }
  });
});
