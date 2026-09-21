/**
 * T-1759: the grant-a-role form and its list against the UI contract (UI-04, UI-15, UI-16, UI-44, UI-48).
 *
 * Two defects on main are held here, both found by reading and neither by a failing test. The
 * list filters every space-scoped grant against the names `/spaces` returns, so a failure of
 * that one request silently deleted rows from an access review: no error, no skeleton, nobody
 * told. And the dialog's two lists — the organization's roles, the project's spaces — had no
 * loading, empty or failed branch, so a slow network, a permission problem and an organization
 * with no roles all looked like a dropdown holding "Choose a role" and a button that did
 * nothing. What the form contract adds on top: an empty Propose now says which field is missing
 * instead of hard-disabling itself, and Cancel asks before throwing away what was typed.
 *
 * `checkForm` (T-1730) carries the rules every form shares. The cases below are this form's own:
 * what it sends, what it does with a red check, and what its two lists say in each state.
 *
 * The 400 px and zoom-1.5 legs of this task's `Tests:` line are not here: jsdom has no layout,
 * so a width assertion in it proves nothing. They belong to `ui/e2e` (the visual baselines) and
 * are asserted there, the way every merged form test of this group does it.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { checkForm, type FormSpec } from "./formContract";
import { expectDenied, expectNoRawKeys } from "./checks";
import { json, list, LOCALES, problem, renderPage } from "./page_contract";

// The proposed change is rendered by ChangeNotice, whose own contract is T-1751's; here it
// stands for "the change came back" and nothing more.
vi.mock("../src/components/ChangeNotice", () => ({
  ChangeNotice: ({ change }: { change: { metadata: { name: string } } }) => <p>{change.metadata.name}</p>,
}));

let mayPropose = true;
vi.mock("../src/api/permissions", () => ({
  usePermissions: () => ({ can: () => mayPropose }),
}));

const { GrantRoleDialog, RoleBindings } = await import("../src/pages/access/RoleBindings");

const API = "joinedcontext.com/v1alpha1";
const PROJECT = "helsinki";
const ROLES = "/api/v1/projects/org/roles";
const SPACES = `/api/v1/projects/${PROJECT}/spaces`;
const BINDINGS = "/api/v1/projects/org/rolebindings";
const REFUSAL = "A grant of the role steward to this person is already there.";

const role = (name: string) => ({ apiVersion: API, kind: "Role", metadata: { name }, spec: {} });
const space = (name: string) => ({ apiVersion: API, kind: "ContextSpace", metadata: { name }, spec: {} });
const binding = (name: string, scope: Record<string, string>, subject = "jana.kovacova@example.sk") => ({
  apiVersion: API,
  kind: "RoleBinding",
  metadata: { name, namespace: "org" },
  spec: { subjects: [{ user: subject }], role: "steward", scope },
});

/**
 * The roles, the spaces and the dry run: the reads the form makes before it proposes anything.
 *
 * Each override is a function, not a `Response`: a body can be read once, and React Query asks
 * again on every mount, so one instance handed out twice fails the second read for a reason that
 * has nothing to do with the form.
 */
function reads(over: { roles?: () => Response; spaces?: () => Response } = {}) {
  return (url: URL) => {
    if (url.pathname === ROLES) return over.roles?.() ?? json(list([role("steward"), role("reader")]));
    if (url.pathname === SPACES) return over.spaces?.() ?? json(list([space("citybikes")]));
    // The check before the proposal (PF-57): green unless a case says otherwise, and answered
    // here so the contract's counter sees the proposal itself and not the dry run.
    if (url.pathname === BINDINGS && url.searchParams.get("dryRun") === "All") {
      return json({ valid: true, verdict: { ok: true, findings: [] } }, 200);
    }
    return undefined;
  };
}

const spec: FormSpec = {
  fields: [
    // No ids: the dialog mints them with `useId`, and the contract reads them off the controls.
    { label: /Username or e-mail/, value: "jana.kovacova@example.sk", required: true },
    { label: /^Role/, value: "steward", required: true },
    { label: /Where it applies/, value: "organization" },
  ],
  submit: /Propose grant/,
  cancel: /Cancel/,
  submitPath: BINDINGS,
  refusal: REFUSAL,
  answer: reads(),
  path: `/projects/${PROJECT}`,
};

const dialog = () => <GrantRoleDialog project={PROJECT} open onOpenChange={() => {}} prefill={null} />;

