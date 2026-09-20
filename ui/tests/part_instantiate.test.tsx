/**
 * T-1845: the blueprint's set-up form, against the UI contract (UI-15, UI-16, UI-11).
 *
 * The survey of 2026-09-18 found no test naming this file and no axe run covering it, and this
 * is the form that writes a whole use case in one change (CC-24, CC-29). Reading it against the
 * checklist found two states that did not work: a blueprint declaring no parameters ended in a
 * sentence with nothing to press, so a card the gallery offers could not be set up at all; and
 * the submit was dimmed while the change was on its way without saying so, which is how a
 * person presses twice.
 */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import type { Manifest } from "../src/api/manifest";
import { Instantiate } from "../src/pages/flows/Instantiate";
import { expectNoRawKeys } from "./checks";
import { expectNoAxeViolations, inEveryLocale, json, problem, renderPage } from "./page_contract";

const PROJECT = "helsinki";

function blueprint(spec: Record<string, unknown> = {}): Manifest {
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "Blueprint",
    metadata: {
      name: "air-quality",
      title: { en: "Air quality" },
      description: { en: "One space, one source, one endpoint." },
    },
    spec: { version: "1.2.0", ...spec },
  } as Manifest;
}

const WITH_PARAMETERS = blueprint({
  parameterSchema: {
    type: "object",
    required: ["spaceName"],
    properties: {
      spaceName: { type: "string", title: "Space name" },
      publish: { type: "boolean", title: "Publish it" },
    },
  },
});

const CHANGE = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Change",
  metadata: { name: "chg-7", namespace: PROJECT },
  status: { lane: "yellow", phase: "PendingApproval", plan: { create: 4 } },
};

interface Flows {
  /** What `POST /flows` answers; a function holds the answer until the test lets it go. */
  post?: () => Response | Promise<Response>;
}

