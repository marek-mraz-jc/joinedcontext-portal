/**
 * T-2719, AG-91: the assistant turns on from any page in one keystroke. Ctrl/Cmd+K opens it on
 * its text box with the last capabilities and endpoints of the project, a second press closes
 * it, and nothing is sent by either; the endpoints the data bar offers are read while the page
 * is idle, so opening does not wait for them.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { RouterProvider, createRootRoute, createRouter } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { AssistantDock } from "../src/assistant/AssistantDock";
import { rememberCapabilities } from "../src/assistant/Capabilities";
import { rememberEndpoints } from "../src/assistant/EndpointPicker";
import { rememberRun } from "../src/assistant/state";

const PROJECT = "helsinki";

function renderDock() {
  const requests: { method: string; path: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url, "http://localhost");
      requests.push({ method: request.method, path: url.pathname });
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
      if (url.pathname.endsWith("/auth/me")) return json({ subject: "s", username: "demo.steward", roles: ["domain-editor"] });
      if (url.pathname.endsWith("/endpoints")) {
        return json({
          apiVersion: "joinedcontext.com/v1alpha1",
          kind: "List",
          items: [{ apiVersion: "joinedcontext.com/v1alpha1", kind: "Endpoint", metadata: { name: "bikes", project: PROJECT }, spec: { slug: "bikes-slug" } }],
        });
      }
      return json({});
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <AssistantDock project={PROJECT} /> });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={createRouter({ routeTree: rootRoute })} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { requests };
}

const composer = () => screen.queryByLabelText(en.assistant.empty.composer);
const writes = (requests: { method: string }[]) => requests.filter((request) => request.method !== "GET");

beforeEach(async () => {
  rememberRun(null);
  window.sessionStorage.clear();
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  rememberRun(null);
});

describe("one keystroke from any page (T-2719)", () => {
  it("Ctrl+K opens on the text box and a second press closes; Cmd+K does the same; nothing is sent", async () => {
    const { requests } = renderDock();
    const person = userEvent.setup();
    await screen.findByRole("button", { name: en.assistant.open });
    await person.keyboard("{Control>}k{/Control}");
    await waitFor(() => expect(composer()).toHaveFocus());
    await person.keyboard("{Control>}k{/Control}");
    await waitFor(() => expect(composer()).toBeNull());
    await person.keyboard("{Meta>}k{/Meta}");
    await waitFor(() => expect(composer()).toHaveFocus());
    // K alone is typing, and Ctrl+Shift+K is somebody else's shortcut.
    await person.keyboard("k{Control>}{Shift>}k{/Shift}{/Control}");
    expect(composer()).toBeInTheDocument();
    expect(writes(requests)).toEqual([]);
  });

  it("the bubble opens on the text box too, and says its shortcut", async () => {
    renderDock();
    const person = userEvent.setup();
    const bubble = await screen.findByRole("button", { name: en.assistant.open });
    expect(bubble).toHaveAttribute("aria-keyshortcuts", "Control+K Meta+K");
    await person.click(bubble);
    await waitFor(() => expect(composer()).toHaveFocus());
  });

  it("opens with the last capabilities and endpoints of the project already set", async () => {
    rememberEndpoints(PROJECT, ["bikes"]);
    rememberCapabilities(PROJECT, { preset: "propose", endpoints: { bikes: "readWrite" } });
    renderDock();
    const person = userEvent.setup();
    await screen.findByRole("button", { name: en.assistant.open });
    await person.keyboard("{Control>}k{/Control}");
    await waitFor(() => expect(composer()).toHaveFocus());
    expect(screen.getByRole("list", { name: en.assistant.data.chosen })).toHaveTextContent("bikes");
    expect(screen.getByRole("button", { name: new RegExp(`^${en.assistant.capabilities.button}`) })).toHaveTextContent(
      en.assistant.capabilities.presets.propose.title,
    );
  });

  it("reads the endpoints while the page is idle, before the assistant is opened", async () => {
    const { requests } = renderDock();
    await screen.findByRole("button", { name: en.assistant.open });
    expect(composer()).toBeNull();
    await waitFor(() => expect(requests.some((request) => request.path.endsWith(`/projects/${PROJECT}/endpoints`))).toBe(true), {
      timeout: 3000,
    });
  });

  it("a run remembered on arrival opens the panel without taking the focus", async () => {
    rememberRun({ project: PROJECT, runId: "01J8ZQ4T7K9M2N3P4Q5R6S7T8V" });
    renderDock();
    await screen.findByRole("complementary");
    expect(document.activeElement).toBe(document.body);
  });
});
