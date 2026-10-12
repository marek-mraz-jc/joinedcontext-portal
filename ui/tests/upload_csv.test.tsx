/**
 * T-3840, DM-81: the Upload CSV page ranks the file against Smart Data Models, proposes the
 * model with the upload grant through `jc_space_complete`, and upserts the rows through the
 * gateway; an own model, a refused proposal and refused rows each say what happened.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { UploadCsv } from "../src/pages/spaces/UploadCsv";
import { expectNoRawKeys } from "./checks";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const LINKML = `id: https://smartdatamodels.org/OffStreetParking
name: OffStreetParking
classes:
  OffStreetParking:
    slots: [name, totalSpotNumber, availableSpotNumber, location]
slots:
  name: { range: string, required: true }
  totalSpotNumber: { range: integer }
  availableSpotNumber: { range: integer }
  location:
    annotations: { ngsi_ld_kind: GeoProperty }
`;

const CATALOGUE = {
  subjects: [
    {
      name: "dataModel.Parking",
      models: [
        { id: "dataModel.Parking/OffStreetParking", name: "OffStreetParking", attributes: ["name", "location", "totalSpotNumber", "availableSpotNumber", "openingHours"] },
      ],
    },
  ],
};

const CSV = "name,totalSpotNumber,availableSpotNumber,lat,lon\nKamppi,500,120,60.17,24.93\n,10,2,60.1,24.9\n";

type Calls = { url: URL; body: unknown }[];

function server(answers: { op?: () => Response; write?: () => Response } = {}): Calls {
  const calls: Calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
      const raw = input instanceof Request ? await input.clone().text() : init?.body;
      calls.push({ url, body: typeof raw === "string" && raw ? JSON.parse(raw) : undefined });
      if (url.pathname.endsWith("/organizations")) return Response.json({ items: [{ kind: "Organization", metadata: { name: "hel" }, spec: { domain: "hel.fi" } }] });
      if (url.pathname.endsWith("/spaces")) return Response.json({ kind: "List", metadata: {}, items: [] });
      if (url.pathname === "/api/v1/tools/sdm-catalog") return Response.json(CATALOGUE);
      if (url.pathname === "/api/v1/tools/import-sdm") return Response.json({ linkml: LINKML });
      if (url.pathname.endsWith("/ops/jc_space_complete")) {
        return answers.op?.() ?? Response.json({ space: "parking", found: [], drafts: [], proposeReady: true, lane: "yellow", change: null });
      }
      if (url.pathname.includes("/entityOperations/")) return answers.write?.() ?? new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    }),
  );
  return calls;
}

function page(space = "") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <UploadCsv project="helsinki" space={space} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("Upload CSV", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("proposes the ranked Smart Data Models type, then upserts the valid rows and lists the refused one", async () => {
    const calls = server();
    const user = userEvent.setup();
    const { container } = page("parking");
    await user.upload(screen.getByLabelText("Choose a CSV file"), new File([CSV], "garages.csv", { type: "text/csv" }));

    const best = await screen.findByRole("radio", { name: /OffStreetParking/ });
    expect(best).toBeChecked();
    const catalogue = calls.find((c) => c.url.pathname === "/api/v1/tools/sdm-catalog");
    expect(catalogue?.url.searchParams.get("subject")?.split(",")).toHaveLength(8);

    await user.click(screen.getByRole("button", { name: "Propose the change" }));
    await screen.findByText(/write the rows into parking as OffStreetParking/);
    const op = calls.find((c) => c.url.pathname.endsWith("/ops/jc_space_complete"))?.body as Record<string, unknown>;
    expect(op).toMatchObject({ space: "parking", typeName: "OffStreetParking", upload: true, propose: true });
    expect((op.files as { name: string }[]).map((f) => f.name)).toEqual(["garages.csv", "OffStreetParking.linkml.yaml"]);

    await user.click(screen.getByRole("button", { name: "Write 1 row" }));
    await screen.findByText("1 row written, 1 refused.");
    const write = calls.find((c) => c.url.pathname.includes("/entityOperations/"));
    expect(write?.url.pathname).toBe("/cs/parking/ngsi-ld/v1/entityOperations/upsert");
    expect((write?.body as Record<string, unknown>[])[0]).toMatchObject({
      type: "OffStreetParking",
      location: { type: "GeoProperty", value: { type: "Point", coordinates: [24.93, 60.17] } },
    });
    expect(screen.getByRole("button", { name: "Download the refused rows (CSV)" })).toBeInTheDocument();
    expectNoRawKeys(container);
  });

  it("asks for a type name when no type fits, and says why the proposal was refused", async () => {
    const calls = server({ op: () => Response.json({ detail: "no right to propose" }, { status: 403 }) });
    const user = userEvent.setup();
    page("notes");
    await user.upload(screen.getByLabelText("Choose a CSV file"), new File(["foo,bar\n1,2\n"], "notes.csv"));
    await screen.findByText(/No Smart Data Models type names enough/);
    const propose = screen.getByRole("button", { name: "Propose the change" });
    await user.type(screen.getByLabelText("Type name"), "lowercase");
    expect(propose).toHaveAttribute("aria-disabled", "true");
    await user.clear(screen.getByLabelText("Type name"));
    await user.type(screen.getByLabelText("Type name"), "Note");
    await user.click(propose);
    expect(await screen.findByRole("alert")).toHaveTextContent("no right to propose");
    expect(calls.some((c) => c.url.pathname === "/api/v1/tools/import-sdm")).toBe(false);
    const op = calls.find((c) => c.url.pathname.endsWith("/ops/jc_space_complete"))?.body as { files: unknown[] };
    expect(op.files).toHaveLength(1);
  });

  it("refuses an empty file before ranking anything", async () => {
    const calls = server();
    const user = userEvent.setup();
    page();
    await user.upload(screen.getByLabelText("Choose a CSV file"), new File(["name,lat\n"], "empty.csv"));
    expect(await screen.findByRole("alert")).toHaveTextContent("no rows");
    expect(calls.some((c) => c.url.pathname === "/api/v1/tools/sdm-catalog")).toBe(false);
  });
});
