/** The region's registers as grids over what the public endpoint answers (T-2784). */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { JcProvider, projectRow, toRichRow } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { ALL, answer } from "./fixtures/registre";
import { COLUMNS, DATASETS, TYPE_OF } from "./datasets";
import type { Dataset } from "./datasets";
import { LOCALES } from "./locales";

const s = LOCALES.sk;
const SLUG = "tw3jx6pcam2qzk7nre5bdv4yfh";
let asked: URL[];

function show(withEndpoint = true, endpoints?: { name: string; slug: string; space: string; types: string[] }[]) {
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
  // The grid reads through `fetch`, the entity panel through the client: the same rows on both.
  const client = stubClient({ entities: ALL.map((entity) => projectRow(toRichRow(entity, "sk"), "sk")) }, {
    slug: withEndpoint ? SLUG : "",
    orgDomain: "bbsk.sk",
    space: withEndpoint ? "bbsk-registre" : "elsewhere",
    transport: "origin",
    appName: "bbsk-data",
    language: "sk",
    ...(endpoints ? { endpoints } : {}),
    portal: "https://portal.bbsk.sk/projects/bbsk",
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

  it("moves back with the left arrow, to the first with Home, and ignores other keys", async () => {
    show();
    screen.getByRole("tab", { name: s.dataset.hospitals }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: s.dataset.areas })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: s.dataset.hospitals })).toHaveFocus();
    await userEvent.keyboard("a");
    expect(screen.getByRole("tab", { name: s.dataset.hospitals })).toHaveAttribute("aria-selected", "true");
  });

  it("opens a row by its name in the SDK's panel, links it to the Portal and offers no edit", async () => {
    show();
    const panel = screen.getByRole("tabpanel", { name: s.dataset.hospitals });
    fireEvent.click(await within(panel).findByRole("button", { name: "Nemocnica Zvolen" }));
    const dialog = await screen.findByRole("dialog", { name: "Nemocnica Zvolen" });
    expect(await within(dialog).findByText("Kuzmányho nábrežie 28, Zvolen")).toBeInTheDocument();
    const link = within(dialog).getByRole("link", { name: "Otvoriť v Portáli" });
    expect(link).toHaveAttribute("href", expect.stringContaining(`entityId=${encodeURIComponent(ALL[1].id)}`));
    // Following the link leaves the App; jsdom does not navigate, so the click is only seen to reach it.
    const followed = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener("click", followed);
    fireEvent.click(link);
    expect(followed).toHaveBeenCalledTimes(1);
    expect(within(dialog).queryByRole("button", { name: /upraviť|edit/i })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Zavrieť" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reads the register space through the endpoint the Portal names for it and opens a row from it", async () => {
    show(false, [{ name: "registre", slug: SLUG, space: "bbsk-registre", types: [] }]);
    const panel = screen.getByRole("tabpanel", { name: s.dataset.hospitals });
    fireEvent.click(await within(panel).findByRole("button", { name: "Nemocnica Zvolen" }));
    const dialog = await screen.findByRole("dialog", { name: "Nemocnica Zvolen" });
    expect(await within(dialog).findByText("Kuzmányho nábrežie 28, Zvolen")).toBeInTheDocument();
    expect(asked.every((url) => url.pathname.startsWith(`/api/endpoint/${SLUG}/`))).toBe(true);
  });

  // Every control of every register's grid is one a reader uses: each sorts, shows its details,
  // and narrows at the endpoint with its own `q`; the downloads are the register's own files.
  it.each(DATASETS)("%s: every column sorts, shows its details and filters at the endpoint", async (dataset: Dataset) => {
    const clipboard = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: clipboard } });
    show();
    fireEvent.click(screen.getByRole("tab", { name: s.dataset[dataset] }));
    const panel = screen.getByRole("tabpanel", { name: s.dataset[dataset] });
    // Every row opens by its name in the shell's panel.
    for (const row of answer(TYPE_OF[dataset]) as { id: string; name?: { languageMap: { sk: string } } }[]) {
      // A row without a name opens by its identifier, and the panel names it by its last part.
      fireEvent.click(await within(panel).findByRole("button", { name: row.name?.languageMap.sk ?? row.id }));
      const dialog = await screen.findByRole("dialog", { name: row.name?.languageMap.sk ?? row.id.slice(row.id.lastIndexOf(":") + 1) });
      fireEvent.click(within(dialog).getByRole("button", { name: "Zavrieť" }));
    }

    for (const format of [s.csv, s.geojson]) {
      const link = within(panel).getByRole("link", { name: `${format} ${s.dataset[dataset]}` });
      expect(link).toHaveAttribute("download");
      const kept = vi.fn((event: Event) => event.preventDefault());
      link.addEventListener("click", kept);
      fireEvent.click(link);
      expect(kept).toHaveBeenCalledTimes(1);
    }

    for (const attr of COLUMNS[dataset]) {
      const label = s.column[attr];
      fireEvent.click(within(panel).getByRole("button", { name: `${s.grid.sortPage} ${label}` }));
      await waitFor(() => expect(within(panel).getByRole("button", { name: `${s.grid.sortPage} ${label}` })).toHaveTextContent(/[↑↓]/));

      fireEvent.click(within(panel).getByRole("button", { name: `${s.grid.showMetadata} ${attr}` }));
      // Each detail adds a column of its own and takes it away again, so the grid ends as it began.
      const menu = () => within(panel).getAllByRole("checkbox").filter((one) => one.closest(".jc-grid-meta-menu"));
      const sorts = () => within(panel).getAllByRole("button", { name: new RegExp(`^${s.grid.sortPage} `) }).length;
      for (const at of menu().keys()) {
        const columns = sorts();
        fireEvent.click(menu()[at]);
        expect(sorts()).toBe(columns + 1);
        fireEvent.click(menu()[at]);
        expect(sorts()).toBe(columns);
      }
      fireEvent.click(within(panel).getByRole("button", { name: `${s.grid.showMetadata} ${attr}` }));

      const before = asked.length;
      const op = within(panel).getByRole("combobox", { name: `${s.grid.filter}: ${label}` }) as HTMLSelectElement;
      fireEvent.change(op, { target: { value: op.options[1].value } });
      const many = within(panel).queryByRole("listbox", { name: `${s.grid.value}: ${label}` }) as HTMLSelectElement | null;
      if (many) {
        many.options[0].selected = true;
        fireEvent.change(many);
      }
      for (const field of within(panel).queryAllByRole("textbox").concat(within(panel).queryAllByRole("spinbutton"))) {
        if (!field.getAttribute("aria-label")?.endsWith(`: ${label}`)) continue;
        fireEvent.change(field, { target: { value: field.getAttribute("type") === "number" ? "1" : "a" } });
      }
      for (const field of Array.from(panel.querySelectorAll<HTMLInputElement>('input[type="date"]'))) {
        fireEvent.change(field, { target: { value: "2026-01-01" } });
      }
      await waitFor(() => expect(asked.slice(before).some((url) => (url.searchParams.get("q") ?? "").includes(attr))).toBe(true));
      fireEvent.change(op, { target: { value: "" } });
    }

    fireEvent.click(within(panel).getByRole("button", { name: s.grid.copyQuery }));
    expect(clipboard).toHaveBeenCalledTimes(1);
    fireEvent.click(within(panel).getByRole("checkbox", { name: s.grid.editAsText }));
    const typed = within(panel).getByRole("textbox", { name: s.grid.query });
    fireEvent.change(typed, { target: { value: 'name~=".*a.*"' } });
    await waitFor(() => expect(asked.some((url) => url.searchParams.get("q") === 'name~=".*a.*"')).toBe(true));
    // A register of eleven columns, each filter waiting for its request: longer than one click.
  }, 20_000);
});

