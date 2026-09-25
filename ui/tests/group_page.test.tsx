/**
 * A group's page (T-2685, PF-95, PF-69, UI-44): its members, its platform roles and its
 * application roles, each edit proposed as the one manifest diff it should be, a project role
 * refused at organization scope with the reason, and every write control disabled with the reason
 * for a caller who may not propose.
 */
// covers (T-2137, the module gate in gate_modules.test.ts): src/pages/access/GroupPage.tsx and
// src/pages/access/groupRoles.ts.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import type { Manifest } from "../src/api/manifest";
import { GroupPage } from "../src/pages/access/GroupPage";
import {
  appRolesNaming,
  bindingsNaming,
  bindingWithoutGroup,
  groupBinding,
  refusedPlace,
  withGroupMember,
} from "../src/pages/access/groupRoles";
import { expectDenied, expectNoViolations } from "./checks";
import { list, renderPage } from "./page_contract";

const V = "joinedcontext.com/v1alpha1";
const CHANGE = {
  apiVersion: V,
  kind: "Change",
  metadata: { name: "chg-0000002a", namespace: "org" },
  status: { lane: "red", phase: "PendingApproval", plan: { create: 0, update: 1, delete: 0 } },
};

const GROUP = {
  apiVersion: V,
  kind: "Group",
  metadata: { name: "stewards", namespace: "org", labels: { team: "city" } },
  spec: { description: "The city's data stewards", members: [{ user: "jana@hel.fi" }] },
};

const binding = (name: string, subjects: unknown[], role: string, scope: unknown) => ({
  apiVersion: V,
  kind: "RoleBinding",
  metadata: { name, namespace: "org" },
  spec: { subjects, role, scope },
});

const BINDINGS = [
  binding("mixed", [{ group: "stewards" }, { user: "jana@hel.fi" }], "steward", { project: "helsinki" }),
  binding("stewards-only", [{ group: "stewards" }], "viewer", { organization: "hel" }),
  binding("other", [{ group: "editors" }], "viewer", { organization: "hel" }),
];

const APP = {
  apiVersion: V,
  kind: "App",
  metadata: { name: "alerts", namespace: "helsinki" },
  spec: {
    kind: "static",
    roles: [{ name: "viewer" }, { name: "steward" }],
    access: [{ role: "viewer", subjects: [{ group: "stewards" }, { user: "petra@hel.fi" }] }],
  },
};

interface Sent {
  method: string;
  path: string;
  dryRun: boolean;
  body: unknown;
}

function renderGroup({ verbs = ["read", "propose", "delete"], people = false } = {}) {
  const sent: Sent[] = [];
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": status < 300 ? "application/json" : "application/problem+json" },
    });
  renderPage(<GroupPage name="stewards" />, {
    path: "/organization/groups/stewards",
    answer: async (url, request) => {
      const path = url.pathname;
      if (path.endsWith("/permissions/me")) {
        return reply(200, {
          project: "org",
          bootstrap: false,
          grants: [
            { rule: { kinds: ["Group", "RoleBinding", "App"], verbs } },
            ...(people ? [{ rule: { kinds: ["Person"], verbs: ["read"] } }] : []),
          ],
        });
      }
      if (request.method !== "GET") {
        const dryRun = url.searchParams.get("dryRun") === "All";
        sent.push({ method: request.method, path, dryRun, body: await request.json() });
        return reply(dryRun ? 200 : 202, dryRun ? { valid: true, verdict: { ok: true } } : CHANGE);
      }
      if (path === "/api/v1/organization/people") {
        const someone = (email: string, enabled = true) => ({ id: email, email, firstName: "", lastName: "", enabled, emailVerified: true, requiredActions: [] });
        return reply(200, { items: [someone("jana@hel.fi"), someone("petra@hel.fi"), someone("gone@hel.fi", false)] });
      }
      if (path === "/api/v1/projects") return reply(200, list([{ name: "helsinki" }]));
      if (path === "/api/v1/projects/org/groups/stewards") return reply(200, GROUP);
      if (path === "/api/v1/projects/org/rolebindings") return reply(200, list(BINDINGS));
      if (path === "/api/v1/projects/org/roles") {
        return reply(200, list([{ apiVersion: V, kind: "Role", metadata: { name: "viewer", namespace: "org" } }]));
      }
      if (path === "/api/v1/projects/helsinki/roles") {
        return reply(
          200,
          list([
            { apiVersion: V, kind: "Role", metadata: { name: "viewer", namespace: "org" } },
            { apiVersion: V, kind: "Role", metadata: { name: "air-editor", namespace: "helsinki" } },
          ]),
        );
      }
      if (path === "/api/v1/projects/helsinki/apps") return reply(200, list([APP]));
      return undefined;
    },
  });
  return { sent, proposals: () => sent.filter((s) => !s.dryRun) };
}

