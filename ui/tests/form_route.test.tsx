/**
 * T-2474, UI-27: a bigger form is a page with its own address, not a popup.
 *
 * `/projects/{project}/{plural}/new` and `/projects/{project}/{plural}/{name}/edit` open the
 * kind's form in the list's place. The address survives a reload, the browser's back button
 * leaves the form, and leaving it by its own controls leaves the address too. The same form,
 * rendered where no route hosts it, is still the dialog it was.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { FormFrame, FormHeading } from "../src/components/forms/FormRoute";
import { answeringChecks } from "./checks";
import { findFormPage, queryFormPage } from "./formPage";
import { jsonResponse, list, renderRoute } from "./pageHarness";

const LIST = "/projects/helsinki/policies";

const POLICY = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Policy",
  metadata: { name: "open-read", namespace: "helsinki" },
  spec: {
    contextSpaceRef: { kind: "ContextSpace", name: "ovzdusie" },
    assigner: "did:web:hel.fi",
    assignee: { kind: "role", id: "public" },
    operations: ["retrieveOps"],
  },
};

const SPACE = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "ContextSpace",
  metadata: { name: "ovzdusie", namespace: "helsinki" },
  spec: {},
};

const CHANGE = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Change",
  metadata: { name: "chg-000024a4", namespace: "helsinki" },
  status: { lane: "yellow", phase: "PendingApproval", plan: { create: 0, update: 1, delete: 0 } },
};

function answer(path: string, request: Request): Response | undefined {
  if (request.method === "PUT") return jsonResponse(CHANGE, 202);
  if (path.endsWith("/policies")) return jsonResponse(list([POLICY]));
  if (path.endsWith("/spaces")) return jsonResponse(list([SPACE]));
  if (path.endsWith("/policies/open-read")) return jsonResponse(POLICY);
  return undefined;
}

const open = (path: string) => renderRoute({ path, answer });

/** The back control of the open form page. */
const back = (page: HTMLElement) => within(page).getByRole("button", { name: en.form.backToList });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a kind's forms at their own addresses", () => {
  it("opens the create form at /new, in the list's place, and goes back to the list", async () => {
    await open(`${LIST}/new`);

    const page = await findFormPage(en.policies.add);
    expect(within(page).getByRole("heading", { level: 1, name: en.policies.add })).toBeInTheDocument();
    // The list is behind the form, out of the accessibility tree.
    expect(screen.queryByRole("heading", { level: 1, name: en.policies.title })).toBeNull();

    await userEvent.click(back(page));
    await waitFor(() => expect(window.location.pathname).toBe(LIST));
    expect(queryFormPage()).toBeNull();
    expect(await screen.findByRole("heading", { level: 1, name: en.policies.title })).toBeInTheDocument();
  });

  it("moves the address when the list's own button opens the form, and the back button leaves it", async () => {
    await open(LIST);

    await userEvent.click(await screen.findByRole("button", { name: en.policies.add }));
    await waitFor(() => expect(window.location.pathname).toBe(`${LIST}/new`));
    await findFormPage(en.policies.add);

    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe(LIST));
    await waitFor(() => expect(queryFormPage()).toBeNull());
    expect(await screen.findByRole("button", { name: en.policies.add })).toBeVisible();
  });

  it("opens the same edit form again after a reload of its address", async () => {
    const first = await open(`${LIST}/open-read/edit`);
    const title = en.resourceEdit.title.replace("{name}", "open-read");
    expect(await findFormPage(title)).toBeInTheDocument();
    first.unmount();

    // A reload is a fresh Portal on the same address.
    await open(`${LIST}/open-read/edit`);
    const page = await findFormPage(title);
    expect(window.location.pathname).toBe(`${LIST}/open-read/edit`);
    expect(await within(page).findByDisplayValue("open-read")).toBeInTheDocument();
  });

  it("saves from a deep-linked edit form and lands on the list, with the change it opened", async () => {
    const { fetchMock } = await open(`${LIST}/open-read/edit`);
    vi.stubGlobal("fetch", answeringChecks(globalThis.fetch));
    const page = await findFormPage(en.resourceEdit.title.replace("{name}", "open-read"));
    await within(page).findByDisplayValue("open-read");

    await userEvent.click(within(page).getByRole("button", { name: en.resourceEdit.propose }));

    await waitFor(() => expect(window.location.pathname).toBe(LIST));
    expect(await screen.findByText(CHANGE.metadata.name)).toBeInTheDocument();
    expect(queryFormPage()).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: en.policies.title })).toBeVisible();
    const puts = fetchMock.mock.calls.filter((call) => (call[0] as Request).method === "PUT");
    expect(puts).toHaveLength(1);
    expect(new URL((puts[0][0] as Request).url).pathname).toBe("/api/v1/projects/helsinki/policies/open-read");
    // The address carried the name and nothing else: what was saved came from the form.
    expect(window.location.search).toBe("");
  });

  it("says so when the address names something the list does not hold, with a way back", async () => {
    await open(`${LIST}/no-such-policy/edit`);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(en.form.notOpen.replace("{name}", "no-such-policy"));
    await userEvent.click(screen.getByRole("button", { name: en.form.backToList }));
    await waitFor(() => expect(window.location.pathname).toBe(LIST));
    expect(await screen.findByRole("heading", { level: 1, name: en.policies.title })).toBeInTheDocument();
  });

  it("gives a kind with no page of its own for one resource the Portal's not-found page", async () => {
    await open(`${LIST}/open-read`);
    expect(await screen.findByText(en.app.notFound.title)).toBeInTheDocument();
  });
});

describe("the form's frame where no route hosts it", () => {
  it("is a dialog, with its section headings one level under the dialog's title", async () => {
    await i18n.changeLanguage("en");
    render(
      <I18nextProvider i18n={i18n}>
        <FormFrame open onOpenChange={() => undefined} title="Alone" closeLabel="Close">
          <FormHeading>Section</FormHeading>
          <FormHeading sub>Part</FormHeading>
        </FormFrame>
      </I18nextProvider>,
    );

    const dialog = await screen.findByRole("dialog", { name: "Alone" });
    expect(within(dialog).getByRole("heading", { level: 3, name: "Section" })).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { level: 4, name: "Part" })).toBeInTheDocument();
    expect(queryFormPage()).toBeNull();
  });
});
