// The explorer's export control (T-3253): it reads the whole view through the endpoint with the
// person's session, joins the grid's filter to the page's, says when there is nothing to export,
// and a failed read says why with Retry.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { ExportView } from "../src/pages/explore/ExportView";

const E = en.explore.exportView;
const ROWS = [
  { id: "urn:ngsi-ld:BikeStation:1", type: "BikeStation", bikes: 4 },
  { id: "urn:ngsi-ld:BikeStation:2", type: "BikeStation", bikes: 9 },
];

function stub(answer: (url: URL) => Response) {
  const asked: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
      asked.push(url);
      return answer(url);
    }),
  );
  return asked;
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ...headers } });

function show(sort: { attr: string; dir: "asc" | "desc" } | null = null) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ExportView
        slug="bikes-ops"
        query={{ type: "BikeStation", attrs: ["bikes"], q: "bikes>0" }}
        grid={{ q: "bikes<10", idPattern: "^urn:ngsi-ld:BikeStation:" }}
        sort={sort}
      />
    </I18nextProvider>,
  );
}

describe("the explorer's export", () => {
  let files: Blob[];
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    files = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      files.push(blob as Blob);
      return "blob:export";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks the endpoint for the page's filter and the grid's together, and writes the view's order", async () => {
    const asked = stub(() => json(ROWS, { "NGSILD-Results-Count": "2" }));
    show({ attr: "bikes", dir: "desc" });
    await userEvent.selectOptions(screen.getByLabelText(E.format), "csv");
    await userEvent.click(screen.getByRole("button", { name: E.start }));

    await screen.findByRole("link", { name: "Download BikeStation.csv (2 rows)" });
    const params = asked[0].searchParams;
    expect(asked[0].pathname).toContain("/bikes-ops/");
    expect(params.get("q")).toBe("bikes>0;bikes<10");
    expect(params.get("idPattern")).toBe("^urn:ngsi-ld:BikeStation:");
    expect(params.get("attrs")).toBe("bikes");
    expect(await files[0].text()).toBe("id,bikes\nurn:ngsi-ld:BikeStation:2,9\nurn:ngsi-ld:BikeStation:1,4\n");
  });

  it("says there is nothing to export for an empty view, and no GeoJSON without a location", async () => {
    stub(() => json([]));
    const { unmount } = show();
    await userEvent.click(screen.getByRole("button", { name: E.start }));
    expect(await screen.findByText(E.empty)).toBeInTheDocument();
    unmount();

    stub(() => json(ROWS));
    show();
    await userEvent.selectOptions(screen.getByLabelText(E.format), "geojson");
    await userEvent.click(screen.getByRole("button", { name: E.start }));
    expect(await screen.findByText(E.noGeometry)).toBeInTheDocument();
    expect(files).toEqual([]);
  });

  it("says why a read failed and reads again on Retry", async () => {
    let calls = 0;
    stub(() => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ title: "Unavailable", status: 503, detail: "The broker did not answer." }), {
            status: 503,
            headers: { "Content-Type": "application/problem+json" },
          })
        : json(ROWS);
    });
    show();
    await userEvent.click(screen.getByRole("button", { name: E.start }));
    const alert = await screen.findByRole("alert");
    await userEvent.click(await screen.findByRole("button", { name: en.app.error.retry }));
    expect(await screen.findByRole("link", { name: /Download BikeStation\.csv/ })).toBeInTheDocument();
    expect(alert).not.toBeInTheDocument();
  });
});