const section = async (heading: string) =>
  (await screen.findByRole("heading", { name: heading })).closest("section") as HTMLElement;

describe("the group model", () => {
  const manifests = BINDINGS as unknown as Manifest[];

  it("finds the bindings and the application roles naming a group", () => {
    expect(bindingsNaming(manifests, "stewards").map((b) => b.metadata.name)).toEqual(["mixed", "stewards-only"]);
    expect(appRolesNaming([{ project: "helsinki", app: APP as unknown as Manifest }], "stewards")).toEqual([
      { project: "helsinki", app: "alerts", role: "viewer" },
    ]);
    expect(appRolesNaming([], "stewards")).toEqual([]);
  });

  it("takes the group out of a binding, and empties none", () => {
    const edited = bindingWithoutGroup(manifests[0], "stewards");
    expect(edited?.spec).toEqual({ subjects: [{ user: "jana@hel.fi" }], role: "steward", scope: { project: "helsinki" } });
    expect(bindingWithoutGroup(manifests[1], "stewards"), "nobody left: the binding goes").toBeNull();
  });

  // PF-69: an organization role anywhere; a project role in its own project or one of its spaces.
  it("refuses a project role at organization scope or in another project", () => {
    const own = { name: "air-editor", home: "helsinki" };
    expect(refusedPlace({ name: "viewer", home: "org" }, { kind: "organization" })).toBeNull();
    expect(refusedPlace(own, { kind: "organization" })).toBe("projectRoleAtOrganization");
    expect(refusedPlace(own, { kind: "project", project: "tampere" })).toBe("projectRoleElsewhere");
    expect(refusedPlace(own, { kind: "space", project: "helsinki", space: "air" })).toBeNull();
  });

  it("writes the binding for the place chosen", () => {
    expect(groupBinding("stewards", "viewer", { kind: "organization" }, "hel.fi").spec).toEqual({
      subjects: [{ group: "stewards" }],
      role: "viewer",
      scope: { organization: "hel" },
    });
    expect(groupBinding("stewards", "air-editor", { kind: "space", project: "helsinki", space: "air" }, "hel.fi").spec)
      .toMatchObject({ scope: { contextSpace: "air" } });
  });

  it("adds a member once", () => {
    expect(withGroupMember([{ user: "a@hel.fi" }], "b@hel.fi")).toEqual([{ user: "a@hel.fi" }, { user: "b@hel.fi" }]);
    expect(withGroupMember([{ user: "a@hel.fi" }], "a@hel.fi")).toBeNull();
  });
});

