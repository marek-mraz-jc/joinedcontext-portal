/**
 * The reason a viewer cannot create, on screen (T-4263, UI-44, PF-50): the guard's reason was a
 * tooltip only, so a row of greyed create buttons, an enabled "Import rows", a live upload form and
 * a red "no create form" warning met a read-only role with nothing it could read on why.
 */
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../src/locales/en.json";
import sk from "../src/locales/sk.json";
import { proposesAnything } from "../src/api/permissions";
import type { Effective } from "../src/api/permissions";
import { renderRoute } from "./pageHarness";

const VIEWER = { project: "helsinki", bootstrap: false, grants: [] };
const SPACE_EDITOR = {
  project: "helsinki",
  bootstrap: false,
  grants: [{ role: "space-editor", binding: "editors", rule: { kinds: ["ContextSpace"], verbs: ["propose"] } }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("the may-not-create line", () => {
  it("says under the spaces header why its actions are greyed", async () => {
    await renderRoute({ path: "/projects/helsinki/spaces", permissions: VIEWER });
    expect(await screen.findByText(en.form.mayNotCreate)).toBeVisible();
  });

  it("says it in the person's language", async () => {
    await renderRoute({ path: "/projects/helsinki/knowledge", permissions: VIEWER, locale: "sk" });
    expect(await screen.findByText(sk.form.mayNotCreate)).toBeVisible();
  });

  it("is absent for a role that may create there, and while the role is unknown", async () => {
    await renderRoute({ path: "/projects/helsinki/spaces", permissions: SPACE_EDITOR });
    await screen.findByRole("heading", { level: 1, name: en.spaces.title });
    await waitFor(() => expect(screen.queryByText(en.form.mayNotCreate)).toBeNull());
  });
});

describe("the space pages that create for a viewer", () => {
  it("shows the reason on the completion page in place of its inputs", async () => {
    await renderRoute({ path: "/projects/helsinki/spaces/complete", permissions: VIEWER });
    expect((await screen.findByText(en.form.mayNotCreate)).closest("[role=status]")).not.toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: en.spaces.complete.title })).toBeNull();
  });

  it("shows the reason on the upload page in place of its file picker", async () => {
    await renderRoute({ path: "/projects/helsinki/spaces/upload", permissions: VIEWER });
    expect((await screen.findByText(en.form.mayNotCreate)).closest("[role=status]")).not.toBeNull();
    expect(screen.queryByText(en.spaces.upload.choose)).toBeNull();
  });

  it("keeps the upload page for a role that may propose a space", async () => {
    await renderRoute({ path: "/projects/helsinki/spaces/upload", permissions: SPACE_EDITOR });
    expect(await screen.findByText(en.spaces.upload.choose)).toBeInTheDocument();
    expect(screen.queryByText(en.form.mayNotCreate)).toBeNull();
  });
});

describe("proposesAnything", () => {
  const doc = (grants: unknown[], bootstrap = false) => ({ project: "helsinki", bootstrap, grants }) as unknown as Effective;

  it("is false for a role with no propose grant", () => {
    expect(proposesAnything(doc([]))).toBe(false);
    expect(proposesAnything(doc([{ rule: { kinds: ["Endpoint"], verbs: ["read"] } }]))).toBe(false);
  });

  it("is true for one propose grant, for a bootstrap administrator and with no document", () => {
    expect(proposesAnything(doc([{ rule: { kinds: ["App"], verbs: ["read", "propose"] } }]))).toBe(true);
    expect(proposesAnything(doc([], true))).toBe(true);
    expect(proposesAnything(undefined)).toBe(true);
  });
});