beforeEach(async () => {
  mayPropose = true;
  await i18n.changeLanguage("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the grant dialog (T-1759)", () => {
  it("meets_the_form_contract", async () => {
    await checkForm(dialog, spec);
  });

  it("proposes_one_grant_carrying_what_was_typed", async () => {
    const bodies: unknown[] = [];
    const user = userEvent.setup();
    renderPage(dialog(), {
      path: `/projects/${PROJECT}`,
      answer: async (url, request) => {
        const own = reads()(url);
        if (own) return own;
        if (url.pathname === BINDINGS) {
          bodies.push(await request.json());
          return json({ apiVersion: API, kind: "Change", metadata: { name: "chg-1" } }, 201);
        }
        return undefined;
      },
    });
    await user.type(await screen.findByLabelText(/Username or e-mail/), "jana.kovacova@example.sk");
    await user.selectOptions(screen.getByLabelText(/^Role/), "steward");
    await user.selectOptions(screen.getByLabelText(/Where it applies/), "space:citybikes");
    await user.click(screen.getByRole("button", { name: /Propose grant/ }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      kind: "RoleBinding",
      spec: {
        subjects: [{ user: "jana.kovacova@example.sk" }],
        role: "steward",
        scope: { contextSpace: "citybikes" },
      },
    });
  });

  it("shows_what_a_red_check_found_and_proposes_nothing", async () => {
    const sent: string[] = [];
    const user = userEvent.setup();
    renderPage(dialog(), {
      path: `/projects/${PROJECT}`,
      answer: (url) => {
        if (url.pathname === ROLES) return json(list([role("steward")]));
        if (url.pathname === SPACES) return json(list([space("citybikes")]));
        if (url.pathname === BINDINGS && url.searchParams.get("dryRun") === "All") {
          return json({
            valid: false,
            verdict: { ok: false, findings: [{ message: "You do not hold steward in this project." }] },
          });
        }
        if (url.pathname === BINDINGS) {
          sent.push("proposed");
          return json({ apiVersion: API, kind: "Change", metadata: { name: "chg-1" } }, 201);
        }
        return undefined;
      },
    });
    await user.type(await screen.findByLabelText(/Username or e-mail/), "jana.kovacova@example.sk");
    await user.selectOptions(screen.getByLabelText(/^Role/), "steward");
    await user.click(screen.getByRole("button", { name: /Propose grant/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("You do not hold steward in this project.");
    expect(sent, "a red check proposed the grant anyway").toEqual([]);
  });

  it("says_the_role_list_failed_beside_the_field_it_empties", async () => {
    renderPage(dialog(), {
      path: `/projects/${PROJECT}`,
      answer: reads({ roles: () => problem(503, "The role list is not available right now.") }),
    });
    await screen.findByText(/The list could not be loaded/);
    const role_ = screen.getByLabelText(/^Role/);
    const described = (role_.getAttribute("aria-describedby") ?? "").split(/\s+/);
    const message = described
      .map((id) => document.getElementById(id))
      .find((node) => node?.textContent?.includes("The role list is not available right now."));
    expect(message, "the failure of the role list is tied to the role field").toBeTruthy();
    expect(role_, "a field whose list failed is marked").toHaveAttribute("aria-invalid", "true");
  });

  it("says_an_organization_with_no_roles_has_none_rather_than_nothing", async () => {
    renderPage(dialog(), {
      path: `/projects/${PROJECT}`,
      answer: reads({ roles: () => json(list([])) }),
    });
    expect(await screen.findByText(i18n.t("access.roles.rolesEmpty"))).toBeInTheDocument();
  });

  it("keeps_the_project_and_the_organization_choosable_when_the_space_list_fails", async () => {
    renderPage(dialog(), {
      path: `/projects/${PROJECT}`,
      answer: reads({ spaces: () => problem(503, "The space list is not available right now.") }),
    });
    await screen.findByText(/The space list is not available right now\./);
    const place = screen.getByLabelText(/Where it applies/);
    expect(within(place).getAllByRole("option").map((option) => option.textContent)).toEqual([
      `Project ${PROJECT}`,
      "The whole organization",
    ]);
  });

  it.each(LOCALES)("says_everything_in_%s_with_no_raw_key", async (locale) => {
    await i18n.changeLanguage(locale);
    const view = renderPage(dialog(), { path: `/projects/${PROJECT}`, answer: reads() });
    await screen.findByRole("dialog");
    expectNoRawKeys(view.container, ["option"]);
  });
});

describe("the role list (T-1759)", () => {
  const page = () => <RoleBindings project={PROJECT} />;

  it("names_the_grants_that_are_missing_when_the_space_list_fails", async () => {
    renderPage(page(), {
      path: `/projects/${PROJECT}`,
      answer: (url) => {
        if (url.pathname === SPACES) return problem(503, "The space list is not available right now.");
        if (url.pathname === BINDINGS) {
          return json(
            list([
              binding("org-wide", { organization: "org" }),
              binding("in-space", { contextSpace: "citybikes" }, "tomas.kral@example.sk"),
            ]),
          );
        }
        return undefined;
      },
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/grants that apply to a single space are missing/);
    expect(alert).toHaveTextContent("The space list is not available right now.");
    // The grant that is still true here is shown; the one that cannot be placed is accounted
    // for by the sentence above rather than by a row that quietly disappears.
    expect(await screen.findByText("jana.kovacova@example.sk")).toBeInTheDocument();
    expect(screen.queryByText("tomas.kral@example.sk")).toBeNull();
  });

  it("reports_a_failed_binding_list_instead_of_an_empty_table", async () => {
    renderPage(page(), {
      path: `/projects/${PROJECT}`,
      answer: (url) =>
        url.pathname === BINDINGS ? problem(500, "The role bindings could not be read.") : undefined,
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("The role bindings could not be read.");
    expect(screen.queryByRole("table"), "a failed list is not an empty table").toBeNull();
  });

  it("refuses_the_grant_button_with_its_reason_to_a_person_who_may_not_propose", async () => {
    mayPropose = false;
    renderPage(page(), { path: `/projects/${PROJECT}`, answer: () => undefined });
    expectDenied(await screen.findByRole("button", { name: /Grant a role/ }), /propose/);
  });
});
