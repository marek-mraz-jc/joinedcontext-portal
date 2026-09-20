/**
 * T-2400 (UI-02, UI-11, UI-44, PF-49, PF-52, PF-62): a Role and a Group are authored through their
 * fields, not by typing a manifest into a textarea.
 *
 * Eight kinds were authored through a form built from their schema, and `Policy` joined them
 * (T-2326). `Role` and `Group` were the two left, and the two an administrator touches most: to
 * add a colleague to a group a person had to get the indentation, the `members: - user:` key and
 * the name inside `name: ""` right, and nothing checked any of it before the change was proposed.
 *
 * What the form may offer is the author's own rights: the server refuses a role that grants more
 * than its proposer holds (`permissions::within_own_rights`, PF-52), and the form says the same
 * thing in the same words before the proposal is sent. It never decides — with no permissions
 * document the lists fall back to what the API validates, because the UI is not the point of
 * enforcement (PF-51).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { SchemaForm } from "../src/components/forms/SchemaForm";
import validator from "../src/components/forms/validator";
import { queryKeys } from "../src/api/client";
import { beyondOwnRights, ownRights } from "../src/api/permissions";
import type { Effective } from "../src/api/permissions";
import { groupSchema, roleSchema, ROLE_VERBS } from "../src/schemas/kinds";
import { NewRoleDialog, fromRoleEnvelope, toRoleEnvelope } from "../src/pages/access/Roles";
import { NewGroupDialog, fromGroupEnvelope, toGroupEnvelope } from "../src/pages/access/Groups";
import type { GroupForm } from "../src/pages/access/Groups";
import en from "../src/locales/en.json";

vi.mock("../src/pages/models/MonacoSourceView", () => ({
  default: ({ value }: { value: string }) => <textarea aria-label="YAML" value={value} readOnly />,
}));

const PROJECT = "banskabystrica";
const ORG = "org";
const t = (key: string): string => i18n.t(key);

/** The permissions document a steward of one project holds. */
function effective(grants: { kinds: string[]; verbs: string[] }[]): Effective {
  return {
    bootstrap: false,
    project: PROJECT,
    grants: grants.map((rule, index) => ({
      role: `role-${index}`,
      binding: `binding-${index}`,
      scope: PROJECT,
      space: null,
      rule,
    })),
  } as unknown as Effective;
}

function stubFetch(document?: Effective) {
  const answer = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/permissions/me")) {
        return answer(document ?? { bootstrap: false, project: PROJECT, grants: [] });
      }
      return answer({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] });
    }),
  );
}

/** One form on its own, the way the dialog renders it. */
function form(schema: ReturnType<typeof groupSchema>, formData?: unknown, onChange?: (data: unknown) => void) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nextProvider i18n={i18n}>
        <SchemaForm
          schema={schema}
          formData={formData}
          onChange={(data) => onChange?.(data)}
          onSubmit={() => {}}
        />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/** The role dialog with a permissions document already in hand. */
