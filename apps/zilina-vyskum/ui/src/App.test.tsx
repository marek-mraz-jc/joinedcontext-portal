/** The research screen over what the public endpoint of `zilina-uniza` answers (T-3140). */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { answer } from "./fixtures/works";
import { LOCALES } from "./locales";

const s = LOCALES.sk;

function show(respond?: (url: URL) => Response, withEndpoint = true) {
  const pages: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      const url = new URL(path, "http://portal.test");
      pages.push(url.searchParams.get("offset") ?? "0");
      if (respond) return respond(url);
      const body = answer(url.searchParams.get("type"), Number(url.searchParams.get("offset") ?? 0), Number(url.searchParams.get("limit") ?? 1000));
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  const client = stubClient(undefined, {
    slug: withEndpoint ? "os4quyrmvhijr3x7x4fno2jicej4ifv5" : "",
    orgDomain: "zilina.sk",
    space: withEndpoint ? "zilina-uniza" : "elsewhere",
    transport: "origin",
    appName: "zilina-vyskum",
    language: "sk",
  });
  return {
    ...render(
      <JcProvider client={client}>
        <App />
      </JcProvider>,
    ),
    pages,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const list = () => screen.getByRole("region", { name: s.list });

describe("the research screen", () => {
  it("reads every page and totals the works, their years and their journals", async () => {
    const { pages } = show();
    expect(await screen.findByText(s.works(251))).toBeInTheDocument();
    expect(pages).toEqual(["0", "200"]);
    const table = screen.getByRole("table", { name: s.perYearTable });
    expect(within(table).getByRole("row", { name: "2023 65" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: s.topSeries })).toHaveTextContent("Práce a štúdie");
  });

  it("lists the newest first, 25 at a time, and narrows by kind, year and search", async () => {
    show();
    await screen.findByText(s.works(251));
    expect(within(list()).getAllByRole("listitem")).toHaveLength(25);
    await userEvent.click(within(list()).getByRole("button", { name: s.more }));
    expect(within(list()).getAllByRole("listitem")).toHaveLength(50);
    await userEvent.click(screen.getByRole("radio", { name: /^Zborník/ }));
    expect(screen.getByText(s.shown(25, 33))).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: s.pickYear }), "2023");
    await userEvent.type(screen.getByRole("searchbox", { name: s.search }), "neexistujuce slovo");
    expect(within(list()).getByText(s.none)).toBeInTheDocument();
  });

  it("links each work to its handle and shows no author", async () => {
    const { container } = show();
    await screen.findByText(s.works(251));
    const link = within(list()).getAllByRole("link")[0];
    expect(link.getAttribute("href")).toMatch(/^http:\/\/drepo\.uniza\.sk\/handle\/hdluniza\/\d+$/);
    expect(container.textContent).not.toContain("Kardoš");
    expect(screen.getByText(s.noAuthors)).toBeInTheDocument();
  });

  it("says why the endpoint refused, and that it has nothing to read without one", async () => {
    show(() => new Response(JSON.stringify({ title: "Forbidden", status: 403, detail: "no policy" }), { status: 403, headers: { "content-type": "application/problem+json" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no policy");
  });

  it("has nothing to read without an endpoint of the university's space", () => {
    show(undefined, false);
    expect(screen.getAllByRole("status")[0]).toHaveTextContent(s.noEndpoint);
  });

  it("names its source and has nothing axe finds", async () => {
    const { container } = show();
    await screen.findByText(s.works(251));
    expect(screen.getByText(s.attribution)).toBeInTheDocument();
    const found = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(found.violations.map((v) => v.id)).toEqual([]);
  });
});
