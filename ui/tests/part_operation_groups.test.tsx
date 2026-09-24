/**
 * T-2282: an endpoint's grants read as ETSI named operation groups (R8, GW34, EP-51, UI-48).
 *
 * Two things are held here. First the vocabulary: the five groups of CIM 009 Table 4.20-2 and
 * exactly the operations each one stands for — the same table `jc-core`'s
 * `each_operation_group_expands_to_exactly_its_table_members_gw34` holds the gateway to, written
 * out again rather than read from the code, because a list that asks the code what it contains
 * can only ever agree with itself.
 *
 * Then the reading of it: an endpoint names its policy as a URN, and the page used to print that
 * URN and stop. The resolution is the gateway's own (`bound_policy` in `context-gateway/src/store.rs`)
 * and it has three answers — every policy of the space, one bound policy, or nothing at all —
 * and the third is the one that matters, because an endpoint whose reference resolves to nothing
 * grants nothing, and drawing the space's policies there would show grants nobody has.
 */
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRootRoute, createRouter } from "@tanstack/react-router";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { SUPPORTED_LOCALES } from "../src/i18n";
import en from "../src/locales/en.json";
import { expectNoRawKeys, expectNoViolations } from "./checks";
import { EndpointPage } from "../src/pages/endpoints/EndpointPage";
import {
  OPERATION_GROUPS,
  OPERATION_GROUP_NAMES,
  expandOperations,
  grantWrites,
  groupOf,
} from "../src/components/endpoints/operationGroups";
import { bindingOf, parsePolicyUrn, spaceSegment } from "../src/components/endpoints/policyBinding";
import type { Manifest } from "../src/api/manifest";

const PROJECT = "banskabystrica";
const NAME = "ovzdusie-public";
const SLUG = "k7m2qz4tv6xh3n5jb2ryd3wcfa";
const URN = "urn:ngsi-ld:Policy:banskabystrica.sk:ovzdusie:readers";

/** CIM 009 Table 4.20-2, written out. */
const TABLE: Record<string, { writes: boolean; operations: string[] }> = {
  retrieveOps: { writes: false, operations: ["retrieveEntity", "queryEntity"] },
  updateOps: {
    writes: true,
    operations: ["updateEntity", "updateAttrs", "replaceEntity", "replaceAttrs"],
  },
  associationOps: {
    writes: false,
    operations: [
      "retrieveEntity",
      "queryEntity",
      "queryBatch",
      "retrieveEntityTypes",
      "retrieveEntityTypeDetails",
      "retrieveEntityTypeInfo",
      "retrieveAttrTypes",
      "retrieveAttrTypeDetails",
      "retrieveAttrTypeInfo",
      "createSubscription",
      "updateSubscription",
      "retrieveSubscription",
      "querySubscription",
      "deleteSubscription",
    ],
  },
  federationOps: {
    writes: false,
    operations: [
      "retrieveEntity",
      "queryEntity",
      "queryBatch",
      "retrieveEntityTypes",
      "retrieveEntityTypeDetails",
      "retrieveEntityTypeInfo",
      "retrieveAttrTypes",
      "retrieveAttrTypeDetails",
      "retrieveAttrTypeInfo",
      "createSubscription",
      "updateSubscription",
      "retrieveSubscription",
      "querySubscription",
      "deleteSubscription",
      "retrieveEntityMap",
      "updateEntityMap",
      "deleteEntityMap",
      "createEntityMapQueryEntity",
    ],
  },
  redirectionOps: {
    writes: true,
    operations: [
      "createEntity",
      "updateEntity",
      "appendAttrs",
      "updateAttrs",
      "deleteAttrs",
      "deleteEntity",
      "mergeEntity",
      "replaceEntity",
      "replaceAttrs",
      "retrieveEntity",
      "queryEntity",
      "purgeEntity",
      "retrieveEntityTypes",
      "retrieveEntityTypeDetails",
      "retrieveEntityTypeInfo",
      "retrieveAttrTypes",
      "retrieveAttrTypeDetails",
      "retrieveAttrTypeInfo",
      "retrieveEntityMap",
      "updateEntityMap",
      "deleteEntityMap",
      "createEntityMapQueryEntity",
    ],
  },
};

