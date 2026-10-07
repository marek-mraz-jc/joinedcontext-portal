/** Helsinki's open data as grids over what the public endpoint answers (T-2788). */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { answer } from "./fixtures/helsinki";
import { LOCALES } from "./locales";

const s = LOCALES.fi;
const SLUG = "mc4hz7tkq2vbr6xna3wjd5yep2";
let asked: URL[];

function show(withEndpoint = true) {
  asked = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      const url = new URL(path, "http://portal.test");
      asked.push(url);
      const rows = answer(url.searchParams.get("type"));
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "content-type": "application/json", "NGSILD-Results-Count": String(rows.length) },
      });
    }),
  );
  const client = stubClient(undefined, {
    slug: withEndpoint ? SLUG : "",
    orgDomain: "hel.fi",
    space: withEndpoint ? "helsinki" : "elsewhere",
    transport: "origin",
    appName: "helsinki-data",
    language: "fi",
  });
  return render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("Helsinki's datasets", () => {
  it("opens on the services, read from the endpoint by type, with the city's column labels", async () => {
    show();
    expect(screen.getByRole("tab", { name: s.dataset.services })).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel", { name: s.dataset.services });
    await waitFor(() => expect(within(panel).getByText("Keskustakirjasto Oodi")).toBeInTheDocument());
    expect(within(panel).getByRole("columnheader", { name: new RegExp(s.column.serviceCategory) })).toBeInTheDocument();
    expect(asked.some((url) => url.pathname.includes(`/api/endpoint/${SLUG}/`) && url.searchParams.get("type") === "PointOfInterest")).toBe(true);
  });

  it("moves between datasets with the arrow keys and shows each one's grid and downloads", async () => {
    show();
    screen.getByRole("tab", { name: s.dataset.services }).focus();
    await userEvent.keyboard("{ArrowRight}");
    const permits = screen.getByRole("tab", { name: s.dataset.permits });
    expect(permits).toHaveFocus();
    const panel = screen.getByRole("tabpanel", { name: s.dataset.permits });
    await waitFor(() => expect(within(panel).getByText("Kaukolämpöputken korjaus")).toBeInTheDocument());
    expect(within(panel).getByRole("link", { name: `${s.csv} ${s.dataset.permits}` })).toHaveAttribute(
      "href",
      `/api/endpoint/${SLUG}/file.csv?type=PublicAreaPermit&humanHeaders=true`,
    );
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: s.dataset.weather })).toHaveFocus();
  });

  it("says it has nothing to read when the app has no endpoint of the city's space", () => {
    show(false);
    expect(screen.getByRole("status")).toHaveTextContent(s.noEndpoint);
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("names its source and has nothing axe finds", async () => {
    const { container } = show();
    await waitFor(() => expect(screen.getByText("Keskustakirjasto Oodi")).toBeInTheDocument());
    expect(screen.getByText(s.source)).toBeInTheDocument();
    const found = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(found.violations.map((v) => v.id)).toEqual([]);
  });
});
