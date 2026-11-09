import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { EntityGrid } from "../src/grid/EntityGrid";
import { parseGridConfig } from "../src/grid/config";
import { applyChanges } from "../src/grid/apply";
import { queryFromFilters, searchQuery } from "../src/grid/filters";
import type { FilterColumn } from "../src/grid/filters";
import { columnsOf, filterOf, odataSource, orderByOf, queryOf, setFromCsdl } from "../src/grid/odata";
import { SourceError, sourceFor } from "../src/grid/source";
import type { JcRequest, JcResponse } from "../src/sdk/transport";

// The CSDL JSON odata-table writes for the example service (T-6642 examples/tables.rs).
const CSDL_JSON = {
  $Version: "4.01",
  $EntityContainer: "Example.Container",
  Example: {
    Thing: {
      $Kind: "EntityType",
      $Key: ["id"],
      id: {},
      name: { $Nullable: true },
      size: { $Type: "Edm.Int64", $Nullable: true },
      active: { $Type: "Edm.Boolean", $Nullable: true },
      changedAt: { $Type: "Edm.DateTimeOffset", $Nullable: true },
      address: { $Type: "Example.Address", $Nullable: true },
      "name@Core.Description": "Its name, e.g. Alpha",
    },
    Address: { $Kind: "ComplexType", city: { $Nullable: true } },
    Container: { $Kind: "EntityContainer", Things: { $Collection: true, $Type: "Example.Thing" } },
  },
};

// The CSDL XML 4.0 the Portal pilot route writes (T-6632 src/api/odata.rs, odata-csdl).
const CSDL_XML = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="JoinedContext.Portal">
      <EntityType Name="Endpoint">
        <Key><PropertyRef Name="id"/></Key>
        <Property Name="id" Type="Edm.String" Nullable="false"/>
        <Property Name="title" Type="Edm.String"/>
        <Property Name="contextSpace" Type="Edm.String"/>
        <Property Name="mcp" Type="Edm.Boolean"/>
        <Property Name="tags" Type="Collection(Edm.String)"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Endpoints" EntityType="JoinedContext.Portal.Endpoint"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

const set = setFromCsdl(CSDL_JSON, "Things");

const column = (attr: string, kind: FilterColumn["kind"]): FilterColumn => ({ key: attr, attr, kind });
const COLUMNS: FilterColumn[] = [
  { key: "id", attr: null, kind: "id" },
  column("name", "text"),
  column("size", "number"),
  column("active", "boolean"),
  column("changedAt", "date"),
];

/** The `$filter` the grid's filter row asks for, through the same `queryFromFilters` the grid runs. */
const filtered = (filters: Parameters<typeof queryFromFilters>[1]) => filterOf(set, queryFromFilters(COLUMNS, filters));

describe("$metadata", () => {
  it("reads the set's key, properties, types and descriptions from CSDL JSON", () => {
    expect(set.entityType).toBe("Thing");
    expect(set.key).toBe("id");
    expect(set.properties.map((p) => [p.name, p.type])).toEqual([
      ["id", "Edm.String"],
      ["name", "Edm.String"],
      ["size", "Edm.Int64"],
      ["active", "Edm.Boolean"],
      ["changedAt", "Edm.DateTimeOffset"],
      ["address", "Example.Address"],
    ]);
    expect(set.properties.find((p) => p.name === "name")?.description).toBe("Its name, e.g. Alpha");
  });

  it("reads the Portal's CSDL XML, leaving out collections", () => {
    const portal = setFromCsdl(CSDL_XML, "Endpoints");
    expect(portal).toMatchObject({ entityType: "Endpoint", key: "id" });
    expect(portal.properties.map((p) => [p.name, p.type, p.nullable])).toEqual([
      ["id", "Edm.String", false],
      ["title", "Edm.String", true],
      ["contextSpace", "Edm.String", true],
      ["mcp", "Edm.Boolean", true],
    ]);
  });

  it("turns the properties into columns, numbers and dates formatted, the key left to the id column", () => {
    expect(columnsOf(set).slice(0, 4)).toEqual([
      { attr: "name", format: "text" },
      { attr: "size", format: "number" },
      { attr: "active", format: "text" },
      { attr: "changedAt", format: "date" },
    ]);
  });

  it("refuses a $metadata that does not declare the set", () => {
    expect(() => setFromCsdl(CSDL_JSON, "Missing")).toThrow(/does not declare the entity set Missing/);
    expect(() => setFromCsdl("<not xml", "Things")).toThrow(SourceError);
  });
});

