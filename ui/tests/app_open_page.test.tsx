/**
 * An App opens inside the Portal (T-2689, AP-122, UI-44): the page frames the App's own address in
 * a sandbox without top navigation, offers it in a window of its own, and shows the state of an App
 * that has nothing to open instead of a frame. The App's own page and the catalog link here.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import i18n from "../src/i18n";
import { AuthProvider } from "../src/auth/AuthProvider";
import { AppOpenPage, OpenAppButton } from "../src/pages/apps/AppOpenPage";

const PROJECT = "helsinki";
const COMMIT = "4f2a9c1e0b7d3a5f6c8e9d0a1b2c3d4e5f6a7b8c";

interface Stub {
  lifecycle?: string;
  build?: Record<string, unknown> | null;
  run?: Record<string, unknown> | null;
  status?: number;
}

function manifest(name: string, { lifecycle = "published", build = { commit: COMMIT } }: Stub) {
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "App",
    metadata: { name, namespace: PROJECT, title: { en: "City bikes", sk: "Mestské bicykle" } },
    spec: { kind: "static", visibility: "internal", lifecycle, dataNeeds: [] },
    status: build ? { build } : {},
  };
}

function renderAt(path: string, stub: Stub = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL((input as Request).url, "http://localhost");
      const json = (body: unknown, status = 200) =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json" },
          }),
        );
      if (url.pathname.endsWith("/auth/me")) return json({ subject: "s1", username: "steward", roles: [] });
      const build = /\/apps\/([^/]+)\/build$/.exec(url.pathname);
      if (build) {
        return json({ repositoryUrl: null, packageUrl: null, run: stub.run ?? null, rebuild: { allowed: false } });
      }
      const app = /\/apps\/([^/]+)$/.exec(url.pathname);
      if (app) {
        if (stub.status) return json({ title: "Not Found", status: stub.status, detail: "app 'x' not found" }, stub.status);
        return json(manifest(app[1], stub));
      }
      return json({ items: [] });
    }),
  );
  const root = createRootRoute({ component: Outlet });
  const open = createRoute({
    getParentRoute: () => root,
    path: "/projects/$project/$plural/$name/open",
    component: function Open() {
      const { project, name } = open.useParams();
      return <AppOpenPage project={project} name={name} />;
    },
  });
  const detail = createRoute({
    getParentRoute: () => root,
    path: "/projects/$project/$plural/$name",
    component: function Detail() {
      const { project, name } = detail.useParams();
      return <OpenAppButton project={project} name={name} />;
    },
  });
  const router = createRouter({ routeTree: root.addChildren([open, detail]) });
  window.history.pushState({}, "", path);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nextProvider i18n={i18n}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("AppOpenPage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("frames the App's own address in a sandbox without top navigation", async () => {
    renderAt(`/projects/${PROJECT}/apps/city-bikes/open`);
    const frame = await screen.findByTitle("City bikes, the application");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe("/apps/city-bikes/");
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-forms allow-popups allow-downloads",
    );
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.getByRole("heading", { level: 1, name: "City bikes" })).toBeTruthy();
    expect(screen.getByText("Serving commit 4f2a9c1")).toBeTruthy();
  });

  it("opens the same address in a new window with no opener", async () => {
    renderAt(`/projects/${PROJECT}/apps/city-bikes/open`);
    const link = await screen.findByRole("link", { name: /Open in new window/ });
    expect(link.getAttribute("href")).toBe("/apps/city-bikes/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("escapes a name into the address instead of leaving the apps path", async () => {
    renderAt(`/projects/${PROJECT}/apps/${encodeURIComponent("a/../../x")}/open`);
    const frame = await screen.findByTitle("City bikes, the application");
    expect(frame.getAttribute("src")).toBe("/apps/a%2F..%2F..%2Fx/");
  });

  it("shows a retired App's state and no frame", async () => {
    renderAt(`/projects/${PROJECT}/apps/old-map/open`, { lifecycle: "retired" });
    expect(await screen.findByText("This application is retired")).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("link", { name: /Open in new window/ })).toBeNull();
  });

  it("shows a published App whose build failed as failed, not as a frame answering 404", async () => {
    renderAt(`/projects/${PROJECT}/apps/city-bikes/open`, {
      build: null,
      run: { status: "completed", conclusion: "failure", commit: COMMIT, url: "https://git.example/run/1" },
    });
    expect(await screen.findByText("Build failed")).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("says the API's own sentence for an App that is not there", async () => {
    renderAt(`/projects/${PROJECT}/apps/nothing/open`, { status: 404 });
    expect(await screen.findByText(/app 'x' not found/)).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("takes the whole window through the login and back to this page when asked", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, pathname: `/projects/${PROJECT}/apps/city-bikes/open`, search: "" });
    renderAt(`/projects/${PROJECT}/apps/city-bikes/open`);
    await userEvent.click(await screen.findByRole("button", { name: "Sign in again" }));
    expect(assign).toHaveBeenCalledWith(
      `/api/v1/auth/login?redirect_to=${encodeURIComponent(`/projects/${PROJECT}/apps/city-bikes/open`)}`,
    );
  });
});

describe("OpenAppButton", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("links a served App to its page inside the Portal", async () => {
    renderAt(`/projects/${PROJECT}/apps/city-bikes`);
    const link = await screen.findByRole("link", { name: "Open app" });
    expect(link.getAttribute("href")).toBe(`/projects/${PROJECT}/apps/city-bikes/open`);
    expect(link.getAttribute("target")).toBeNull();
  });

  it("says why an App that serves nothing cannot open", async () => {
    renderAt(`/projects/${PROJECT}/apps/city-bikes`, { lifecycle: "draft", build: null });
    const button = await screen.findByRole("button", { name: "Open app" });
    await waitFor(() => expect(button.getAttribute("aria-disabled") ?? button.hasAttribute("disabled")).toBeTruthy());
    expect(screen.queryByRole("link", { name: "Open app" })).toBeNull();
  });

  it("offers nothing on a retired App", async () => {
    const view = renderAt(`/projects/${PROJECT}/apps/old-map`, { lifecycle: "retired" });
    const read = () =>
      vi.mocked(fetch).mock.calls.some(([input]) => (input as Request).url.endsWith(`/apps/old-map`));
    await waitFor(() => expect(read()).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(view.container.textContent).toBe("");
    expect(screen.queryByRole("button", { name: "Open app" })).toBeNull();
  });
});
