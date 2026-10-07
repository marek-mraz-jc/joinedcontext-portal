/**
 * Import and export on a space's data (T-3109, ADR-N-042 §3.6): a file read in the browser, its
 * columns mapped to the type's slots, every row checked, the valid ones created in batches through
 * the gateway with the person's session, and every refused row reported.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import i18n from "../src/i18n";
import { ExportLinks, ImportRowsDialog } from "../src/pages/spaces/ImportRows";
import {
  BATCH,
  createInBatches,
  exportUrl,
  importSlotsOf,
  parseCsv,
  parseJson,
  parseXlsx,
  parseXml,
  readTable,
  rejectedCsv,
  suggestMapping,
  toEntities,
} from "../src/pages/spaces/importRows";
import type { ImportSlot, Send } from "../src/pages/spaces/importRows";
import type { Manifest } from "../src/api/manifest";

const MODEL = `id: https://hel.fi/models/stations
name: stations
default_prefix: hel
prefixes:
  hel: https://hel.fi/models/
enums:
  StatusEnum:
    permissible_values:
      working: {}
      outOfService: {}
classes:
  BikeHireDockingStation:
    slots: [name, availableBikeNumber, status, location, refStreet, dateObserved, open]
slots:
  name: { range: string, required: true }
  availableBikeNumber: { range: integer, minimum_value: 0 }
  status: { range: StatusEnum }
  location:
    annotations: { ngsi_ld_kind: GeoProperty }
  refStreet:
    range: Street
    annotations: { ngsi_ld_kind: Relationship }
  dateObserved: { range: datetime }
  open: { range: boolean }
`;

const TYPE = "BikeHireDockingStation";
const SLOTS = importSlotsOf(MODEL, TYPE);
const TARGET = { type: TYPE, orgDomain: "hel.fi", space: "helsinki" };
const urn = (local: string) => `urn:ngsi-ld:${TYPE}:hel.fi:helsinki:${local}`;

/** Raw DEFLATE of a text, as a ZIP entry of method 8 holds it. */
async function deflated(text: string): Promise<Uint8Array> {
  const body = new Response(text).body;
  if (!body) throw new Error("a Response of a text has a body");
  return new Uint8Array(await new Response(body.pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
}

/** A ZIP of stored (uncompressed) entries, or deflated ones given as bytes, the smallest workbook a test can hold. */
function zip(files: Record<string, string | Uint8Array>, sizes: Record<string, number> = {}): Uint8Array {
  const encoder = new TextEncoder();
  const parts: number[] = [];
  const central: number[] = [];
  const u16 = (out: number[], n: number) => out.push(n & 0xff, (n >> 8) & 0xff);
  const u32 = (out: number[], n: number) => out.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
  let count = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = typeof text === "string" ? encoder.encode(text) : text;
    const method = typeof text === "string" ? 0 : 8;
    const size = sizes[name] ?? data.length;
    const offset = parts.length;
    u32(parts, 0x04034b50);
    [20, 0, method, 0, 0].forEach((n) => u16(parts, n));
    [0, data.length, size].forEach((n) => u32(parts, n));
    u16(parts, nameBytes.length);
    u16(parts, 0);
    parts.push(...nameBytes, ...data);
    u32(central, 0x02014b50);
    [20, 20, 0, method, 0, 0].forEach((n) => u16(central, n));
    [0, data.length, size].forEach((n) => u32(central, n));
    [nameBytes.length, 0, 0, 0, 0].forEach((n) => u16(central, n));
    u32(central, 0);
    u32(central, offset);
    central.push(...nameBytes);
    count += 1;
  }
  const end: number[] = [];
  u32(end, 0x06054b50);
  [0, 0, count, count].forEach((n) => u16(end, n));
  u32(end, central.length);
  u32(end, parts.length);
  u16(end, 0);
  return new Uint8Array([...parts, ...central, ...end]);
}

describe("reading a file", () => {
  it("reads CSV with quotes, doubled quotes, a semicolon separator and a BOM", () => {
    const table = parseCsv('﻿name;note\r\n"Kamppi; centre";"said ""hi"""\r\nKallio;\r\n\r\n');
    expect(table.columns).toEqual(["name", "note"]);
    expect(table.rows).toEqual([
      { name: "Kamppi; centre", note: 'said "hi"' },
      { name: "Kallio", note: "" },
    ]);
  });

  it("reads JSON lists, an object holding one, and GeoJSON features with their geometry", () => {
    expect(parseJson('[{"name":"A","n":3,"tags":["x"]}]').rows).toEqual([{ name: "A", n: "3", tags: '["x"]' }]);
    expect(parseJson('{"stations":[{"name":"B"}]}').rows).toEqual([{ name: "B" }]);
    const geo = parseJson(
      '{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"C"},"geometry":{"type":"Point","coordinates":[24.9,60.1]}}]}',
    );
    expect(geo.rows[0]).toEqual({ name: "C", location: '{"type":"Point","coordinates":[24.9,60.1]}' });
    expect(() => parseJson("{nope")).toThrow("not JSON");
    expect(() => parseJson('{"a":1}')).toThrow("no list");
  });

  it("reads XML records from the root's repeated children, attributes included", () => {
    const table = parseXml('<stations><station id="s1"><name>Kamppi</name></station><station id="s2"><name>Kallio</name></station><meta/></stations>');
    expect(table.rows).toEqual([
      { id: "s1", name: "Kamppi" },
      { id: "s2", name: "Kallio" },
    ]);
    expect(() => parseXml("<a><b></a>")).toThrow("well-formed");
  });

  it("reads the first sheet of a workbook, shared and inline strings, a skipped cell and a flag", async () => {
    const workbook = zip({
      "xl/sharedStrings.xml": '<sst><si><t>name</t></si><si><t>bikes</t></si><si><t>Kamppi</t></si></sst>',
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>open</t></is></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2" t="b"><v>1</v></c></row></sheetData></worksheet>',
    });
    const table = await parseXlsx(workbook);
    expect(table.columns).toEqual(["name", "bikes", "open"]);
    expect(table.rows).toEqual([{ name: "Kamppi", bikes: "", open: "true" }]);
  });

  it("inflates a deflated sheet, as every workbook a spreadsheet saves holds it", async () => {
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>Töölö</t></is></c></row></sheetData></worksheet>';
    const table = await parseXlsx(zip({ "xl/worksheets/sheet1.xml": await deflated(sheet) }, { "xl/worksheets/sheet1.xml": sheet.length }));
    expect(table.rows).toEqual([{ name: "Töölö" }]);
    await expect(parseXlsx(new TextEncoder().encode("not a zip"))).rejects.toThrow("not a ZIP");
  });

  it("refuses a file of another kind by name", async () => {
    await expect(readTable(new File(["x"], "rows.pdf"))).rejects.toThrow("CSV, Excel");
  });
});

describe("mapping and checking", () => {
  it("reads the slots of the class with what the model requires", () => {
    expect(SLOTS.find((s) => s.name === "name")?.required).toBe(true);
    expect(SLOTS.find((s) => s.name === "status")?.values).toEqual(["working", "outOfService"]);
    expect(SLOTS.find((s) => s.name === "location")?.kind).toBe("GeoProperty");
  });

  it("suggests each slot once, by its name up to case and separators or a Smart Data Models synonym", () => {
    expect(suggestMapping(["ID", "Title", "available_bike_number", "Name", "Geometry", "colour"], SLOTS)).toEqual({
      ID: "id",
      Title: "name",
      available_bike_number: "availableBikeNumber",
      Name: "",
      Geometry: "location",
      colour: "",
    });
  });

  it("makes one entity per valid row, every value in its slot's shape", () => {
    const table = parseCsv(
      "id,name,bikes,status,where,street,seen,open\n" +
        "s1,Kamppi,4,working,\"24.93, 60.17\",urn:ngsi-ld:Street:hel.fi:helsinki:x,2026-10-06T08:00:00Z,yes\n",
    );
    const mapping = { id: "id", name: "name", bikes: "availableBikeNumber", status: "status", where: "location", street: "refStreet", seen: "dateObserved", open: "open" };
    const { entities, rejected } = toEntities(table, mapping, SLOTS, TARGET);
    expect(rejected).toEqual([]);
    expect(entities[0]).toEqual({
      row: 2,
      entity: {
        id: urn("s1"),
        type: TYPE,
        name: { type: "Property", value: "Kamppi" },
        availableBikeNumber: { type: "Property", value: 4 },
        status: { type: "Property", value: "working" },
        location: { type: "GeoProperty", value: { type: "Point", coordinates: [24.93, 60.17] } },
        refStreet: { type: "Relationship", object: "urn:ngsi-ld:Street:hel.fi:helsinki:x" },
        dateObserved: { type: "Property", value: "2026-10-06T08:00:00.000Z" },
        open: { type: "Property", value: true },
      },
    });
  });

  it("refuses a row for every reason at once, an id of another space and a repeated id, and mints the rest", () => {
    const table = parseCsv(
      "id,name,bikes,status\n" +
        ",,-1,broken\n" +
        "urn:ngsi-ld:BikeHireDockingStation:hel.fi:espoo:s9,Tapiola,1,working\n" +
        "s2,Kallio,2.5,working\n" +
        "s3,Töölö,0,working\n" +
        "s3,Again,0,working\n" +
        "bad id,X,0,working\n",
    );
    const mapping = { id: "id", name: "name", bikes: "availableBikeNumber", status: "status" };
    const { entities, rejected } = toEntities(table, mapping, SLOTS, TARGET, () => "fresh");
    expect(entities.map((e) => e.entity.id)).toEqual([urn("s3")]);
    expect(rejected).toEqual([
      { row: 2, id: urn("fresh"), reason: "availableBikeNumber: -1 is below 0; status: `broken` is not one of working, outOfService; name is required" },
      { row: 3, reason: "`urn:ngsi-ld:BikeHireDockingStation:hel.fi:espoo:s9` names another type, organization or space than this one" },
      { row: 4, id: urn("s2"), reason: "availableBikeNumber: `2.5` is not a whole number" },
      { row: 6, id: urn("s3"), reason: "the file names this id twice" },
      { row: 7, reason: "`bad id` cannot be the last part of an id" },
    ]);
  });

  it("writes the refused rows as CSV a spreadsheet opens", () => {
    expect(rejectedCsv([{ row: 3, id: "u", reason: 'a, "b"' }])).toBe('row,id,reason\r\n3,u,"a, ""b"""');
  });
});

describe("creating through the gateway", () => {
  const entities = Array.from({ length: BATCH + 2 }, (_, at) => ({ row: at + 2, entity: { id: urn(`s${at}`), type: TYPE } }));

  it("creates in batches with the person's transport and counts a 201 whole", async () => {
    const send = vi.fn<Send>(async () => ({ status: 201 }));
    const progress: number[] = [];
    const answer = await createInBatches(send, "helsinki", entities, (sent) => progress.push(sent));
    expect(answer).toEqual({ created: BATCH + 2, rejected: [] });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toMatchObject({ method: "POST", path: "/cs/helsinki/ngsi-ld/v1/entityOperations/create" });
    expect((send.mock.calls[0][0].body as unknown[]).length).toBe(BATCH);
    expect(progress).toEqual([BATCH, BATCH + 2]);
  });

  it("reads a 207 by entity and refuses a batch the gateway refuses whole, in its words", async () => {
    const send = vi
      .fn<Send>()
      .mockResolvedValueOnce({
        status: 207,
        body: { success: [], errors: [{ entityId: urn("s1"), error: { type: "AlreadyExists", title: "Already exists" } }] },
      })
      .mockResolvedValueOnce({ status: 403, body: { detail: "you may not createEntity here" } });
    const answer = await createInBatches(send, "helsinki", entities, () => {});
    expect(answer.created).toBe(BATCH - 1);
    expect(answer.rejected[0]).toEqual({ row: 3, id: urn("s1"), reason: "Already exists" });
    expect(answer.rejected.slice(1).map((r) => r.reason)).toEqual(["you may not createEntity here", "you may not createEntity here"]);
  });

  it("refuses the batch when the request itself fails", async () => {
    const send = vi.fn<Send>(async () => {
      throw new Error("offline");
    });
    const answer = await createInBatches(send, "helsinki", entities.slice(0, 1));
    expect(answer).toEqual({ created: 0, rejected: [{ row: 2, id: urn("s0"), reason: "offline" }] });
  });
});

describe("export", () => {
  it("narrows an Endpoint's file to the type, the filter and the fields", () => {
    expect(exportUrl("abc", "csv", TYPE, 'name=="A"', ["name", "status"])).toBe(
      `/api/endpoint/abc/file.csv?type=${TYPE}&q=name%3D%3D%22A%22&attrs=name%2Cstatus`,
    );
    expect(exportUrl("abc", "json", TYPE, undefined, [])).toBe(`/api/endpoint/abc/file.json?type=${TYPE}`);
  });

  it("offers only the formats an Endpoint of the space serves, and says when none does", () => {
    const endpoint = (name: string, slug: string, reps: string[]) =>
      ({ apiVersion: "x", kind: "Endpoint", metadata: { name }, spec: { slug, enabledRepresentations: reps } }) as unknown as Manifest;
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <ExportLinks endpoints={[endpoint("map", "m1", ["geojson"]), endpoint("all", "a1", ["ngsi-ld", "csv", "json"])]} type={TYPE} q={undefined} attrs={["name"]} />
      </I18nextProvider>,
    );
    expect(screen.getByRole("link", { name: "CSV" })).toHaveAttribute("href", `/api/endpoint/a1/file.csv?type=${TYPE}&attrs=name`);
    expect(screen.getByRole("link", { name: "JSON" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Excel" })).toBeNull();
    rerender(
      <I18nextProvider i18n={i18n}>
        <ExportLinks endpoints={[endpoint("map", "m1", ["geojson"])]} type={TYPE} q={undefined} attrs={[]} />
      </I18nextProvider>,
    );
    expect(screen.getByText(/No Endpoint of this space serves CSV/)).toBeInTheDocument();
  });
});

describe("the import dialog", () => {
  it("maps a file's columns, shows what is refused, creates the rest and reports both", async () => {
    const user = userEvent.setup();
    const send = vi.fn<Send>(async () => ({ status: 201 }));
    const onImported = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <ImportRowsDialog open onOpenChange={() => {}} target={TARGET} slots={SLOTS as ImportSlot[]} send={send} onImported={onImported} />
      </I18nextProvider>,
    );
    const file = new File(["Title,bikes\nKamppi,4\n,2\n"], "stations.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Choose a file"), file);

    // `Title` is suggested as `name`; `bikes` matches no slot by name and is mapped by hand.
    expect(await screen.findByRole("combobox", { name: "Title" })).toHaveValue("name");
    await user.selectOptions(screen.getByRole("combobox", { name: "bikes" }), "availableBikeNumber");
    expect(screen.getByText("1 row is ready, 1 refused.")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Rows that will not be created" })).getByText(/name is required/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create 1 row" }));
    await waitFor(() => expect(screen.getByText("1 row created, 1 refused.")).toBeInTheDocument());
    expect(send).toHaveBeenCalledTimes(1);
    const [created] = send.mock.calls[0][0].body as Record<string, unknown>[];
    expect(created).toMatchObject({ type: TYPE, name: { value: "Kamppi" }, availableBikeNumber: { value: 4 } });
    expect(String(created.id)).toMatch(/^urn:ngsi-ld:BikeHireDockingStation:hel\.fi:helsinki:/);
    expect(onImported).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Download the refused rows (CSV)" })).toBeInTheDocument();
  });

  it("says why a file cannot be read and stays on the first step", async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(
      <I18nextProvider i18n={i18n}>
        <ImportRowsDialog open onOpenChange={() => {}} target={TARGET} slots={SLOTS} send={vi.fn<Send>()} onImported={() => {}} />
      </I18nextProvider>,
    );
    await user.upload(screen.getByLabelText("Choose a file"), new File(["{nope"], "rows.json"));
    expect(await screen.findByRole("alert")).toHaveTextContent("The file could not be read: the file is not JSON");
    expect(screen.getByLabelText("Choose a file")).toBeInTheDocument();
  });
});