function form(manifest: Manifest, { post }: Flows = {}) {
  const onBack = vi.fn();
  /** Every body the page posted, read where the request still has one. */
  const sent: Record<string, unknown>[] = [];
  const rendered = renderPage(
    <Instantiate project={PROJECT} blueprint={manifest} onBack={onBack} />,
    {
      answer: async (url, request) => {
        if (request.method === "POST" && url.pathname.endsWith("/flows")) {
          sent.push(JSON.parse((await request.clone().text()) || "{}") as Record<string, unknown>);
          return post ? post() : json(CHANGE);
        }
        return undefined;
      },
    },
  );
  return { ...rendered, onBack, sent };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a blueprint that asks for parameters", () => {
  it("names the page after the blueprint and draws the form from its own schema", async () => {
    const { container } = form(WITH_PARAMETERS);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: en.flows.instantiate.title.replace("{name}", "Air quality"),
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("One space, one source, one endpoint.")).toBeInTheDocument();
    expect(await screen.findByLabelText(/Space name/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Publish it/ })).toBeInTheDocument();
    expect(screen.getByText(en.flows.instantiate.hint)).toBeInTheDocument();
    expectNoRawKeys(container);
  });

  it("proposes the change with the blueprint, its version and the answers", async () => {
    const user = userEvent.setup();
    const { sent } = form(WITH_PARAMETERS);

    await user.type(await screen.findByLabelText(/Space name/), "helsinki-air");
    await user.click(screen.getByRole("button", { name: en.flows.instantiate.submit }));

    await waitFor(() => expect(screen.getByText(/chg-7/)).toBeInTheDocument());
    expect(sent.length).toBe(1);
    expect(sent.at(-1)).toMatchObject({
      blueprint: "air-quality",
      version: "1.2.0",
      parameters: { spaceName: "helsinki-air" },
    });
  });

  // UI-01: a dimmed button that says nothing is pressed twice. `submitting` reaches the button
  // now that the submit's state travels by context instead of through rjsf's cached uiSchema
  // (T-2322, reproduced from this test), so the busy state is asserted here as well.
  it("refuses a second press while the change is on its way", async () => {
    const user = userEvent.setup();
    let answer!: () => void;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const { sent } = form(WITH_PARAMETERS, {
      post: async () => {
        await held;
        return json(CHANGE);
      },
    });

    await user.type(await screen.findByLabelText(/Space name/), "helsinki-air");
    await user.click(screen.getByRole("button", { name: en.flows.instantiate.submit }));

    // Re-queried: the form re-renders around the button while the change is in flight.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: en.flows.instantiate.submit })).toBeDisabled();
    });
    const busy = screen.getByRole("button", { name: en.flows.instantiate.submit });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy.querySelector("svg"), "the spinner is drawn").not.toBeNull();
    expect(await screen.findByLabelText(/Space name/)).toBeDisabled();
    expect(sent.length).toBe(1);
    answer();
    await waitFor(() => expect(screen.getByText(/chg-7/)).toBeInTheDocument());
  });

  it("shows the server's sentence and every rule the parameters broke", async () => {
    const user = userEvent.setup();
    form(WITH_PARAMETERS, {
      post: () => {
        const body = {
          type: "about:blank",
          title: "Unprocessable Content",
          status: 422,
          detail: "The parameters were refused.",
          errors: ["spaceName: already taken", "spaceName: must be lowercase"],
        };
        return new Response(JSON.stringify(body), {
          status: 422,
          headers: { "Content-Type": "application/problem+json" },
        });
      },
    });

    await user.type(await screen.findByLabelText(/Space name/), "Helsinki");
    await user.click(screen.getByRole("button", { name: en.flows.instantiate.submit }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The parameters were refused.")).toBeInTheDocument();
    expect(within(alert).getByText("spaceName: already taken")).toBeInTheDocument();
    expect(within(alert).getByText("spaceName: must be lowercase")).toBeInTheDocument();
  });

  it("goes back to the gallery without writing anything", async () => {
    const user = userEvent.setup();
    const { onBack } = form(WITH_PARAMETERS);

    await user.click(await screen.findByRole("button", { name: en.flows.back }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("a blueprint that asks for nothing", () => {
  // The page used to end with `noSchema` and no control at all: a blueprint the gallery offers
  // and the Portal cannot start.
  it("can still be set up, with one press", async () => {
    const user = userEvent.setup();
    const { sent } = form(blueprint());

    expect(await screen.findByText(en.flows.instantiate.noSchema)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: en.flows.instantiate.submit }));

    await waitFor(() => expect(screen.getByText(/chg-7/)).toBeInTheDocument());
    expect(sent.at(-1)).toMatchObject({ blueprint: "air-quality", version: "1.2.0", parameters: {} });
  });

  it("says why a refused set-up failed, with nothing to correct", async () => {
    const user = userEvent.setup();
    form(blueprint(), { post: () => problem(403, "Your role may not run this blueprint.") });

    await user.click(await screen.findByRole("button", { name: en.flows.instantiate.submit }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Your role may not run this blueprint.")).toBeInTheDocument();
    expect(within(alert).queryByRole("listitem")).toBeNull();
  });
});

describe("the form as a screen reader and a translator find it", () => {
  it("has no axe violations, with parameters and without", async () => {
    const withFields = form(WITH_PARAMETERS);
    await screen.findByLabelText(/Space name/);
    await expectNoAxeViolations(withFields.container);
    withFields.unmount();

    const without = form(blueprint());
    await screen.findByText(en.flows.instantiate.noSchema);
    await expectNoAxeViolations(without.container);
  });

  it("draws every string of its own in all four locales", async () => {
    await inEveryLocale(async () => {
      const { container, unmount } = form(blueprint());
      await screen.findByText(i18n.t("flows.instantiate.noSchema"));
      expectNoRawKeys(container);
      expect(
        screen.getByRole("button", { name: i18n.t("flows.back") }),
      ).toBeInTheDocument();
      unmount();
    });
  });
});