function manifest(kind: string, name: string, spec: Record<string, unknown>): Manifest {
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind,
    metadata: { name, namespace: PROJECT },
    spec,
  } as Manifest;
}

const SPACE = manifest("ContextSpace", "ovzdusie", { urnSegment: "ovzdusie" });

const ENDPOINT = manifest("Endpoint", NAME, {
  contextSpaceRef: "ovzdusie",
  slug: SLUG,
  audience: "public",
  policyRef: URN,
  enabledRepresentations: ["ngsi-ld"],
});

const READERS = manifest("Policy", "readers", {
  contextSpaceRef: "ovzdusie",
  assignee: { kind: "role", id: "public" },
  operations: ["retrieveOps"],
});

const WRITERS = manifest("Policy", "writers", {
  contextSpaceRef: "ovzdusie",
  assignee: { kind: "group", id: "bbsk" },
  operations: ["updateOps"],
});

const ELSEWHERE = manifest("Policy", "readers", {
  contextSpaceRef: "doprava",
  assignee: { kind: "role", id: "public" },
  operations: ["retrieveOps"],
});

function list(items: unknown[]) {
  return { apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items };
}

function show(options: { endpoint?: Manifest; policies?: Manifest[] } = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    const path = url.pathname;
    const json = (body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    if (path.endsWith(`/endpoints/${NAME}`)) return json(options.endpoint ?? ENDPOINT);
    if (path.endsWith("/policies")) return json(list(options.policies ?? [READERS]));
    if (path.endsWith("/spaces")) return json(list([SPACE]));
    if (path.endsWith("/permissions/me")) return json({ project: PROJECT, bootstrap: false, grants: [] });
    return json(list([]));
  });
  vi.stubGlobal("fetch", fetchMock);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <EndpointPage project={PROJECT} name={NAME} /> });
  const router = createRouter({ routeTree: rootRoute });
  const view = render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { container: view.container, unmount: view.unmount };
}

/** The "Who may call it" section of the page. */
async function grants(): Promise<HTMLElement> {
  // By the locale under test, not by English: the section's name is translated like everything else.
  const heading = await screen.findByRole("heading", { name: i18n.t("endpoints.page.whoMayCall") });
  return heading.closest("section") as HTMLElement;
}

describe("the CIM 009 operation groups", () => {
  it("stand for exactly the operations Table 4.20-2 lists for them", () => {
    expect([...OPERATION_GROUP_NAMES].sort()).toEqual(Object.keys(TABLE).sort());
    for (const [name, expected] of Object.entries(TABLE)) {
      const group = OPERATION_GROUPS[name as keyof typeof OPERATION_GROUPS];
      expect([...group.operations], `${name} expands to something else`).toEqual(expected.operations);
      expect(group.writes, `${name} is marked the wrong way round`).toBe(expected.writes);
    }
  });

  it("expand a grant's operations, each once, and keep a name that is neither", () => {
    expect(expandOperations(["retrieveOps"])).toEqual(["retrieveEntity", "queryEntity"]);
    // retrieveOps ⊂ redirectionOps: the overlap is listed once, not twice.
    expect(expandOperations(["retrieveOps", "retrieveEntity"])).toEqual(["retrieveEntity", "queryEntity"]);
    // A name the API would refuse stays visible rather than disappearing from the reading.
    expect(expandOperations(["readOps"])).toEqual(["readOps"]);
    expect(groupOf("readOps")).toBeUndefined();
  });

  it("say which grants can change data, groups and single operations alike", () => {
    expect(grantWrites(["retrieveOps"])).toBe(false);
    expect(grantWrites(["updateOps"])).toBe(true);
    expect(grantWrites(["redirectionOps"])).toBe(true);
    // A subscription write makes a single-operation grant a write, but never makes the
    // consumption groups one: that is the platform's own line (OperationGroup::includes_write).
    expect(grantWrites(["createSubscription"])).toBe(true);
    expect(grantWrites(["federationOps"])).toBe(false);
    expect(grantWrites(["retrieveEntity", "queryEntity"])).toBe(false);
  });
});

