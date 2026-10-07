/** The bridge desk over what the app's endpoint answers (T-2784). */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { BRIDGES } from "./fixtures/mosty";
import { LOCALES } from "./locales";

const s = LOCALES.sk;
const SLUG = "pk7zc3mwa5qtx2nrh6bdv4yje2";

function show(answer: () => Response = () => new Response(JSON.stringify(BRIDGES), { status: 200, headers: { "content-type": "application/json" } }), withEndpoint = true) {
  vi.stubGlobal("fetch", vi.fn(async () => answer()));
  const client = stubClient(undefined, {
    slug: withEndpoint ? SLUG : "",
    orgDomain: "bbsk.sk",
    space: withEndpoint ? "bbsk-registre" : "elsewhere",
    transport: "origin",
    appName: "bbsk-mosty",
    language: "sk",
  });
  return render(
    <JcProvider client={client}>
      <App year={2026} />
    </JcProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const table = () => screen.getByRole("table");
const rowNames = () => within(table()).getAllByRole("rowheader").map((cell) => cell.firstChild?.textContent);

describe("the bridge desk", () => {
  it("shows the region's figures and the bridges oldest first, a missing value said", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    const tile = (label: string) => screen.getByText(label).closest("div")!;
    expect(within(tile(s.tiles.bridges)).getByText("12")).toBeInTheDocument();
    expect(within(tile(s.tiles.listed)).getByText("2")).toBeInTheDocument();
    expect(rowNames()[0]).toBe("Kamenný most v Štiavnici");
    const missing = within(table()).getByRole("row", { name: /Most bez údajov/ });
    expect(within(missing).getAllByText(s.noValue).length).toBeGreaterThanOrEqual(5);
  });

  it("marks the oldest tenth in words beside the age", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    const row = within(table()).getByRole("row", { name: /Kamenný most/ });
    expect(within(row).getByText(new RegExp(s.oldest))).toBeInTheDocument();
    expect(within(row).getByText(s.years(176), { exact: false })).toBeInTheDocument();
  });

  it("narrows by district, road class, listed status and search", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByRole("combobox", { name: s.roadClass }), "firstClass");
    expect(rowNames()).toHaveLength(4);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: s.district }), "Zvolen");
    expect(rowNames()).toEqual(["Most cez Slatinu"]);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: s.district }), "");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: s.roadClass }), "");
    await userEvent.click(screen.getByRole("checkbox", { name: s.listedOnly }));
    expect(rowNames()).toEqual(["Kamenný most v Štiavnici", "Most cez Hron v Banskej Bystrici"]);
    await userEvent.click(screen.getByRole("checkbox", { name: s.listedOnly }));
    await userEvent.type(screen.getByRole("searchbox", { name: s.search }), "ssc");
    expect(rowNames()).toEqual(["Most cez Hron v Banskej Bystrici"]);
  });

  it("sorts by length and says so", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: s.sortBy(s.column.length) }));
    expect(screen.getByRole("button", { name: s.sortBy(s.column.length) }).closest("th")).toHaveAttribute("aria-sort", "descending");
    expect(rowNames()[0]).toBe("Most v Žiari");
  });

  it("downloads the table as shown, the values in words and a formula-looking name made harmless", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    let blob: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((made) => {
      blob = made as Blob;
      return "blob:mosty";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await userEvent.selectOptions(screen.getByRole("combobox", { name: s.district }), "Poltár");
    await userEvent.click(screen.getByRole("button", { name: s.download }));
    expect(Array.from(new Uint8Array(await blob!.arrayBuffer()).slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const lines = (await blob!.text()).trimEnd().split("\r\n");
    expect(lines[0]).toBe(s.csvHeader.join(","));
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.startsWith("'=CMD(),x-2,účelová"))).toBe(true);
  });

  it("says why when the endpoint refuses, and when there is no endpoint", async () => {
    show(() => new Response(JSON.stringify({ title: "Forbidden", status: 403, detail: "sign in as road staff" }), { status: 403, headers: { "content-type": "application/problem+json" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent(s.failed("sign in as road staff"));
    show(undefined, false);
    expect(screen.getAllByRole("status").some((el) => el.textContent === s.noEndpoint)).toBe(true);
  });

  it("has nothing axe finds", async () => {
    const { container } = show();
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    const found = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(found.violations.map((v) => v.id)).toEqual([]);
  });
});
