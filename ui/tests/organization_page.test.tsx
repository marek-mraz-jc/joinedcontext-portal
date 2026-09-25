/**
 * T-2605: the Organization page (UI-75, Architecture/09 §14.1; PF-41, PF-56, PF-59, PF-61, PF-65,
 * PF-77, PF-78, UI-44).
 *
 * One tab per concern at its own address, every write a proposed change. What each tab owns is
 * asserted here: the Settings tab reads the manifest in words and edits it through the kind's
 * form, Members is listed only to whoever reads `RoleBinding` at organization scope (and nothing
 * is fetched for anybody else), Roles lists the organization's roles with the seeded taxonomy
 * marked, and Projects lists the projects with a deletion that shows its cascade and wants the
 * name typed back.
 */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import type { Effective } from "../src/api/permissions";
import { mayRead } from "../src/api/permissions";
import { OrganizationPage } from "../src/pages/organization/OrganizationPage";
import type { OrganizationTab } from "../src/pages/organization/OrganizationPage";
import { fromOrganization, toOrganization } from "../src/pages/organization/OrganizationSettings";
import { DeleteProjectDialog } from "../src/components/DeleteProjectDialog";
import { expectDenied } from "./checks";
import { expectNoAxeViolations, json, list, renderPage } from "./page_contract";

const ORGANIZATION = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Organization",
  metadata: { name: "hel", namespace: "org" },
  spec: {
    domain: "hel.fi",
    gitRepositoryUrl: "https://git.hel.fi/joinedcontext/configuration.git",
    locales: ["fi", "en"],
    defaultLocale: "fi",
    contacts: [{ role: "data-protection", name: "Tietosuoja", email: "tietosuoja@hel.fi" }],
    projects: { creation: "group:project-leads", visibility: "members", nameCooldownDays: 14 },
  },
  status: { phase: "Live" },
};

function binding(name: string, subject: string, role: string, scope: Record<string, string>) {
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "RoleBinding",
    metadata: { name, namespace: "org" },
    spec: { subjects: [{ user: subject }], role, scope },
  };
}

const BINDINGS = [
  binding("admins", "ida@hel.fi", "org-admin", { organization: "hel" }),
  binding("helsinki-steward", "eva@hel.fi", "steward", { project: "helsinki" }),
  binding("bikes-editor", "jan@hel.fi", "pipeline-editor", { contextSpace: "bikes" }),
];

function role(name: string, namespace: string) {
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "Role",
    metadata: { name, namespace },
    spec: { rules: [{ kinds: ["Pipeline"], verbs: ["propose"] }] },
  };
}

const ADMIN = {
  project: "org",
  bootstrap: false,
  grants: [
    {
      role: "org-admin",
      binding: "admins",
      rule: { kinds: ["RoleBinding", "Role", "Group", "Organization", "Project"], verbs: ["propose", "approve", "delete"] },
    },
  ],
} as unknown as Effective;

const VIEWER = {
  project: "org",
  bootstrap: false,
  grants: [{ role: "viewer", binding: "everyone", rule: { kinds: ["Pipeline", "Project"], verbs: ["read"] } }],
} as unknown as Effective;

interface World {
  permissions?: Effective;
}

