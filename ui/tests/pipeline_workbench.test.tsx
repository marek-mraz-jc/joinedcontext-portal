/**
 * T-2709: the pipeline workbench (ADR-N-034, PL-58). Six steps in order, each with its one-line
 * hint and its live output from the operation an agent runs for the same step (PL-63): the sample
 * of the picked source, the mapping's records with each problem at its record and field, the
 * verdict against the target space's model, and the target named with where it lands. The mapping
 * step hints each slot of the model with its type, whether it is required, its enum values and an
 * example; a refused sample says why; the verdict reaches the dialog only for the mapping it ran.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { JSX } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import type { Manifest } from "../src/api/manifest";
import type { PipelineForm } from "../src/pages/pipelines/PipelineEditor";
import { PipelineWorkbench, classOfMapping, exampleOf, readSample, readValidation } from "../src/pages/pipelines/PipelineWorkbench";
import { expectAxeClean, jsonResponse, problem } from "./pageHarness";

const URN = "urn:ngsi-ld:Endpoint:banskabystrica.sk:ovzdusie:air-write";

const manifest = (kind: string, name: string, spec: Record<string, unknown>): Manifest => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind,
  metadata: { name, namespace: "ovzdusie" },
  spec,
});

const LINKML = [
  "id: https://banskabystrica.sk/models/air",
  "name: air",
  "classes:",
  "  AirQualityObserved:",
  "    slots: [pm10, quality]",
  "slots:",
  "  pm10:",
  "    range: float",
  "    required: true",
  "    description: Particles under 10 µm.",
  "  quality:",
  "    range: QualityLevel",
  "enums:",
  "  QualityLevel:",
  "    permissible_values:",
  "      good: {}",
  "      poor: {}",
  "",
].join("\n");

const DATASOURCES = [
  manifest("DataSource", "shmu-csv", { type: "http", http: { url: "https://feeds.example/air.csv" } }),
];
const ENDPOINTS = [manifest("Endpoint", "air-write", { contextSpaceRef: "ovzdusie" })];
const TARGETS = [{ name: "air-write", urn: URN }];

const MAPPING = [
  'root.id = "urn:ngsi-ld:AirQualityObserved:banskabystrica.sk:ovzdusie:" + this.station',
  'root.type = "AirQualityObserved"',
  'root.pm10 = { "type": "Property", "value": this.pm10.number() }',
].join("\n");

interface Answers {
  sample?: Response | unknown;
  mapping?: unknown;
  validate?: unknown;
}

interface Seen {
  ops: { name: string; body: Record<string, unknown> }[];
}

function stub(answers: Answers, seen: Seen) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(String(input));
      const path = new URL(request.url, window.location.origin).pathname;
      const op = /\/ops\/([a-z_]+)$/.exec(path)?.[1];
      if (op) {
        const body = (await request.clone().json()) as Record<string, unknown>;
        seen.ops.push({ name: op, body });
        const answer =
          op === "jc_pipeline_sample_source" ? answers.sample : op === "jc_pipeline_try_mapping" ? answers.mapping : answers.validate;
        return answer instanceof Response ? answer : jsonResponse(answer ?? {});
      }
      if (path.endsWith("/spaces")) {
        return jsonResponse({
          items: [manifest("ContextSpace", "ovzdusie", { dataModelRef: { kind: "DataModel", name: "air" } })],
        });
      }
      if (path.endsWith("/datamodels")) {
        return jsonResponse({ items: [manifest("DataModel", "air", { linkml: LINKML, classes: ["AirQualityObserved"] })] });
      }
      return jsonResponse({ items: [] });
    }),
  );
}

function Harness({
  start,
  verdicts,
}: {
  start: PipelineForm;
  verdicts: { ok: boolean; bloblang: string }[];
}): JSX.Element {
  const [draft, setDraft] = useState<PipelineForm>(start);
  return (
    <PipelineWorkbench
      project="ovzdusie"
      draft={draft}
      onChange={setDraft}
      dataSources={DATASOURCES}
      endpoints={ENDPOINTS}
      targets={TARGETS}
      toManifest={(form) => ({ kind: "Pipeline", metadata: { name: form.name ?? "air" }, spec: form })}
      onVerdict={(ok, bloblang) => verdicts.push({ ok, bloblang })}
    >
      <details>
        <summary>{en.pipelines.workbench.advanced}</summary>
        <p>advanced editor</p>
      </details>
    </PipelineWorkbench>
  );
}

function show(start: PipelineForm, verdicts: { ok: boolean; bloblang: string }[] = []) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nextProvider i18n={i18n}>
        <Harness start={start} verdicts={verdicts} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const step = (title: string) => screen.getByRole("region", { name: new RegExp(`${title}$`) });

const SAMPLE = {
  records: [
    { station: "01", pm10: "18.2" },
    { station: "02", pm10: "x" },
  ],
  fields: ["pm10", "station"],
  count: 2,
  truncated: false,
  errors: [],
};
const MAPPED = {
  records: [
    { id: "urn:ngsi-ld:AirQualityObserved:banskabystrica.sk:ovzdusie:01", type: "AirQualityObserved", pm10: { type: "Property", value: 18.2 } },
    { id: "urn:ngsi-ld:AirQualityObserved:banskabystrica.sk:ovzdusie:02", type: "AirQualityObserved", pm10: { type: "Property", value: "x" } },
  ],
  errors: [],
};
const ONE_BAD = {
  space: "ovzdusie",
  model: "air",
  version: "1.0.0",
  valid: 1,
  rejected: 1,
  verdicts: [
    { index: 0, ok: true, problems: [] },
    { index: 1, ok: false, problems: [{ rule: "sh:datatype", path: "pm10", message: "pm10 is not of the slot's datatype xsd:float" }] },
  ],
};

describe("the pipeline workbench", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows_six_steps_in_order_each_with_its_hint", () => {
    stub({}, { ops: [] });
    show({});
    const titles = screen
      .getAllByRole("region")
      .filter((region) => region.tagName === "SECTION")
      .map((region) => region.getAttribute("aria-labelledby"));
    expect(titles).toEqual([
      "workbench-source-title",
      "workbench-sample-title",
      "workbench-mapping-title",
      "workbench-output-title",
      "workbench-validation-title",
      "workbench-target-title",
    ]);
    for (const hint of [
      en.pipelines.workbench.source.hint,
      en.pipelines.workbench.sample.hint,
      en.pipelines.workbench.mapping.hint,
      en.pipelines.workbench.output.hint,
      en.pipelines.workbench.validation.hint,
      en.pipelines.workbench.target.hint,
    ]) {
      expect(screen.getByText(hint)).toBeInTheDocument();
    }
    // Nothing runs before a source is picked, and each step says what it waits for.
    expect(screen.getByText(en.pipelines.workbench.sample.waiting)).toBeInTheDocument();
    // The advanced editor is folded until opened.
    expect(screen.getByText("advanced editor")).not.toBeVisible();
  });

  it("samples_the_picked_source_then_tries_the_mapping_and_points_each_problem_at_its_record_and_field", async () => {
    const seen: Seen = { ops: [] };
    const verdicts: { ok: boolean; bloblang: string }[] = [];
    stub({ sample: SAMPLE, mapping: MAPPED, validate: ONE_BAD }, seen);
    const { container } = show({ targetEndpoint: URN, compute: { kind: "bloblang", bloblang: MAPPING } }, verdicts);

    await userEvent.selectOptions(screen.getByLabelText(en.pipelines.workbench.source.pick), "datasource:shmu-csv");
    const sample = await within(step(en.pipelines.workbench.sample.title)).findByRole("table", {
      name: en.pipelines.workbench.sample.caption,
    });
    expect(within(sample).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["pm10", "station"]);
    expect(within(sample).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("2 records with 2 fields")).toBeInTheDocument();

    const output = step(en.pipelines.workbench.output.title);
    const records = await within(output).findByRole("table", { name: en.pipelines.workbench.output.caption }, { timeout: 3000 });
    const rows = within(records).getAllByRole("row");
    expect(rows).toHaveLength(3);
    // The second record breaks the model: its row names the rule and the field.
    expect(await within(rows[2]).findByText("sh:datatype")).toBeInTheDocument();
    expect(within(rows[2]).getByText("pm10")).toBeInTheDocument();
    expect(within(rows[1]).getByText(en.pipelines.workbench.validation.valid)).toBeInTheDocument();

    const verdict = within(step(en.pipelines.workbench.validation.title)).getByRole("status");
    expect(verdict).toHaveTextContent("1 record breaks air 1.0.0 and would not be written; 1 valid.");
    await waitFor(() => expect(verdicts.at(-1)).toEqual({ ok: false, bloblang: MAPPING }));

    // Every step ran the operation an agent runs, with the source and the sample it names.
    expect(seen.ops.map((op) => op.name)).toEqual(["jc_pipeline_sample_source", "jc_pipeline_try_mapping", "jc_pipeline_validate"]);
    expect(seen.ops[0].body).toEqual({ dataSource: "shmu-csv" });
    expect(seen.ops[1].body.sample).toEqual({ url: "https://feeds.example/air.csv", format: "csv" });
    expect((seen.ops[2].body.records as unknown[]).length).toBe(2);
    await expectAxeClean(container);
  });

  it("gives_a_green_verdict_only_for_the_mapping_that_ran_and_only_when_every_record_is_valid", async () => {
    const verdicts: { ok: boolean; bloblang: string }[] = [];
    stub(
      {
        sample: SAMPLE,
        mapping: { records: MAPPED.records.slice(0, 1), errors: [] },
        validate: { ...ONE_BAD, valid: 1, rejected: 0, verdicts: [ONE_BAD.verdicts[0]] },
      },
      { ops: [] },
    );
    show({ targetEndpoint: URN, source: { dataSourceRef: "shmu-csv" }, compute: { kind: "bloblang", bloblang: MAPPING } }, verdicts);
    expect(
      await within(step(en.pipelines.workbench.validation.title)).findByText(
        "1 record is valid against air 1.0.0.",
        {},
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(verdicts.at(-1)).toEqual({ ok: true, bloblang: MAPPING }));
  });

  it("names_each_slot_of_the_target_model_with_its_type_whether_required_its_values_and_an_example", async () => {
    stub({}, { ops: [] });
    show({ targetEndpoint: URN, compute: { kind: "bloblang", bloblang: MAPPING } });
    const mapping = step(en.pipelines.workbench.mapping.title);
    const slots = await within(mapping).findByRole("region", { name: "What AirQualityObserved takes" });
    const [pm10, quality] = within(slots).getAllByRole("listitem");
    expect(within(pm10).getByText("float")).toBeInTheDocument();
    expect(within(pm10).getByText(en.pipelines.workbench.mapping.required)).toBeInTheDocument();
    expect(within(pm10).getByText("Particles under 10 µm.")).toBeInTheDocument();
    expect(within(pm10).getByText(/"value": 3\.5/)).toBeInTheDocument();
    expect(within(quality).getByText("Values: good, poor")).toBeInTheDocument();
    expect(within(quality).queryByText(en.pipelines.workbench.mapping.required)).toBeNull();
    expect(within(quality).getByText(/"value": "good"/)).toBeInTheDocument();
    // The target names the space the records land in and the model that checks them.
    expect(
      within(step(en.pipelines.workbench.target.title)).getByText(
        "The records land in the space ovzdusie, checked against the model air.",
      ),
    ).toBeInTheDocument();
  });

  it("a_space_without_a_model_says_so_and_does_not_hold_the_proposal", async () => {
    const verdicts: { ok: boolean; bloblang: string }[] = [];
    stub(
      {
        sample: SAMPLE,
        mapping: MAPPED,
        validate: new Response(
          JSON.stringify({ error: "no_model", space: "ovzdusie", detail: "space 'ovzdusie' names no data model, so nothing checks what lands in it; name its model in spec.dataModelRef (DM-61)" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      },
      { ops: [] },
    );
    show({ targetEndpoint: URN, source: { dataSourceRef: "shmu-csv" }, compute: { kind: "bloblang", bloblang: MAPPING } }, verdicts);
    expect(
      await within(step(en.pipelines.workbench.validation.title)).findByText(/names no data model/, {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(verdicts.at(-1)).toEqual({ ok: true, bloblang: MAPPING }));
  });

  it("a_sample_the_source_refuses_says_why_and_the_mapping_waits", async () => {
    const seen: Seen = { ops: [] };
    stub(
      {
        sample: problem(400, "DataSource 'shmu-csv' cannot be sampled: the source declares a credential; give the sample as text (a file of the feed) or as a URL instead"),
      },
      seen,
    );
    show({ source: { dataSourceRef: "shmu-csv" } });
    const alert = await within(step(en.pipelines.workbench.sample.title)).findByRole("alert");
    expect(alert).toHaveTextContent("give the sample as text");
    expect(screen.getByText(en.pipelines.workbench.output.waiting)).toBeInTheDocument();
    expect(seen.ops.map((op) => op.name)).toEqual(["jc_pipeline_sample_source"]);
  });

  it("a_dropped_file_is_the_sample_and_drafts_an_empty_mapping", async () => {
    const seen: Seen = { ops: [] };
    stub({ sample: SAMPLE, mapping: MAPPED, validate: ONE_BAD }, seen);
    show({ targetEndpoint: URN });
    const file = new File(["station,pm10\n01,18.2\n"], "air-quality.csv", { type: "text/csv" });
    await userEvent.upload(screen.getByLabelText(en.pipelines.workbench.source.file), file);
    expect(await screen.findByText("Sample: air-quality.csv")).toBeInTheDocument();
    const editor = screen.getByLabelText(en.pipelines.field.bloblang);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain("root.type"));
    await waitFor(() => expect(seen.ops[0]?.body).toEqual({ sample: { text: "station,pm10\n01,18.2\n", format: "csv" } }));
  });

  it("is_worked_from_the_keyboard_in_the_order_of_the_steps", async () => {
    stub({}, { ops: [] });
    show({});
    await userEvent.tab();
    expect(screen.getByLabelText(en.pipelines.workbench.source.pick)).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByLabelText(en.pipelines.workbench.source.file)).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByLabelText(en.pipelines.field.bloblang)).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByLabelText(en.pipelines.field.targetEndpoint)).toHaveFocus();
  });
});

describe("what the workbench reads from an answer", () => {
  it("reads_an_answer_of_another_shape_as_nothing_rather_than_breaking", () => {
    expect(readSample({ kind: "Change" })).toEqual({ records: [], fields: [], count: 0, truncated: false, errors: [] });
    expect(readSample(null).records).toEqual([]);
    expect(readValidation({ verdicts: [{ index: "x", ok: "yes", problems: [null] }] }).verdicts).toEqual([
      { index: 0, ok: false, problems: [] },
    ]);
  });

  it("names_the_class_a_mapping_writes_and_an_example_per_range", () => {
    expect(classOfMapping('root.type = "Tram"', ["Bus", "Tram"])).toBe("Tram");
    expect(classOfMapping('root.type = "Ferry"', ["Bus", "Tram"])).toBe("Bus");
    expect(classOfMapping("", [])).toBeUndefined();
    expect(exampleOf({ range: "integer", kind: "Property" })).toBe("12");
    expect(exampleOf({ range: "Station", kind: "Relationship" })).toBe('"urn:ngsi-ld:…"');
    expect(exampleOf({ range: "Level", kind: "Property" }, "good")).toBe('"good"');
  });
});