describe("$filter from the grid's filters, per column type", () => {
  it("writes text as a quoted literal and each operator as OData's", () => {
    expect(filtered({ name: { op: "equals", value: "Alpha" } })).toBe("name eq 'Alpha'");
    expect(filtered({ name: { op: "notEquals", value: "Alpha" } })).toBe("name ne 'Alpha'");
    expect(filtered({ name: { op: "contains", value: "lph" } })).toBe("contains(name,'lph')");
    expect(filtered({ name: { op: "empty", value: "" } })).toBe("name eq null");
    expect(filtered({ name: { op: "present", value: "" } })).toBe("name ne null");
  });

  it("writes numbers bare, ranges as ge and le, and refuses text in a number column", () => {
    expect(filtered({ size: { op: "gt", value: "2" } })).toBe("size gt 2");
    expect(filtered({ size: { op: "lte", value: "2.5" } })).toBe("size le 2.5");
    expect(filtered({ size: { op: "between", value: "1", value2: "3" } })).toBe("(size ge 1) and (size le 3)");
    expect(() => filterOf(set, { q: "size>big" })).toThrow(/size holds numbers/);
  });

  it("writes booleans, dates and picked values", () => {
    expect(filtered({ active: { op: "equals", value: "true" } })).toBe("active eq true");
    expect(filtered({ changedAt: { op: "gte", value: "2026-11-07" } })).toBe("changedAt ge 2026-11-07T00:00:00Z");
    expect(filtered({ changedAt: { op: "lt", value: "2026-11-07T08:00:00Z" } })).toBe("changedAt lt 2026-11-07T08:00:00Z");
    expect(filtered({ name: { op: "anyOf", value: "", values: ["Alpha", "Beta"] } })).toBe("name in ('Alpha','Beta')");
    expect(filtered({ name: { op: "equals", value: "Alpha" }, size: { op: "gt", value: "1" } })).toBe("(name eq 'Alpha') and (size gt 1)");
  });

  it("maps the id column to the key: one id, its beginning, a part of it", () => {
    expect(filtered({ id: { op: "equals", value: "t1" } })).toBe("id eq 't1'");
    expect(filtered({ id: { op: "startsWith", value: "t" } })).toBe("startswith(id,'t')");
    expect(filtered({ id: { op: "contains", value: "1" } })).toBe("contains(id,'1')");
    expect(filterOf(set, { ids: ["t1", "t'2"] })).toBe("id in ('t1','t''2')");
  });

  it("turns the search box into contains over every text column, joined by or", () => {
    const q = searchQuery("Al", [column("name", "text"), column("title", "text")]);
    expect(filterOf({ ...set, properties: [...set.properties, { name: "title", type: "Edm.String", nullable: true }] }, { q })).toBe(
      "(contains(name,'Al')) or (contains(title,'Al'))",
    );
  });

  it("searches case-blind with tolower where the set's FilterFunctions name it, and as typed elsewhere", () => {
    const portal = setFromCsdl(
      CSDL_XML.replace(
        '<EntitySet Name="Endpoints" EntityType="JoinedContext.Portal.Endpoint"/>',
        '<EntitySet Name="Endpoints" EntityType="JoinedContext.Portal.Endpoint"><Annotation Term="Capabilities.FilterFunctions"><Collection><String>contains</String><String>tolower</String></Collection></Annotation></EntitySet>',
      ),
      "Endpoints",
    );
    expect(portal.tolower).toBe(true);
    const q = searchQuery("Air O'", [column("title", "text")]);
    expect(filterOf(portal, { q })).toBe("contains(tolower(title),'air o''')");
    // A typed pattern without (?i) stays case-sensitive, and a set that names no tolower is asked as typed.
    expect(filterOf(portal, { q: 'title~="Air"' })).toBe("contains(title,'Air')");
    expect(setFromCsdl(CSDL_XML, "Endpoints").tolower).toBeUndefined();
    expect(filterOf(setFromCsdl(CSDL_XML, "Endpoints"), { q })).toBe("contains(title,'Air O''')");
    const things = { ...CSDL_JSON.Example.Container.Things, "@Capabilities.FilterFunctions": ["tolower"] };
    const json = setFromCsdl({ ...CSDL_JSON, Example: { ...CSDL_JSON.Example, Container: { ...CSDL_JSON.Example.Container, Things: things } } }, "Things");
    expect(json.tolower).toBe(true);
  });

  it("reads a typed q: a nested member, or, parentheses", () => {
    expect(filterOf(set, { q: "address[city]==\"Turku\"" })).toBe("address/city eq 'Turku'");
    expect(filterOf(set, { q: "(size>1|size<0);name==\"A\"" })).toBe("((size gt 1) or (size lt 0)) and (name eq 'A')");
  });

  it("refuses what has no OData form, naming the reason, before any request", () => {
    expect(() => filterOf(set, { q: 'name~="^A.*z$"' })).toThrow(/plain text in a filter, not a regular expression/);
    expect(() => filterOf(set, { q: "colour==\"red\"" })).toThrow(/no column colour/);
    expect(() => filterOf(set, { q: "size.observedAt>2026-01-01" })).toThrow(/keeps no metadata/);
    expect(() => filterOf(set, { q: "name==\"A\";(" })).toThrow(SourceError);
  });

  // Security (T-6644): a value is data. Quotes and parentheses stay inside one string literal, so
  // a typed `') or true or ('` cannot close the literal and widen the filter.
  it("never lets a typed value out of its literal", () => {
    const attack = "') or true or ('";
    expect(filtered({ name: { op: "equals", value: attack } })).toBe("name eq ''') or true or ('''");
    expect(filtered({ name: { op: "contains", value: attack } })).toBe("contains(name,''') or true or (''')");
    expect(filtered({ id: { op: "equals", value: attack } })).toBe("id eq ''') or true or ('''");
    expect(filterOf(set, { q: searchQuery(attack, [column("name", "text")]) })).toBe("contains(name,''') or true or (''')");
    // In a number column the same text is refused rather than written.
    expect(() => filtered({ size: { op: "equals", value: attack } })).toThrow(/size holds numbers/);
    // A double quote typed into a text filter stays a character of the value.
    expect(filtered({ name: { op: "equals", value: 'a"b' } })).toBe("name eq 'a\"b'");
  });
});

