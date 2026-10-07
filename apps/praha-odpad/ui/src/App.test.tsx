/** The waste desk over what the app's endpoint answers (T-2786). */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { answer, NOW } from "./fixtures/odpad";
import { LOCALES } from "./locales";

const s = LOCALES.cs;
const SLUG = "wn4ry2bxc6qpz7tmk3jdh5vae2";
let asked: URL[];

function show(refuse?: string, withEndpoint = true) {
  asked = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      const url = new URL(path, "http://portal.test");
      asked.push(url);
      const type = url.searchParams.get("type");
      if (type === refuse) {
        return new Response(JSON.stringify({ title: "Forbidden", status: 403, detail: "sign in as city staff" }), { status: 403, headers: { "content-type": "application/problem+json" } });
      }
      const ids = url.searchParams.get("id")?.split(",") ?? [];
      return new Response(JSON.stringify(answer(type, ids)), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  const client = stubClient(undefined, {
    slug: withEndpoint ? SLUG : "",
    orgDomain: "praha.eu",
    space: withEndpoint ? "praha-mesto" : "elsewhere",
    transport: "origin",
    appName: "praha-odpad",
    language: "cs",
  });
  return render(
    <JcProvider client={client}>
      <App now={NOW} />
    </JcProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const table = () => screen.getByRole("table");
const codes = () => within(table()).getAllByRole("rowheader").map((cell) => cell.textContent);

describe("the waste desk", () => {
  it("shows the fullest first with the isle by name, an unread container last", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    expect(codes()[0]).toBe("0001-PAP");
    expect(codes().at(-1)).toBe("0006-PAP");
    const first = within(table()).getByRole("row", { name: /0001-PAP/ });
    expect(within(first).getByText("Vinohradská 12")).toBeInTheDocument();
    expect(within(first).getByText(new RegExp(s.fullest))).toBeInTheDocument();
    // The isles were read by the ids the containers name, never the whole type.
    expect(asked.filter((url) => url.searchParams.get("type") === "WasteContainerIsle").every((url) => url.searchParams.get("id"))).toBe(true);
  });

  it("says when an isle cannot be named and when a reading is missing", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    expect(within(within(table()).getByRole("row", { name: /=0006-X/ })).getByText(s.isleUnknown)).toBeInTheDocument();
    expect(within(within(table()).getByRole("row", { name: /0006-PAP/ })).getAllByText(s.noValue).length).toBe(2);
  });

  it("marks the longest-unread tenth beside the reading's age", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    const old = within(table()).getByRole("row", { name: /0005-GLS/ });
    expect(within(old).getByText(s.ago(200))).toBeInTheDocument();
    expect(within(old).getByText(new RegExp(s.longestUnread))).toBeInTheDocument();
  });

  it("narrows by kind, to the fullest tenth and by isle name", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByRole("combobox", { name: s.kind }), "paper");
    expect(codes()).toEqual(["0001-PAP", "0004-PAP", "0002-PAP", "0006-PAP"]);
    await userEvent.click(screen.getByRole("checkbox", { name: s.fullestOnly }));
    expect(codes()).toEqual(["0001-PAP", "0004-PAP"]);
    await userEvent.click(screen.getByRole("checkbox", { name: s.fullestOnly }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: s.kind }), "");
    await userEvent.type(screen.getByRole("searchbox", { name: s.search }), "italska");
    expect(codes()).toEqual(["0005-CRT", "0005-GLS"]);
  });

  it("downloads the table as shown, the fill in percent and the isle by name", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    let blob: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((made) => {
      blob = made as Blob;
      return "blob:odpad";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await userEvent.type(screen.getByRole("searchbox", { name: s.search }), "vinohradska");
    await userEvent.click(screen.getByRole("button", { name: s.download }));
    const lines = (await blob!.text()).trimEnd().split("\r\n");
    expect(lines[0]).toBe(s.csvHeader.join(","));
    expect(lines.slice(1).map((line) => line.split(",")[0])).toEqual(["0001-PAP", "0001-PLA"]);
    expect(lines[1]).toMatch(/,papír,95,.*,Vinohradská 12$/);
  });

  it("says why when the endpoint refuses, and when there is no endpoint", async () => {
    show("WasteContainer");
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