describe("which policies decide an endpoint's calls", () => {
  it("reads a policy URN, and refuses anything that is not one", () => {
    expect(parsePolicyUrn(URN)).toEqual({
      orgDomain: "banskabystrica.sk",
      space: "ovzdusie",
      localId: "readers",
    });
    expect(parsePolicyUrn("urn:ngsi-ld:Endpoint:bb.sk:ovzdusie:readers")).toBeUndefined();
    expect(parsePolicyUrn("readers")).toBeUndefined();
    expect(parsePolicyUrn("urn:ngsi-ld:Policy:bb.sk:ovzdusie")).toBeUndefined();
  });

  it("takes the space's pinned URN segment, and the project-space default without one", () => {
    expect(spaceSegment(PROJECT, "ovzdusie", [SPACE])).toBe("ovzdusie");
    expect(spaceSegment(PROJECT, "doprava", [SPACE])).toBe("banskabystrica-doprava");
  });

  it("binds the one policy the reference names, and every policy of the space without one", () => {
    const bound = bindingOf(ENDPOINT, PROJECT, "ovzdusie", [READERS, WRITERS], [SPACE]);
    expect(bound).toEqual({ kind: "bound", policies: [READERS] });

    const noRef = manifest("Endpoint", NAME, { contextSpaceRef: "ovzdusie", slug: SLUG });
    const all = bindingOf(noRef, PROJECT, "ovzdusie", [READERS, WRITERS], [SPACE]);
    expect(all).toEqual({ kind: "all", policies: [READERS, WRITERS] });
  });

  // T-2751: the gateway drops every `endpoint:` role a token asserts and gives a caller only the
  // roles of the Endpoint it came through (AP-96, AP-97), so another App's grant never applies here.
  it("leaves out a policy assigned to another endpoint's role, as the gateway does", () => {
    const app = (name: string, id: string) =>
      manifest("Policy", name, { contextSpaceRef: "ovzdusie", assignee: { kind: "role", id }, operations: ["queryEntity"] });
    const own = app("own", `endpoint:${PROJECT}/${NAME}`);
    const ownRole = app("own-steward", `endpoint:${PROJECT}/${NAME}/steward`);
    const other = app("other", `endpoint:${PROJECT}/app-hsl-transport`);
    const otherRole = app("other-steward", `endpoint:${PROJECT}/app-hsl-transport/steward`);
    const prefix = app("prefix", `endpoint:${PROJECT}/${NAME}-v2`);
    const noRef = manifest("Endpoint", NAME, { contextSpaceRef: "ovzdusie", slug: SLUG });
    const all = bindingOf(noRef, PROJECT, "ovzdusie", [READERS, own, ownRole, other, otherRole, prefix], [SPACE]);
    expect(all).toEqual({ kind: "all", policies: [READERS, own, ownRole] });
  });

  it("binds nothing when the reference names a policy of another space, as the gateway does", () => {
    // Same manifest name, another space: `bound_policy` requires the URN's space segment to be
    // the endpoint's own, so this endpoint grants nothing at all.
    expect(bindingOf(ENDPOINT, PROJECT, "ovzdusie", [ELSEWHERE], [SPACE])).toEqual({
      kind: "unbound",
      urn: URN,
    });
    expect(bindingOf(ENDPOINT, PROJECT, "ovzdusie", [], [SPACE])).toEqual({ kind: "unbound", urn: URN });
  });
});