describe("the rest of the page's query", () => {
  it("writes sort, column choice, paging and count, each value percent-encoded", () => {
    expect(orderByOf(set, "size;desc,id")).toBe("size desc,id");
    expect(() => orderByOf(set, "colour")).toThrow(/cannot be sorted by colour/);
    const text = queryOf(set, { type: "Thing", q: 'name=="a b&c"', attrs: ["name", "nope"], orderBy: "name" }, { offset: 50, limit: 25 });
    expect(text).toBe("$filter=name%20eq%20'a%20b%26c'&$select=id%2Cname&$orderby=name&$top=25&$skip=50&$count=true");
    expect(queryOf(set, { type: "Thing" }, { offset: 0, limit: 10, count: false })).toBe("$top=10");
  });
});

/** A stub OData service: the example's two rows, `$allowed` per operation, writes recorded. */
function service(options: { allowUpdate?: boolean; writeStatus?: number } = {}) {
  const sent: JcRequest[] = [];
  const transport = async (request: JcRequest): Promise<JcResponse> => {
    sent.push(request);
    const path = request.path;
    if (path === "/odata/$metadata?$format=application/xml") return { status: 200, body: CSDL_JSON };
    if (path.startsWith("/odata/Things/$allowed?")) {
      const op = new URLSearchParams(path.split("?")[1]).get("op");
      return op === "update" && options.allowUpdate
        ? { status: 200, body: { allowed: true, reason: "", permission: null } }
        : { status: 200, body: { allowed: false, reason: "Things is served read only", permission: null } };
    }
    if (request.method === "PATCH") return { status: options.writeStatus ?? 204, body: null, headers: { etag: '"v2"' } };
    if (path.startsWith("/odata/Things?")) {
      return {
        status: 200,
        headers: { etag: '"c0ffee"' },
        body: {
          "@odata.context": "/odata/$metadata#Things",
          "@odata.count": 2,
          value: [
            { "@odata.etag": '"v1"', id: "t1", name: "Alpha", size: 3, active: true, changedAt: null, address: { city: "Turku" } },
            { id: "t2", name: "Beta", size: 1, active: false, changedAt: "2026-11-07T08:00:00Z", address: null },
          ],
        },
      };
    }
    return { status: 404, body: { error: { code: "NotFound", message: "the resource does not exist" } } };
  };
  return { sent, source: odataSource("/odata/", "Things", transport) };
}

