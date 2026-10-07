/** The school desk over what the app's endpoint answers (T-2782). */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { SCHOOLS } from "./fixtures/skoly";
import { LOCALES } from "./locales";

const s = LOCALES.sk;
const SLUG = "hm6ypd3qzv2xcnr7wtb4kaf5je";

function show(answer: () => Response = () => new Response(JSON.stringify(SCHOOLS), { status: 200, headers: { "content-type": "application/json" } }), withEndpoint = true) {
  vi.stubGlobal("fetch", vi.fn(async () => answer()));
  const client = stubClient(undefined, {
    slug: withEndpoint ? SLUG : "",
    orgDomain: "banskabystrica.sk",
    space: withEndpoint ? "banskabystrica-verejne" : "elsewhere",
    transport: "origin",
    appName: "banskabystrica-skoly",
    language: "sk",
  });
  return render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const table = () => screen.getByRole("table");
const rowNames = () => within(table()).getAllByRole("rowheader").map((cell) => cell.firstChild?.textContent);

describe("the school desk", () => {
  it("shows the city's figures and every school, a ratio missing where a count is", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    const tile = (label: string) => screen.getByText(label).closest("div")!;
    expect(within(tile(s.tiles.schools)).getByText("12")).toBeInTheDocument();
    expect(within(tile(s.tiles.incomplete)).getByText("1")).toBeInTheDocument();
    const missing = within(table()).getByRole("row", { name: /Stredná odborná škola/ });
    expect(within(missing).getAllByText(s.noValue).length).toBeGreaterThanOrEqual(4);
  });

  it("marks the city's highest tenth of pupils per teacher in words, not only colour", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    const flagged = within(table()).getAllByText(new RegExp(s.highest)).map((mark) => mark.closest("tr")?.querySelector("th")?.firstChild?.textContent);
    expect(flagged).toContain("Základná škola, Tatranská 10");
    expect(screen.getByText(s.tenthNote)).toBeInTheDocument();
  });

  it("sorts by a column, says so, and keeps a missing value last", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: s.sortBy(s.column.pupils) }));
    expect(screen.getByRole("button", { name: s.sortBy(s.column.pupils) }).closest("th")).toHaveAttribute("aria-sort", "descending");
    expect(rowNames()[0]).toBe("Gymnázium J. G. Tajovského, Tajovského 25");
    expect(rowNames().at(-1)).toBe("Stredná odborná škola, Tajovského 30");
  });

  it("narrows by search and to complete figures", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    await userEvent.type(screen.getByRole("searchbox", { name: s.search }), "tajovskeho");
    expect(rowNames()).toEqual(["Gymnázium J. G. Tajovského, Tajovského 25", "Stredná odborná škola, Tajovského 30"]);
    await userEvent.click(screen.getByRole("checkbox", { name: s.completeOnly }));
    expect(rowNames()).toEqual(["Gymnázium J. G. Tajovského, Tajovského 25"]);
  });

  it("downloads the table as shown, a formula-looking name made harmless", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    let blob: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((made) => {
      blob = made as Blob;
      return "blob:skoly";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await userEvent.type(screen.getByRole("searchbox", { name: s.search }), "namestie");
    await userEvent.click(screen.getByRole("button", { name: s.download }));
    const text = await blob!.text();
    // The byte-order mark is what makes a spreadsheet read the file as UTF-8; text() decodes it away.
    expect(Array.from(new Uint8Array(await blob!.arrayBuffer()).slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(text.split("\r\n")[0]).toBe(s.csvHeader.join(","));
    expect(text).toContain(`"'=HYPERLINK(`);
    expect(text.trimEnd().split("\r\n")).toHaveLength(2);
  });

  it("says why when the endpoint refuses, and when there is no endpoint", async () => {
    show(() => new Response(JSON.stringify({ title: "Forbidden", status: 403, detail: "sign in as city staff" }), { status: 403, headers: { "content-type": "application/problem+json" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent(s.failed("sign in as city staff"));
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