describe("what the endpoint page says about who may call it", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("names the policy, who holds it, and what its group covers", async () => {
    show();
    const section = await grants();
    expect(within(section).getByRole("link", { name: "readers" })).toBeInTheDocument();
    expect(within(section).getByText(/role:public/)).toBeInTheDocument();
    expect(within(section).getByText("retrieveOps")).toBeInTheDocument();
    expect(within(section).getByText(en.endpoints.page.group.retrieveOps, { exact: false })).toBeInTheDocument();
    expect(within(section).getByText("retrieveEntity, queryEntity")).toBeInTheDocument();
    expect(within(section).getByText("Covers 2 operations")).toBeInTheDocument();
    expect(within(section).getByText(en.endpoints.page.policyReads)).toBeInTheDocument();
  });

  it("marks a grant that can change data as one, and does not mark a read", async () => {
    const writing = manifest("Endpoint", NAME, {
      contextSpaceRef: "ovzdusie",
      slug: SLUG,
      policyRef: "urn:ngsi-ld:Policy:banskabystrica.sk:ovzdusie:writers",
    });
    show({ endpoint: writing, policies: [WRITERS] });
    const section = await grants();
    expect(within(section).getByText(en.endpoints.page.policyWrites)).toBeInTheDocument();
    expect(within(section).queryByText(en.endpoints.page.policyReads)).toBeNull();
    expect(within(section).getByText("updateEntity, updateAttrs, replaceEntity, replaceAttrs")).toBeInTheDocument();
  });

  // T-2751: a single operation was printed twice, as a chip and again as text beside it.
  it("names a single operation once", async () => {
    const single = manifest("Policy", "readers", {
      contextSpaceRef: "ovzdusie",
      assignee: { kind: "role", id: "public" },
      operations: ["queryEntity"],
    });
    show({ policies: [single] });
    const section = await grants();
    expect(within(section).getAllByText("queryEntity")).toHaveLength(1);
    expect(within(section).getByText(en.endpoints.page.operationSingle)).toBeInTheDocument();
  });

  it("does not list another App's grant among who may call this endpoint", async () => {
    const noRef = manifest("Endpoint", NAME, { contextSpaceRef: "ovzdusie", slug: SLUG });
    const other = manifest("Policy", "app-hsl-transport-1", {
      contextSpaceRef: "ovzdusie",
      assignee: { kind: "role", id: `endpoint:${PROJECT}/app-hsl-transport` },
      operations: ["queryEntity"],
    });
    show({ endpoint: noRef, policies: [READERS, other] });
    const section = await grants();
    expect(within(section).getByRole("link", { name: "readers" })).toBeInTheDocument();
    expect(within(section).queryByRole("link", { name: "app-hsl-transport-1" })).toBeNull();
  });

  it("says an endpoint grants nothing when its reference resolves to no policy", async () => {
    show({ policies: [ELSEWHERE] });
    const section = await grants();
    const said = within(section).getByRole("status");
    expect(said).toHaveTextContent(URN);
    // And no grant is drawn from the space's other policies, which is what the gateway would do.
    expect(within(section).queryByText("retrieveOps")).toBeNull();
  });

  it("has no axe violation and shows no raw key in any locale the organisation offers", async () => {
    for (const locale of SUPPORTED_LOCALES) {
      await i18n.changeLanguage(locale);
      const view = show();
      const section = await grants();
      expectNoRawKeys(section);
      // The group's own name is the standard's and is never translated; the sentence beside it is.
      expect(within(section).getByText("retrieveOps")).toBeInTheDocument();
      expect(
        within(section).getByText(i18n.t("endpoints.page.group.retrieveOps"), { exact: false }),
      ).toBeInTheDocument();
      await expectNoViolations(section);
      view.unmount();
      vi.unstubAllGlobals();
    }
    await i18n.changeLanguage("en");
  });
});