function roleDialog(document?: Effective) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Both the document in hand and the one the API answers with: a dialog opened on a warm cache
  // and one opened cold offer the same lists.
  if (document) {
    client.setQueryData(queryKeys.permissions(PROJECT), document);
    stubFetch(document);
  }
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <NewRoleDialog project={PROJECT} open onOpenChange={() => {}} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Group form", () => {
  it("adds a colleague by filling a field, and writes the manifest the YAML wrote by hand", async () => {
    const user = userEvent.setup();
    let held: unknown;
    form(groupSchema(t), { name: "", members: [] }, (data) => {
      held = data;
    });

    await user.type(screen.getByLabelText(new RegExp(en.access.groups.field.name)), "mestski-spravcovia");
    await user.type(
      screen.getByLabelText(new RegExp(en.access.groups.field.description)),
      "The people who lead the city's projects",
    );
    await user.click(screen.getByRole("button", { name: /add/i }));
    await user.type(
      screen.getByLabelText(new RegExp(en.access.groups.field.memberUser)),
      "jana.mrazova@banskabystrica.sk",
    );

    // The manifest the textarea's example produced, to the letter: same apiVersion, same
    // organization namespace, description and one member under `members[].user`.
    expect(toGroupEnvelope(held as GroupForm)).toEqual({
      apiVersion: "joinedcontext.com/v1alpha1",
      kind: "Group",
      metadata: { name: "mestski-spravcovia", namespace: ORG },
      spec: {
        description: "The people who lead the city's projects",
        members: [{ user: "jana.mrazova@banskabystrica.sk" }],
      },
    });
  });

  it("refuses at the field what the API refuses at the door", () => {
    const schema = groupSchema(t);
    const good = { name: "mestski-spravcovia", members: [{ user: "jana@banskabystrica.sk" }] };
    expect(validator.validateFormData(good, schema).errors).toEqual([]);
    // A name that is not a name, and a member who is not an address: both said at the field,
    // where the person is, instead of as a 400 after the change was proposed.
    expect(validator.validateFormData({ ...good, name: "Mestskí Správcovia" }, schema).errors).not.toEqual([]);
    for (const user of ["jana", "jana@localhost", "jana mrazova@mesto.sk", ""]) {
      expect(
        validator.validateFormData({ ...good, members: [{ user }] }, schema).errors,
        `${user} is not an address`,
      ).not.toEqual([]);
    }
  });

  it("writes no blank description and no empty member", () => {
    const manifest = toGroupEnvelope({
      name: "mestski-spravcovia",
      description: "   ",
      members: [{ user: "jana@banskabystrica.sk" }, { user: "  " }],
    }) as { spec: { description?: string; members: unknown[] } };
    expect(manifest.spec.description).toBeUndefined();
    expect(manifest.spec.members).toEqual([{ user: "jana@banskabystrica.sk" }]);
  });

  it("is the same group in both directions", () => {
    const written: GroupForm = {
      name: "mestski-spravcovia",
      description: "The people who lead the city's projects",
      members: [{ user: "jana@banskabystrica.sk" }],
    };
    const back = fromGroupEnvelope(toGroupEnvelope(written));
    expect(back).toEqual(written);
  });

  it("names every field in all four languages", async () => {
    for (const locale of ["en", "sk", "cs", "de"] as const) {
      await i18n.changeLanguage(locale);
      const bundle = i18n.getResourceBundle(locale, "translation") as typeof en;
      const { unmount } = form(groupSchema(t), { name: "", members: [{ user: "" }] });
      for (const label of [
        bundle.access.groups.field.name,
        bundle.access.groups.field.description,
        bundle.access.groups.field.memberUser,
      ]) {
        expect(screen.getByLabelText(new RegExp(label)), `${locale}: ${label}`).toBeInTheDocument();
      }
      unmount();
    }
    await i18n.changeLanguage("en");
  });

  it("has no axe violations", async () => {
    const { container } = form(groupSchema(t), {
      name: "mestski-spravcovia",
      members: [{ user: "jana@banskabystrica.sk" }],
    });
    const results = await axe.run(container);
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  it("opens with no YAML textarea in the way", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <NewGroupDialog open onOpenChange={() => {}} />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(new RegExp(en.access.groups.field.name))).toBeInTheDocument();
    // The manifest is still reachable, in the YAML view, and it is not what the dialog opens on.
    expect(within(dialog).queryByLabelText("YAML")).toBeNull();
  });
});

