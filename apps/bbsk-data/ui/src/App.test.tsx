/** The region's registers as grids over what the public endpoint answers (T-2784). */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { answer } from "./fixtures/registre";
import { LOCALES } from "./locales";

const s = LOCALES.sk;
const SLUG = "tw3jx6pcam2qzk7nre5bdv4yfh";
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
    orgDomain: "bbsk.sk",
    space: withEndpoint ? "bbsk-registre" : "elsewhere",
    transport: "origin",
    appName: "bbsk-data",
    language: "sk",
  });
  return render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("the region's registers", () => {
  it("opens on the hospitals, read from the endpoint by type, with the region's column labels", async () => {
    show();
    expect(screen.getByRole("tab", { name: s.dataset.hospitals })).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel", { name: s.dataset.hospitals });
    await waitFor(() => expect(within(panel).getByText("Nemocnica Zvolen")).toBeInTheDocument());
    expect(within(panel).getByRole("columnheader", { name: new RegExp(s.column.hospitalKind) })).toBeInTheDocument();
    expect(asked.some((url) => url.pathname.includes(`/api/endpoint/${SLUG}/`) && url.searchParams.get("type") === "Hospital")).toBe(true);
  });

  it("moves between registers with the arrow keys and shows each one's grid and downloads", async () => {
    show();
    screen.getByRole("tab", { name: s.dataset.hospitals }).focus();
    await userEvent.keyboard("{ArrowRight}");
    const social = screen.getByRole("tab", { name: s.dataset.social });
    expect(social).toHaveFocus();
    expect(social).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel", { name: s.dataset.social });
    await waitFor(() => expect(within(panel).getByText("Domov sociálnych služieb Tisovec")).toBeInTheDocument());
    expect(within(panel).getByRole("link", { name: `${s.csv} ${s.dataset.social}` })).toHaveAttribute(
      "href",
      `/api/endpoint/${SLUG}/file.csv?type=SocialService&humanHeaders=true`,
    );
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: s.dataset.areas })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: s.dataset.hospitals })).toHaveFocus();
  });

  it("says it has nothing to read when the app has no endpoint of the register space", () => {
    show(false);
    expect(screen.getByRole("status")).toHaveTextContent(s.noEndpoint);
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("names its source and has nothing axe finds", async () => {
    const { container } = show();
    await waitFor(() => expect(screen.getByText("Nemocnica Zvolen")).toBeInTheDocument());
    expect(screen.getByText(s.source)).toBeInTheDocument();
    const found = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(found.violations.map((v) => v.id)).toEqual([]);
  });
});
