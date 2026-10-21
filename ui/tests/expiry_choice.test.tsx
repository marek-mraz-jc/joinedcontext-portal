/**
 * T-4822: "When do entities go away?" on its own, and the retention guide link it carries. Each
 * mode sets the step's `expiresAt` and the manifest's sweep together; the sweep is offered only
 * where the form holds `spec.expiry`; the guide link shows only when the installation serves a
 * guide (UI-02).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { I18nextProvider } from "react-i18next";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { BrandingProvider } from "../src/branding";
import { RETENTION_GUIDE, RetentionGuide } from "../src/components/RetentionGuide";
import { ExpiryChoice, modeOf, timeFieldOf, withFrom } from "../src/pages/pipelines/ExpiryChoice";
import type { ExpiryChoiceProps } from "../src/pages/pipelines/ExpiryChoice";

function branded(documentationBaseUrl: string | undefined): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
      const body = url.pathname.endsWith("/branding") ? { documentationBaseUrl } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

function renderIn(child: () => ReactNode) {
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({ getParentRoute: () => root, path: "/", component: child });
  const router = createRouter({ routeTree: root.addChildren([page]) });
  window.history.pushState({}, "", "/");
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <BrandingProvider>
          <RouterProvider router={router} />
        </BrandingProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

function choice(props: Partial<ExpiryChoiceProps> = {}) {
  const onMode = vi.fn();
  const onLifetime = vi.fn();
  const onExpiry = vi.fn();
  const all: ExpiryChoiceProps = {
    project: "helsinki",
    space: "mobility",
    type: "Vehicle",
    slots: ["observedOn", "validTo"],
    lifetime: undefined,
    expiry: undefined,
    onMode,
    onLifetime,
    onExpiry,
    ...props,
  };
  renderIn(() => <ExpiryChoice {...all} />);
  return { onMode, onLifetime, onExpiry };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("modeOf and timeFieldOf", () => {
  it("reads an own expiresAt first, then the sweep, else never", () => {
    expect(modeOf({ from: "observedOn", plus: "PT10M" }, { after: "1d" })).toBe("source");
    expect(modeOf({ rolling: "PT10M" }, undefined)).toBe("source");
    expect(modeOf(undefined, { after: "14d" })).toBe("stale");
    expect(modeOf(undefined, { types: ["Vehicle"] })).toBe("stale");
    expect(modeOf(undefined, {})).toBe("never");
    expect(modeOf(undefined, undefined)).toBe("never");
  });

  it("prefers observedAt, then a field named for a time, else none", () => {
    expect(timeFieldOf(["validTo", "observedAt"])).toBe("observedAt");
    expect(timeFieldOf(["id", "validDate"])).toBe("validDate");
    expect(timeFieldOf(["id", "speed"])).toBeUndefined();
  });

  it("moves between a slot and the write time and keeps the while", () => {
    expect(withFrom({ from: "observedOn", plus: "PT2H" }, undefined)).toEqual({ rolling: "PT2H" });
    expect(withFrom({ rolling: "P1D" }, "validTo")).toEqual({ from: "validTo", plus: "P1D" });
    expect(withFrom(undefined, undefined)).toEqual({ rolling: "PT10M" });
  });
});

describe("ExpiryChoice", () => {
  it("sets the bus recipe, a time slot plus 10 minutes, and clears the sweep in one change", async () => {
    branded(undefined);
    const { onMode } = choice();
    await userEvent.click(await screen.findByRole("radio", { name: /At a time the source gives/ }));
    expect(onMode).toHaveBeenCalledWith({ from: "observedOn", plus: "PT10M" }, undefined);
  });

  it("counts from the write time when no date-time attribute is mapped, and says so", async () => {
    branded(undefined);
    const { onMode } = choice({ slots: [] });
    await userEvent.click(await screen.findByRole("radio", { name: /At a time the source gives/ }));
    expect(onMode).toHaveBeenCalledWith({ rolling: "PT10M" }, undefined);
  });

  it("names the missing date-time attribute under the time choice", async () => {
    branded(undefined);
    choice({ slots: [], lifetime: { rolling: "PT10M" } });
    expect(await screen.findByText(/No date-time attribute of Vehicle is mapped yet/)).toBeTruthy();
  });

  it("sets the sweep for the written type and drops an own expiresAt", async () => {
    branded(undefined);
    const { onMode } = choice({ lifetime: { from: "observedOn", plus: "PT10M" } });
    await userEvent.click(await screen.findByRole("radio", { name: /When the source stops sending them/ }));
    expect(onMode).toHaveBeenCalledWith(undefined, { after: "14d", types: ["Vehicle"] });
  });

  it("returns to never with neither set", async () => {
    branded(undefined);
    const { onMode } = choice({ expiry: { after: "14d", types: ["Vehicle"] } });
    expect(await screen.findByText(/deleteBatch and queryBatch/)).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: /^Never/ }));
    expect(onMode).toHaveBeenCalledWith(undefined, undefined);
  });

  it("offers no sweep where the form holds no spec.expiry", async () => {
    branded(undefined);
    renderIn(() => (
      <ExpiryChoice project="helsinki" space="mobility" type="Vehicle" slots={[]} lifetime={undefined} expiry={undefined} onMode={vi.fn()} onLifetime={vi.fn()} />
    ));
    await screen.findByRole("radio", { name: /^Never/ });
    expect(screen.queryByRole("radio", { name: /When the source stops sending them/ })).toBeNull();
  });

  it("writes the added time as an ISO duration and the slot the person picks", async () => {
    branded(undefined);
    const { onLifetime } = choice({ lifetime: { from: "observedOn", plus: "PT10M" } });
    await userEvent.selectOptions(await screen.findByLabelText("Unit of the added time"), "hours");
    expect(onLifetime).toHaveBeenLastCalledWith({ from: "observedOn", plus: "PT10H" });
    await userEvent.selectOptions(await screen.findByLabelText("Time from"), "");
    expect(onLifetime).toHaveBeenLastCalledWith({ rolling: "PT10M" });
    await userEvent.selectOptions(await screen.findByLabelText("Time from"), "validTo");
    expect(onLifetime).toHaveBeenLastCalledWith({ from: "validTo", plus: "PT10M" });
  });

  it("keeps a rolling end's while when the amount is cleared to zero", async () => {
    branded(undefined);
    const { onLifetime } = choice({ lifetime: { rolling: "PT2H" } });
    const amount = await screen.findByLabelText("Plus");
    fireEvent.change(amount, { target: { value: "0" } });
    expect(onLifetime).toHaveBeenLastCalledWith({ rolling: "PT2H" });
  });

  it("says the problem with the time field at the field", async () => {
    branded(undefined);
    choice({ lifetime: { from: "observedOn" }, problem: "speed holds no time" });
    expect(await screen.findByText("speed holds no time")).toBeTruthy();
  });

  it("keeps the sweep's unit when the amount changes", async () => {
    branded(undefined);
    const { onExpiry } = choice({ expiry: { after: "2h", types: ["Vehicle"] } });
    await userEvent.selectOptions(await screen.findByLabelText("Unit of the window"), "d");
    expect(onExpiry).toHaveBeenLastCalledWith({ after: "2d", types: ["Vehicle"] });
  });
});

describe("RetentionGuide", () => {
  it("links the section of the retention guide when the installation serves a guide", async () => {
    branded("https://docs.example.org/");
    choice();
    const link = await screen.findByRole("link", { name: /Recipe: buses and live vehicles/ });
    expect(link.getAttribute("href")).toBe(`https://docs.example.org/${RETENTION_GUIDE}#4-recipe-buses-and-live-vehicles`);
  });

  it("shows no link without a documentation address", async () => {
    branded(undefined);
    renderIn(() => <RetentionGuide section="which-one-wins" />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByRole("link")).toBeNull();
  });
});