function renderAt(tab: OrganizationTab, world: World = {}) {
  const { permissions = ADMIN } = world;
  const requests: string[] = [];
  const result = renderPage(<OrganizationPage tab={tab} anchor="helsinki" />, {
    path: `/organization/${tab}`,
    answer: (url, request) => {
      requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname.endsWith("/permissions/me")) return json(permissions);
      if (url.pathname === "/api/v1/projects") return json(list([{ name: "helsinki" }, { name: "espoo" }]));
      if (url.pathname === "/api/v1/projects/org/organizations") return json(list([ORGANIZATION]));
      if (url.pathname === "/api/v1/projects/org/rolebindings") return json(list(BINDINGS));
      if (url.pathname === "/api/v1/projects/org/roles") {
        return json(list([role("viewer", "org"), role("air-analyst", "org")]));
      }
      if (url.pathname === "/api/v1/projects/org/projects") {
        return json(
          list([
            {
              apiVersion: "joinedcontext.com/v1alpha1",
              kind: "Project",
              metadata: { name: "helsinki", namespace: "org", title: "Helsinki city data" },
              spec: { organizationRef: "hel" },
            },
          ]),
        );
      }
      return undefined;
    },
  });
  return { ...result, requests };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the Organization page", () => {
  // UI-16, UI-75: one H1, one tab list, the tab of the address selected.
  it("names itself once and offers the twelve tabs, the address's one selected", async () => {
    renderAt("roles");
    expect(await screen.findByRole("heading", { level: 1, name: en.organization.title })).toBeInTheDocument();
    const tabs = within(screen.getByRole("tablist", { name: en.organization.tabsLabel })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      en.organization.tab.settings,
      en.organization.tab.people,
      en.organization.tab.members,
      en.organization.tab.roles,
      en.organization.tab.groups,
      en.organization.tab["service-accounts"],
      en.organization.tab.blueprints,
      en.organization.tab.agentprofiles,
      en.organization.tab.dataspaceparticipants,
      en.organization.tab.environments,
      en.organization.tab.projects,
      en.organization.tab.setup,
    ]);
    expect(screen.getByRole("tab", { name: en.organization.tab.roles })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "organization-tab-roles");
  });

  it("moves to the tab a person picks, at the tab's own address", async () => {
    const user = userEvent.setup();
    renderAt("settings");
    await user.click(await screen.findByRole("tab", { name: en.organization.tab.projects }));
    await waitFor(() => expect(window.location.pathname).toBe("/organization/projects"));
  });

  // PF-61, PF-65, PF-78: the projects policy in plain words, not the manifest's tokens.
  it("reads the organization's settings in words", async () => {
    renderAt("settings");
    expect((await screen.findAllByText("hel.fi")).length).toBeGreaterThan(0);
    expect(screen.getByText("The members of the group project-leads open projects.")).toBeInTheDocument();
    expect(screen.getByText(en.organization.visibility.members)).toBeInTheDocument();
    expect(screen.getByText("14 days")).toBeInTheDocument();
    expect(screen.getByText(/Data protection: Tietosuoja/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Edit hel\.fi/ })).toBeInTheDocument();
  });

  it("says so when the installation has written no Organization manifest", async () => {
    renderPage(<OrganizationPage tab="settings" anchor="helsinki" />, {
      path: "/organization/settings",
      answer: () => undefined,
    });
    expect(await screen.findByText(en.organization.settings.empty)).toBeInTheDocument();
  });

  // PF-59: the members are listed to a person who reads RoleBinding at organization scope, and
  // only the organization's own bindings are members of the organization.
  it("lists the bindings at organization scope, and no project's or space's", async () => {
    renderAt("members");
    expect(await screen.findByText("ida@hel.fi")).toBeInTheDocument();
    expect(screen.queryByText("eva@hel.fi")).not.toBeInTheDocument();
    expect(screen.queryByText("jan@hel.fi")).not.toBeInTheDocument();
  });

  // PF-59, security: anybody else is told who can see them, and the list is never fetched.
  it("tells a person who may not read the bindings who can, and fetches none", async () => {
    const { requests } = renderAt("members", { permissions: VIEWER });
    expect(await screen.findByText(en.organization.members.hidden)).toBeInTheDocument();
    expect(requests.filter((request) => request.includes("/rolebindings"))).toEqual([]);
    expect(screen.queryByText("ida@hel.fi")).not.toBeInTheDocument();
  });

  // PF-56: the organization's roles once each, the taxonomy's marked seeded, a role the
  // organization wrote itself not.
  it("lists the organization's roles once, marking the seeded taxonomy", async () => {
    const { requests } = renderAt("roles");
    const viewer = await screen.findByRole("row", { name: /viewer/ });
    expect(within(viewer).getByText(en.organization.roles.seeded)).toBeInTheDocument();
    const own = screen.getByRole("row", { name: /air-analyst/ });
    expect(within(own).queryByText(en.organization.roles.seeded)).not.toBeInTheDocument();
    expect(screen.getAllByRole("row", { name: /viewer/ })).toHaveLength(1);
    expect(requests.filter((request) => request.includes("/helsinki/roles"))).toEqual([]);
  });

  // PF-65, PF-77: every project, with its title and who is bound in it.
  it("lists the projects with their titles and how many are bound at project scope", async () => {
    renderAt("projects");
    const helsinki = await screen.findByRole("row", { name: /Helsinki city data/ });
    // T-2759: every row read "0" while the organization's members act in every project.
    await waitFor(() =>
      expect(within(helsinki).getByText("1 of its own · 1 through the organization")).toBeInTheDocument(),
    );
    const espoo = screen.getByRole("row", { name: /espoo/ });
    expect(within(espoo).getByText("None of its own · 1 through the organization")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Helsinki city data" })).toHaveAttribute(
      "href",
      "/projects/helsinki/spaces",
    );
    // Delete was the only action: the project's settings are one click away.
    expect(within(helsinki).getByRole("link", { name: en.organization.projects.settings })).toHaveAttribute(
      "href",
      "/projects/helsinki/settings",
    );
  });

  it("says the organization's members hold their roles across it, not in a project", async () => {
    renderAt("members");
    expect(await screen.findByRole("heading", { name: en.organization.members.title })).toBeInTheDocument();
    expect(screen.getByText(en.organization.members.lead)).toBeInTheDocument();
    expect(screen.queryByText(/in this project/)).toBeNull();
  });

  // UI-44: a viewer meets Delete disabled with the reason, and the count of bound people is not
  // computed from bindings they may not read.
  it("keeps Delete in place for a viewer, disabled with the reason, and shows no counts", async () => {
    const { requests } = renderAt("projects", { permissions: VIEWER });
    const helsinki = await screen.findByRole("row", { name: /Helsinki city data/ });
    await waitFor(() => {
      expectDenied(
        within(helsinki).getByRole("button", { name: "Delete project helsinki" }),
        /permit .delete. on .Project./,
      );
    });
    expect(within(helsinki).getByText(en.organization.projects.peopleHidden)).toBeInTheDocument();
    expect(requests.filter((request) => request.includes("/rolebindings"))).toEqual([]);
  });

  it("passes axe on every tab", async () => {
    for (const tab of ["settings", "members", "roles", "projects"] as const) {
      const { container } = renderAt(tab);
      await screen.findByRole("heading", { level: 1, name: en.organization.title });
      await expectNoAxeViolations(container);
      cleanup();
    }
  });
});

