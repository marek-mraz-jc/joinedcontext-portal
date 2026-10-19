import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReasonError,
  addOldValue,
  correct,
  editCurrent,
  instantOf,
  measurementsOf,
  parseCsv,
  planImport,
  readHistory,
  runImport,
  validateReason,
  valueOf,
} from "../src/components/entities/history/historyApi";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("historyApi pure functions", () => {
  it("measurementsOf parses object vs array, groups and orders versions, skips missing observedAt, handles garbage", () => {
    expect(measurementsOf(null, "attr")).toEqual([]);
    expect(measurementsOf({}, "attr")).toEqual([]);
    expect(measurementsOf({ attr: "invalid" }, "attr")).toEqual([]);

    // Single instance object
    const single = {
      status: {
        type: "Property",
        value: "free",
        observedAt: "2026-10-18T07:00:00Z",
        instanceId: "urn:inst:1",
      },
    };
    const resSingle = measurementsOf(single, "status");
    expect(resSingle).toHaveLength(1);
    expect(resSingle[0].observedAt).toBe("2026-10-18T07:00:00Z");
    expect(resSingle[0].current.value).toBe("free");

    // Array with grouped versions and missing observedAt
    const arrayData = {
      status: [
        {
          type: "Property",
          value: "no-time",
        },
        {
          type: "Property",
          value: "occupied",
          observedAt: "2026-10-18T07:00:00Z",
          instanceId: "urn:inst:1",
          supersededAt: "2026-10-18T09:12:40Z",
          provenance: { writtenAt: "2026-10-18T07:00:02Z", channel: "pipeline" },
        },
        {
          type: "Property",
          value: "free",
          observedAt: "2026-10-18T07:00:00Z",
          instanceId: "urn:inst:2",
          provenance: { writtenAt: "2026-10-18T09:12:40Z", channel: "ui", reason: "fixed" },
        },
        {
          type: "Property",
          value: "reserved",
          observedAt: "2026-10-18T08:00:00Z",
          instanceId: "urn:inst:3",
        },
      ],
    };
    const resArray = measurementsOf(arrayData, "status");
    expect(resArray).toHaveLength(2);
    // Newest measurement first
    expect(resArray[0].observedAt).toBe("2026-10-18T08:00:00Z");
    expect(resArray[0].current.value).toBe("reserved");

    expect(resArray[1].observedAt).toBe("2026-10-18T07:00:00Z");
    expect(resArray[1].versions).toHaveLength(2);
    // Oldest version first
    expect(resArray[1].versions[0].value).toBe("occupied");
    expect(resArray[1].versions[1].value).toBe("free");
    // Current is the one without supersededAt
    expect(resArray[1].current.value).toBe("free");
  });

  it("instantOf converts valid local to UTC Z, and returns undefined for empty, malformed, future", () => {
    expect(instantOf("")).toBeUndefined();
    expect(instantOf("bad-string")).toBeUndefined();
    expect(instantOf("2099-01-01T00:00")).toBeUndefined();

    const pastIso = instantOf("2020-05-10T14:30");
    expect(pastIso).toBeDefined();
    expect(pastIso!.endsWith("Z")).toBe(true);
  });

  it("valueOf handles number, boolean, JSON, string, and refuses NaN", () => {
    expect(valueOf("42", 0)).toBe(42);
    expect(valueOf("42.5", 0)).toBe(42.5);
    expect(valueOf("not-a-number", 0)).toBeUndefined();
    expect(valueOf("", 0)).toBeUndefined();

    expect(valueOf("true", false)).toBe(true);
    expect(valueOf("false", true)).toBe(false);
    expect(valueOf("other", false)).toBeUndefined();

    expect(valueOf('{"key": 1}', {})).toEqual({ key: 1 });
    expect(valueOf("[1, 2]", [])).toEqual([1, 2]);
    expect(valueOf("invalid json", {})).toBeUndefined();

    expect(valueOf("plain text", "sample")).toBe("plain text");
  });

  it("parseCsv handles header in any order, quotes, CRLF, missing header, bad instant, future, caps", () => {
    // Missing header
    const noHeader = parseCsv("just,some,text\n1,2,3");
    expect(noHeader.problems[0].reason).toContain("header");
    expect(noHeader.rows).toHaveLength(0);

    // RFC 4180 quotes, CRLF, header in any order
    const validCsv = 'value,observedAt\r\n"hello, ""world""",2020-01-01T00:00:00Z\r\n';
    const parsedValid = parseCsv(validCsv, "");
    expect(parsedValid.problems).toHaveLength(0);
    expect(parsedValid.rows).toHaveLength(1);
    expect(parsedValid.rows[0].value).toBe('hello, "world"');

    // Bad instant line and future instant
    const badCsv = `observedAt,value
bad-date,1
2099-01-01T00:00:00Z,2
2020-01-01T00:00:00Z,3
`;
    const parsedBad = parseCsv(badCsv, 0);
    expect(parsedBad.problems).toHaveLength(2);
    expect(parsedBad.problems[0].line).toBe(2);
    expect(parsedBad.problems[1].line).toBe(3);
    expect(parsedBad.rows).toHaveLength(1);
    expect(parsedBad.rows[0].line).toBe(4);
    expect(parsedBad.rows[0].value).toBe(3);

    // Byte cap
    const hugeStr = "observedAt,value\n" + "x".repeat(1_000_001);
    const hugeRes = parseCsv(hugeStr);
    expect(hugeRes.problems[0].reason).toContain("bytes");
    expect(hugeRes.rows).toHaveLength(0);
  });

  it("planImport leaves a row older than the history read unchecked unless the history is whole", () => {
    const measurements: Measurement[] = [
      {
        observedAt: "2020-01-02T00:00:00.000Z",
        current: { value: 20, instanceId: "inst:2" },
        versions: [{ value: 20, instanceId: "inst:2" }],
      },
      {
        observedAt: "2020-01-03T00:00:00.000Z",
        current: { value: 30 },
        versions: [{ value: 30 }],
      },
    ];
    const rows: CsvRow[] = [
      { observedAt: "2020-01-01T00:00:00.000Z", value: 10, line: 2 },
      { observedAt: "2020-01-03T00:00:00.000Z", value: 31, line: 3 },
    ];
    const partial = planImport(rows, measurements);
    expect(partial.unchecked.map((r) => r.line)).toEqual([2]);
    // A measurement the answer names no instance of cannot be corrected by id: sent as a value.
    expect(partial.added.map((r) => r.line)).toEqual([3]);
    expect(partial.corrections).toEqual([]);
    expect(planImport(rows, measurements, true).unchecked).toEqual([]);
  });

  it("planImport accurately counts added, duplicate, correction and keeps later duplicate instant", () => {
    const measurements: Measurement[] = [
      {
        observedAt: "2020-01-01T00:00:00.000Z",
        current: { value: 10, instanceId: "inst:1" },
        versions: [{ value: 10, instanceId: "inst:1" }],
      },
      {
        observedAt: "2020-01-02T00:00:00.000Z",
        current: { value: 20, instanceId: "inst:2" },
        versions: [{ value: 20, instanceId: "inst:2" }],
      },
    ];

    const rows: CsvRow[] = [
      { observedAt: "2020-01-01T00:00:00.000Z", value: 10, line: 2 }, // Duplicate
      { observedAt: "2020-01-02T00:00:00.000Z", value: 99, line: 3 }, // Correction
      { observedAt: "2020-01-03T00:00:00.000Z", value: 30, line: 4 }, // Added (earlier)
      { observedAt: "2020-01-03T00:00:00.000Z", value: 35, line: 5 }, // Added (later, wins)
      { observedAt: "2020-01-04T00:00:00.000Z", value: 40, line: 6 }, // Added
    ];

    const plan = planImport(rows, measurements);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0].value).toBe(10);

    expect(plan.corrections).toHaveLength(1);
    expect(plan.corrections[0].instanceId).toBe("inst:2");
    expect(plan.corrections[0].row.value).toBe(99);

    expect(plan.added).toHaveLength(2);
    expect(plan.added.find((a) => a.observedAt === "2020-01-03T00:00:00.000Z")?.value).toBe(35);
    expect(plan.added.find((a) => a.observedAt === "2020-01-04T00:00:00.000Z")?.value).toBe(40);
  });

  it("enforces reason guard on empty, whitespace and 501 chars without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(() => validateReason("")).toThrow(ReasonError);
    expect(() => validateReason("   ")).toThrow(ReasonError);
    expect(() => validateReason("a".repeat(501))).toThrow(ReasonError);

    await expect(editCurrent("slug", "id", "attr", 1, "")).rejects.toThrow(ReasonError);
    await expect(addOldValue("slug", "id", "attr", 1, "2020-01-01T00:00:00Z", "   ")).rejects.toThrow(
      ReasonError,
    );
    await expect(correct("slug", "id", "attr", "inst", 1, "2020-01-01T00:00:00Z", "a".repeat(501))).rejects.toThrow(
      ReasonError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("historyApi HTTP requests", () => {
  it("readHistory falls back without versions=all on 403 and asserts both URLs", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        calls.push(url);
        if (url.includes("versions=all")) {
          return Promise.resolve(new Response(JSON.stringify({ detail: "forbidden" }), { status: 403 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              temp: [
                {
                  type: "Property",
                  value: 21,
                  observedAt: "2026-10-18T10:00:00Z",
                  instanceId: "inst:1",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }),
    );

    const res = await readHistory("station-slug", "urn:ngsi-ld:Station:1", "temp");
    expect(res.versions).toBe(false);
    expect(res.measurements).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("versions=all");
    expect(calls[1]).not.toContain("versions=all");
  });

  it("sends percent-encoded JC-Reason and x-csrf-token on writes", async () => {
    document.cookie = "__Host-jc_csrf=test-csrf-token; Secure; path=/";
    let sentHeaders: Headers | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (input instanceof Request) {
          sentHeaders = input.headers;
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }),
    );

    await editCurrent("slug", "urn:id", "temp", 25, "zmena na stanici");
    expect(sentHeaders?.get("jc-reason")).toBe(encodeURIComponent("zmena na stanici"));
    expect(sentHeaders?.get("x-csrf-token")).toBe("test-csrf-token");
  });

  it("runImport chunks 230 added rows into 100/100/30 and stops at the first failure", async () => {
    const chunkSizes: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (input instanceof Request) {
          const body = (await input.json()) as Record<string, unknown[]>;
          const items = body.temp ?? [];
          chunkSizes.push(items.length);
          if (chunkSizes.length === 2) {
            return new Response(JSON.stringify({ detail: "broker down" }), { status: 500 });
          }
        }
        return new Response(null, { status: 204 });
      }),
    );

    const added: CsvRow[] = Array.from({ length: 230 }, (_, i) => ({
      observedAt: new Date(1700000000000 + i * 1000).toISOString(),
      value: i,
      line: i + 2,
    }));

    const plan = {
      added,
      duplicates: [],
      corrections: [],
      unchecked: [],
    };

    const res = await runImport("slug", "urn:id", "temp", plan, "batch import");
    expect(chunkSizes).toEqual([100, 100]);
    expect(res.sent).toBe(100);
    expect(res.failed).toBeDefined();
    expect(res.failed?.line).toBe(102); // Line of the 101st item
  });
});