describe("odataSource", () => {
  it("reads rows with their key as id, the count as the total, and nulls as no value", async () => {
    const { source, sent } = service();
    const page = await source.query({ type: "Thing", q: "size>0" }, { offset: 0, limit: 50 });
    expect(sent.map((r) => r.path)).toEqual(["/odata/$metadata?$format=application/xml", "/odata/Things?$filter=size%20gt%200&$top=50&$count=true"]);
    expect(page.total).toBe(2);
    expect(page.rows.map((row) => [row.id, row.type])).toEqual([["t1", "Thing"], ["t2", "Thing"]]);
    expect(page.rows[0].cells.size).toMatchObject({ value: 3 });
    expect(page.rows[0].cells.changedAt).toBeUndefined();
    expect(page.rows[1].cells.changedAt).toMatchObject({ value: "2026-11-07T08:00:00Z" });
  });

  it("asks $allowed before a write and shows its reason, sending nothing else", async () => {
    const { source, sent } = service();
    await source.query({ type: "Thing" }, { offset: 0, limit: 50 });
    const result = await applyChanges({
      source,
      reason: "Typo",
      entities: [{ id: "t1", changes: [{ attribute: "name", kind: "property", before: "Alpha", after: "Alfa" }] }],
    });
    expect(result.refused).toEqual([{ id: "t1", detail: "You may not change this row. Things is served read only.", slot: undefined }]);
    expect(sent.some((r) => r.method === "PATCH")).toBe(false);
    expect(sent.at(-1)?.path).toBe("/odata/Things/$allowed?op=update&key=t1");
  });

  it("writes a plain value with If-Match of the row it read", async () => {
    const { source, sent } = service({ allowUpdate: true });
    await source.query({ type: "Thing" }, { offset: 0, limit: 50 });
    await source.patch!("t1", { name: { type: "Property", value: "Alfa" } });
    await source.patch!("t2", { size: { type: "Property", value: 4 } });
    const writes = sent.filter((r) => r.method === "PATCH");
    expect(writes).toEqual([
      { method: "PATCH", path: "/odata/Things('t1')", body: { name: "Alfa" }, ifMatch: '"v1"' },
      // A row without its own tag is conditional on the set's.
      { method: "PATCH", path: "/odata/Things('t2')", body: { size: 4 }, ifMatch: '"c0ffee"' },
    ]);
  });

  it("words a changed row (412) and a read-only set (405)", async () => {
    await expect(service({ allowUpdate: true, writeStatus: 412 }).source.patch!("t1", { name: "x" })).rejects.toThrow(/changed since it was read/);
    await expect(service({ allowUpdate: true, writeStatus: 405 }).source.patch!("t1", { name: "x" })).rejects.toThrow(/read only/);
  });

  it("refuses a row action the module refuses, with its reason", async () => {
    const { source, sent } = service();
    await expect(source.remove!("t1")).rejects.toMatchObject({ status: 403, message: "You may not remove this row. Things is served read only." });
    expect(sent.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("is what sourceFor builds for an odata config", async () => {
    const { config } = parseGridConfig({ source: { kind: "odata", url: "/odata", entitySet: "Things" }, type: "Thing" });
    expect(config?.source).toEqual({ kind: "odata", url: "/odata", entitySet: "Things" });
    const answered: string[] = [];
    const built = sourceFor(config!.source as { kind: "odata"; url: string; entitySet: string }, async (r) => {
      answered.push(r.path);
      return { status: 503, body: { error: { message: "down for maintenance" } } };
    });
    await expect(built.query({ type: "Thing" }, { offset: 0, limit: 1 })).rejects.toThrow("down for maintenance");
    expect(answered).toEqual(["/odata/$metadata?$format=application/xml"]);
  });
});

describe("an odata source in the config", () => {
  it("takes a path on this site and an entity set name, nothing else", () => {
    const findings = (source: unknown) => parseGridConfig({ source, type: "Thing" }).findings.map((f) => f.path);
    expect(findings({ kind: "odata", url: "/api/v1/projects/helsinki/odata", entitySet: "Endpoints" })).toEqual([]);
    expect(findings({ kind: "odata", url: "https://evil.example/odata", entitySet: "Things" })).toEqual(["/source/url"]);
    expect(findings({ kind: "odata", url: "//evil.example/odata", entitySet: "Things" })).toEqual(["/source/url"]);
    expect(findings({ kind: "odata", url: "/odata/../admin", entitySet: "Things" })).toEqual(["/source/url"]);
    expect(findings({ kind: "odata", url: "/odata/%2e%2e/admin", entitySet: "Things" })).toEqual(["/source/url"]);
    expect(findings({ kind: "odata", url: "/odata?x=1", entitySet: "Things" })).toEqual(["/source/url"]);
    expect(findings({ kind: "odata", url: "/odata", entitySet: "Things('t1')" })).toEqual(["/source/entitySet"]);
    expect(findings({ kind: "odata", url: "/odata", entitySet: "Things", slug: "x" })).toEqual(["/source/slug"]);
    // A comparison reads both sides by entity id, which an OData key is not.
    expect(parseGridConfig({ source: { kind: "fixture", name: "a" }, type: "T", compareWith: { kind: "odata", url: "/o", entitySet: "S" } }).findings).toEqual([
      { path: "/compareWith/kind", message: "must be one of endpoint, space, fixture" },
    ]);
  });
});

describe("EntityGrid over an OData set", () => {
  it("draws the rows, the total and the refusal of a read the module refused", async () => {
    const { config } = parseGridConfig({ source: { kind: "odata", url: "/odata", entitySet: "Things" }, type: "Thing", columns: columnsOf(set).slice(0, 4) });
    const { source } = service();
    const { unmount } = render(<EntityGrid config={config!} source={source} />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "3");
    unmount();
    const refusing = odataSource("/odata", "Things", async (r) =>
      r.path.includes("$metadata") ? { status: 200, body: CSDL_JSON } : { status: 403, body: { error: { code: "Forbidden", message: "you may not read Things" } } },
    );
    render(<EntityGrid config={config!} source={refusing} />);
    await waitFor(() => expect(screen.getByText("you may not read Things")).toBeInTheDocument());
  });
});

describe("a page bigger than one answer", () => {
  it("reads in turns of at most 1000 rows, following the set's next link", async () => {
    const asked: string[] = [];
    const rows = Array.from({ length: 2500 }, (_, at) => ({ id: `t${at}`, name: `n${at}` }));
    // As odata-axum: 700 rows an answer and a next link while more remain.
    const source = odataSource("/odata", "Things", async (r) => {
      if (r.path.includes("$metadata")) return { status: 200, body: CSDL_JSON };
      asked.push(r.path);
      const query = new URLSearchParams(r.path.split("?")[1]);
      const skip = Number(query.get("$skip") ?? 0);
      const top = Math.min(Number(query.get("$top")), 700);
      return { status: 200, body: { "@odata.count": rows.length, value: rows.slice(skip, skip + top), ...(skip + top < rows.length ? { "@odata.nextLink": "x" } : {}) } };
    });
    const page = await source.query({ type: "Thing" }, { offset: 100, limit: 2000 });
    expect(page.rows).toHaveLength(2000);
    expect(page.rows[0].id).toBe("t100");
    expect(page.rows.at(-1)?.id).toBe("t2099");
    expect(page.total).toBe(2500);
    expect(asked[0]).toBe("/odata/Things?$top=1000&$skip=100&$count=true");
    expect(asked.every((path) => Number(new URLSearchParams(path.split("?")[1]).get("$top")) <= 1000)).toBe(true);
  });
});

describe("the Portal's pilot route (T-6632)", () => {
  it("reads its Endpoints answer: typed columns from CSDL XML, rows by id, the count", async () => {
    const source = odataSource("/api/v1/projects/helsinki/odata/", "Endpoints", async (r) =>
      r.path.includes("$metadata")
        ? { status: 200, body: CSDL_XML }
        : {
            status: 200,
            body: {
              "@odata.context": "https://portal.example/api/v1/projects/helsinki/odata/$metadata#Endpoints",
              "@odata.count": 1,
              value: [{ id: "air-counters", title: "Air counters", contextSpace: "air", mcp: true }],
            },
          },
    );
    const set = await source.metadata();
    expect(columnsOf(set).map((c) => c.attr)).toEqual(["title", "contextSpace", "mcp"]);
    expect(filterOf(set, { q: 'title~="Air";mcp==true' })).toBe("(contains(title,'Air')) and (mcp eq true)");
    const page = await source.query({ type: "Endpoint" }, { offset: 0, limit: 50 });
    expect(page).toMatchObject({ total: 1, rows: [{ id: "air-counters", type: "Endpoint" }] });
  });
});