describe("deleting a project (PF-77, PF-78)", () => {
  function renderDelete(answer: (url: URL, request: Request) => Response | undefined) {
    const sent: string[] = [];
    renderPage(<DeleteProjectDialog project="helsinki" open onOpenChange={() => undefined} />, {
      path: "/organization/projects",
      answer: (url, request) => {
        if (request.method !== "GET") sent.push(`${request.method} ${url.pathname}`);
        return answer(url, request);
      },
    });
    return sent;
  }

  it("lists what goes with the project and the reserved name before anything is sent", async () => {
    const sent = renderDelete((url) => {
      if (url.pathname === "/api/v1/projects/helsinki") {
        return json({
          apiVersion: "joinedcontext.com/v1alpha1",
          kind: "Project",
          metadata: {},
          spec: {},
          status: { usage: { contextSpaces: 3, apps: 1, publicEndpoints: 0 } },
        });
      }
      if (url.pathname === "/api/v1/projects/org/organizations") return json(list([ORGANIZATION]));
      return undefined;
    });
    expect(await screen.findByText("3 × Context Spaces")).toBeInTheDocument();
    expect(screen.getByText("1 × Apps")).toBeInTheDocument();
    expect(screen.queryByText(/Public endpoints/)).not.toBeInTheDocument();
    expect(await screen.findByText(/stays reserved for 14 days/)).toBeInTheDocument();
    expect(sent).toEqual([]);
  });

  it("is never one click: the name typed back, then one DELETE that answers with the change", async () => {
    const user = userEvent.setup();
    const sent = renderDelete((url, request) => {
      if (request.method === "DELETE" && url.pathname === "/api/v1/projects/helsinki") {
        return json(
          {
            apiVersion: "joinedcontext.com/v1alpha1",
            kind: "Change",
            metadata: { name: "chg-00000abc", namespace: "helsinki" },
            status: { lane: "red", phase: "PendingApproval" },
          },
          202,
        );
      }
      return undefined;
    });
    const propose = await screen.findByRole("button", { name: en.projectDelete.propose });
    expectDenied(propose);
    await user.click(propose);
    expect(sent).toEqual([]);
    await user.type(screen.getByRole("textbox"), "helsink");
    expectDenied(propose);
    await user.type(screen.getByRole("textbox"), "i");
    await user.click(propose);
    await waitFor(() => expect(sent).toEqual(["DELETE /api/v1/projects/helsinki"]));
  });

  it("shows the API's refusal as it comes", async () => {
    const user = userEvent.setup();
    renderDelete((_url, request) =>
      request.method === "DELETE"
        ? json(
            { title: "Conflict", status: 409, detail: "project 'helsinki' is shared with espoo/bikes: remove the SharedSpaceReference there first (PF-77)" },
            409,
          )
        : undefined,
    );
    await user.type(await screen.findByRole("textbox"), "helsinki");
    await user.click(screen.getByRole("button", { name: en.projectDelete.propose }));
    expect(await screen.findByRole("alert")).toHaveTextContent("shared with espoo/bikes");
  });
});

describe("the Organization form keeps what it does not show", () => {
  it("leaves gitRepositoryUrl out of the form and puts it back into the manifest, without status", () => {
    const form = fromOrganization(ORGANIZATION);
    expect(form).not.toHaveProperty("gitRepositoryUrl");
    const manifest = toOrganization({ ...form, defaultLocale: "en" }, ORGANIZATION) as typeof ORGANIZATION;
    expect(manifest.spec.gitRepositoryUrl).toBe(ORGANIZATION.spec.gitRepositoryUrl);
    expect(manifest.spec.defaultLocale).toBe("en");
    expect(manifest.metadata).toEqual(ORGANIZATION.metadata);
    expect(manifest).not.toHaveProperty("status");
  });
});

describe("mayRead (PF-59)", () => {
  it("reads with read or propose, not with approve alone, and waits while nothing has arrived", () => {
    const grant = (verbs: string[]) =>
      ({ project: "org", bootstrap: false, grants: [{ rule: { kinds: ["RoleBinding"], verbs } }] }) as unknown as Effective;
    expect(mayRead(grant(["read"]), "RoleBinding")).toBe(true);
    expect(mayRead(grant(["propose"]), "RoleBinding")).toBe(true);
    expect(mayRead(grant(["approve"]), "RoleBinding")).toBe(false);
    expect(mayRead(grant(["read"]), "Role")).toBe(false);
    expect(mayRead(undefined, "RoleBinding")).toBeUndefined();
    expect(mayRead({ project: "org", bootstrap: true, grants: [] } as unknown as Effective, "RoleBinding")).toBe(true);
  });
});