describe("a group's page", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the members, the platform roles and the application roles", async () => {
    renderGroup();
    const members = await section(en.access.groupPage.members);
    expect(within(members).getByText("jana@hel.fi")).toBeInTheDocument();
    const platform = await section(en.access.groupPage.platformRoles);
    expect(await within(platform).findByText("steward, Project helsinki")).toBeInTheDocument();
    expect(within(platform).getByText(en.access.groupPage.onlySubject)).toBeInTheDocument();
    const apps = await section(en.access.groupPage.appRoles);
    expect(await within(apps).findByRole("link", { name: "viewer in alerts (helsinki)" })).toBeInTheDocument();
    await expectNoViolations(members);
  });

  it("offers the realm's people who are not members yet", async () => {
    renderGroup({ people: true });
    const members = await section(en.access.groupPage.members);
    // With a list of choices the e-mail field is a combobox to a screen reader.
    const field = await within(members).findByRole("combobox", { name: en.access.groupPage.email });
    const offered = [...document.querySelectorAll(`#${CSS.escape(field.getAttribute("list") ?? "")} option`)].map(
      (option) => (option as HTMLOptionElement).value,
    );
    // jana is a member already; a disabled person is not offered.
    expect(offered).toEqual(["petra@hel.fi"]);
  });

  it("types a member in full when the caller may not list people", async () => {
    renderGroup();
    const members = await section(en.access.groupPage.members);
    expect(within(members).getByRole("textbox", { name: en.access.groupPage.email })).not.toHaveAttribute("list");
  });

  it("adds a member as the Group manifest with that one member more, metadata kept", async () => {
    const user = userEvent.setup();
    const { proposals } = renderGroup();
    const members = await section(en.access.groupPage.members);
    await user.type(within(members).getByLabelText(en.access.groupPage.email), " Petra@Hel.fi ");
    await user.click(within(members).getByRole("button", { name: en.access.groupPage.addMember }));

    await vi.waitFor(() => expect(proposals()).toHaveLength(1));
    const { method, path, body } = proposals()[0];
    expect(`${method} ${path}`).toBe("PUT /api/v1/projects/org/groups/stewards");
    expect(body).toEqual({
      ...GROUP,
      spec: { ...GROUP.spec, members: [{ user: "jana@hel.fi" }, { user: "petra@hel.fi" }] },
    });
  });

  it("takes the group out of a binding that names someone else too", async () => {
    const user = userEvent.setup();
    const { proposals } = renderGroup();
    const platform = await section(en.access.groupPage.platformRoles);
    await user.click(
      await within(platform).findByRole("button", { name: "Take the group out of steward, Project helsinki" }),
    );
    await vi.waitFor(() => expect(proposals()).toHaveLength(1));
    expect(proposals()[0].path).toBe("/api/v1/projects/org/rolebindings/mixed");
    expect((proposals()[0].body as { spec: unknown }).spec).toEqual({
      subjects: [{ user: "jana@hel.fi" }],
      role: "steward",
      scope: { project: "helsinki" },
    });
  });

  // PF-69: the project role stays in the list and the button says why it cannot be given here.
  it("refuses a project role for the whole organization and says why", async () => {
    const user = userEvent.setup();
    const { proposals } = renderGroup();
    const platform = await section(en.access.groupPage.platformRoles);
    const role = within(platform).getByLabelText(en.access.groupPage.role);
    await within(platform).findByRole("option", { name: "air-editor (role of project helsinki)" });
    await user.selectOptions(role, "helsinki/air-editor");
    const give = within(platform).getByRole("button", { name: en.access.groupPage.addRole });
    expectDenied(give, /cannot be given for the whole organization/);

    await user.selectOptions(within(platform).getByLabelText(en.access.groupPage.where), "helsinki");
    expect(give).not.toHaveAttribute("aria-disabled");
    await user.click(give);
    await vi.waitFor(() => expect(proposals()).toHaveLength(1));
    expect(`${proposals()[0].method} ${proposals()[0].path}`).toBe("POST /api/v1/projects/org/rolebindings");
    expect((proposals()[0].body as { spec: unknown }).spec).toEqual({
      subjects: [{ group: "stewards" }],
      role: "air-editor",
      scope: { project: "helsinki" },
    });
  });

  it("gives the group an application role as the App manifest with the group added", async () => {
    const user = userEvent.setup();
    const { proposals } = renderGroup();
    const apps = await section(en.access.groupPage.appRoles);
    await user.selectOptions(within(apps).getByLabelText(en.access.groupPage.project), "helsinki");
    await user.selectOptions(await within(apps).findByLabelText(en.access.groupPage.app), "alerts");
    await user.selectOptions(within(apps).getByLabelText(en.access.groupPage.role), "steward");
    await user.click(within(apps).getByRole("button", { name: en.access.groupPage.addAppRole }));

    await vi.waitFor(() => expect(proposals()).toHaveLength(1));
    expect(proposals()[0].path).toBe("/api/v1/projects/helsinki/apps/alerts");
    expect((proposals()[0].body as typeof APP).spec.access).toEqual([
      { role: "viewer", subjects: [{ group: "stewards" }, { user: "petra@hel.fi" }] },
      { role: "steward", subjects: [{ group: "stewards" }] },
    ]);
  });

  it("takes the group out of an application role", async () => {
    const user = userEvent.setup();
    const { proposals } = renderGroup();
    const apps = await section(en.access.groupPage.appRoles);
    await user.click(
      await within(apps).findByRole("button", { name: "Take the group out of viewer in alerts (helsinki)" }),
    );
    await vi.waitFor(() => expect(proposals()).toHaveLength(1));
    expect((proposals()[0].body as typeof APP).spec.access).toEqual([
      { role: "viewer", subjects: [{ user: "petra@hel.fi" }] },
    ]);
  });

  // UI-44, PF-50: a reader reaches the controls, is told why, and nothing is proposed.
  it("keeps every write control reachable but refused for a caller who may only read", async () => {
    const { proposals } = renderGroup({ verbs: ["read"] });
    const members = await section(en.access.groupPage.members);
    const remove = within(members).getByRole("button", { name: "Remove jana@hel.fi from the group" });
    await vi.waitFor(() => expectDenied(remove, "Disabled: your role does not permit 'propose' on 'Group' in this project"));
    const platform = await section(en.access.groupPage.platformRoles);
    expectDenied(within(platform).getByRole("button", { name: en.access.groupPage.addRole }));
    expect(proposals()).toHaveLength(0);
  });
});