describe("the Role form", () => {
  it("offers the kinds and the verbs the author holds, and nothing else", () => {
    const rights = ownRights(effective([{ kinds: ["Pipeline", "DataSource"], verbs: ["propose"] }]));
    expect(rights).toEqual({ kinds: ["DataSource", "Pipeline"], verbs: ["propose"] });

    const schema = roleSchema(t, rights.kinds, rights.verbs) as unknown as {
      properties: { rules: { items: { properties: { kinds: { items: { enum?: string[] } }; verbs: { items: { enum: string[] } } } } } };
    };
    expect(schema.properties.rules.items.properties.kinds.items.enum).toEqual(["DataSource", "Pipeline"]);
    expect(schema.properties.rules.items.properties.verbs.items.enum).toEqual(["propose"]);
  });

  it("falls back to what the API validates while no permissions document has arrived", () => {
    // PF-51: the UI is not the point of enforcement. A fresh pod answers with no grants, and a
    // bootstrap administrator holds everything; neither may leave a steward with empty lists.
    expect(ownRights(undefined)).toEqual({ kinds: [], verbs: [] });
    expect(ownRights(effective([]).bootstrap ? undefined : { bootstrap: true } as Effective)).toEqual({
      kinds: [],
      verbs: [],
    });
    const schema = roleSchema(t) as unknown as {
      properties: { rules: { items: { properties: { kinds: { items: { pattern?: string; enum?: string[] } } } } } };
    };
    expect(schema.properties.rules.items.properties.kinds.items.enum).toBeUndefined();
    expect(schema.properties.rules.items.properties.kinds.items.pattern).toBeTruthy();
    expect(beyondOwnRights(undefined, [{ kinds: ["Pipeline"], verbs: ["approve"] }])).toEqual([]);
    expect(
      beyondOwnRights({ bootstrap: true, project: PROJECT, grants: [] } as unknown as Effective, [
        { kinds: ["Pipeline"], verbs: ["approve"] },
      ]),
    ).toEqual([]);
  });

  it("names every verb on every kind the role would grant beyond its author's rights", () => {
    const document = effective([{ kinds: ["Pipeline"], verbs: ["propose", "read"] }]);
    expect(beyondOwnRights(document, [{ kinds: ["Pipeline"], verbs: ["propose"] }])).toEqual([]);
    expect(beyondOwnRights(document, [{ kinds: ["Pipeline"], verbs: ["approve"] }])).toEqual([
      "approve on Pipeline",
    ]);
    expect(
      beyondOwnRights(document, [{ kinds: ["Pipeline", "DataSource"], verbs: ["propose", "delete"] }]),
    ).toEqual(["delete on Pipeline", "propose on DataSource", "delete on DataSource"]);
    // The same pair twice is one sentence, not two.
    expect(
      beyondOwnRights(document, [
        { kinds: ["DataSource"], verbs: ["propose"] },
        { kinds: ["DataSource"], verbs: ["propose"] },
      ]),
    ).toEqual(["propose on DataSource"]);
  });

  it("keeps a constraint the author's own grant carries, as the server does", () => {
    // `within_own_rights` holds a grant only when every constraint of the held rule is in the new
    // one: dropping the constraint widens the grant, which is the escalation it refuses (PF-52).
    const narrow = effective([
      { kinds: ["Endpoint"], verbs: ["propose"] },
    ]);
    (narrow.grants[0] as unknown as { rule: { constraints: unknown[] } }).rule.constraints = [
      { field: "spec.audience", equals: "project-list" },
    ];
    expect(beyondOwnRights(narrow, [{ kinds: ["Endpoint"], verbs: ["propose"] }])).toEqual([
      "propose on Endpoint",
    ]);
    expect(
      beyondOwnRights(narrow, [
        {
          kinds: ["Endpoint"],
          verbs: ["propose"],
          constraints: [{ field: "spec.audience", equals: "project-list" }],
        },
      ]),
    ).toEqual([]);
  });

  it("refuses at the field a rule that names no kind or no verb", () => {
    const schema = roleSchema(t);
    expect(
      validator.validateFormData(
        { name: "pipeline-editor", rules: [{ kinds: ["Pipeline"], verbs: ["propose"] }] },
        schema,
      ).errors,
    ).toEqual([]);
    for (const rules of [[], [{ kinds: [], verbs: ["propose"] }], [{ kinds: ["Pipeline"], verbs: [] }]]) {
      expect(validator.validateFormData({ name: "pipeline-editor", rules }, schema).errors).not.toEqual([]);
    }
    // A kind is written as the manifest writes it, which is what jc-core validates.
    expect(
      validator.validateFormData({ name: "pipeline-editor", rules: [{ kinds: ["pipeline"], verbs: ["propose"] }] }, schema)
        .errors,
    ).not.toEqual([]);
  });

  it("keeps the constraints a stored rule came with, so editing one rule drops nothing", () => {
    const stored = {
      metadata: { name: "endpoint-editor" },
      spec: {
        rules: [
          {
            kinds: ["Endpoint"],
            verbs: ["propose"],
            constraints: [{ field: "spec.audience", equals: "project-list" }],
          },
        ],
      },
    };
    const edited = toRoleEnvelope(PROJECT, fromRoleEnvelope(stored)) as {
      spec: { rules: { constraints?: unknown[] }[] };
    };
    expect(edited.spec.rules[0].constraints).toEqual([{ field: "spec.audience", equals: "project-list" }]);
    // And a rule that never had one is written without an empty list.
    const plain = toRoleEnvelope(PROJECT, { name: "r", rules: [{ kinds: ["Pipeline"], verbs: ["read"] }] }) as {
      spec: { rules: { constraints?: unknown[] }[] };
    };
    expect(plain.spec.rules[0].constraints).toBeUndefined();
  });

  it("refuses a role beyond the author's rights on the button, with the reason, before it is sent", async () => {
    const user = userEvent.setup();
    // What a steward of one project often holds: proposing pipelines here, approving data sources.
    // The lists then offer both kinds and both verbs, so the fields alone can compose a pair the
    // author does not hold — `approve on Pipeline` — which is what the server refuses (PF-52).
    roleDialog(
      effective([
        { kinds: ["Pipeline"], verbs: ["propose"] },
        { kinds: ["DataSource"], verbs: ["approve"] },
      ]),
    );

    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: en.access.projectRoles.propose });
    expect(submit).toBeEnabled();

    await user.type(
      within(dialog).getByLabelText(new RegExp(en.access.projectRoles.field.name)),
      "pipeline-approver",
    );
    const kindsField = await waitFor(() => {
      const found = window.document.querySelector<HTMLSelectElement>("select#root_rules_0_kinds");
      expect(found, "the kinds of a rule are a list of what the author holds").not.toBeNull();
      return found as HTMLSelectElement;
    });
    await user.selectOptions(kindsField, ["Pipeline"]);
    await user.selectOptions(
      window.document.querySelector("select#root_rules_0_verbs") as HTMLSelectElement,
      ["approve"],
    );

    // The button says which verb on which kind is missing, in the person's own language, and the
    // reason stays reachable on the control instead of hanging off a hard-disabled button.
    const refused = within(dialog).getByRole("button", { name: en.access.projectRoles.propose });
    const reason = i18n.t("access.projectRoles.beyondRights", { missing: "approve on Pipeline" });
    expect(refused).toHaveAttribute("aria-disabled", "true");
    expect(refused.getAttribute("title")).toBe(reason);
    expect(reason).toContain("approve on Pipeline");

    // And the pair the author does hold is proposable: the refusal is about the rights, not
    // about the form.
    const verbs = window.document.querySelector("select#root_rules_0_verbs") as HTMLSelectElement;
    await user.deselectOptions(verbs, ["approve"]);
    await user.selectOptions(verbs, ["propose"]);
    // The pair the author does hold leaves the rights refusal behind. What the button says next is
    // the Check this form asks of every kind, not a word about the rules.
    await waitFor(() => {
      const after = within(dialog).getByRole("button", { name: en.access.projectRoles.propose });
      expect(after.getAttribute("title") ?? "").not.toContain("approve on Pipeline");
    });
  });

  it("says the name and the rules in all four languages", async () => {
    for (const locale of ["en", "sk", "cs", "de"] as const) {
      await i18n.changeLanguage(locale);
      const bundle = i18n.getResourceBundle(locale, "translation") as typeof en;
      const { unmount } = form(roleSchema(t, [], ROLE_VERBS), {
        name: "",
        rules: [{ kinds: ["Pipeline"], verbs: ["propose"] }],
      });
      expect(
        screen.getByLabelText(new RegExp(bundle.access.projectRoles.field.name)),
        locale,
      ).toBeInTheDocument();
      expect(
        screen.getAllByText(new RegExp(bundle.access.projectRoles.field.rules)).length,
        locale,
      ).toBeGreaterThan(0);
      unmount();
    }
    await i18n.changeLanguage("en");
  });

  it("has no axe violations", async () => {
    const { container } = form(roleSchema(t, ["Pipeline"], ["propose"]), {
      name: "pipeline-editor",
      rules: [{ kinds: ["Pipeline"], verbs: ["propose"] }],
    });
    const results = await axe.run(container);
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});
