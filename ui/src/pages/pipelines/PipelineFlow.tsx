import { useMemo, useState } from "react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { localized } from "../../api/manifest";
import type { Manifest } from "../../api/manifest";
import type { ErrorSchema } from "@rjsf/utils";
import { SchemaForm } from "../../components/forms/SchemaForm";
import { TypePicker } from "../../components/pickers/TypePicker";
import { Button, Field, Input, Select, Tabs, tabPanelProps, Textarea } from "../../components/ui";
import processorCatalogue from "../../schemas/bento-processors.json";
import { COMPUTE_KINDS, OUTPUT_MODES, YamlFieldError } from "../../schemas/kinds";
import type { OutputForm, PipelineForm, SourceForm, StepForm } from "./PipelineEditor";
import { spaceOf } from "../spaces/SpaceInside";
import { sourceKindOf } from "./PipelineStudio";
import type { Trace } from "./PipelineTest";
import { errorAt, fromFormData, toFormData, useProcessorForms, withHelp } from "./processorForm";

/** One processor of the pinned runner: the list jc-core admits a `processor` step from (PL-52). */
export interface Processor {
  name: string;
  category: string;
  summary: string;
}

/** The runner's processors by category, in the catalogue's order (PL-56). */
export const PROCESSOR_GROUPS: { category: string; processors: Processor[] }[] = (() => {
  const groups = new Map<string, Processor[]>();
  for (const processor of processorCatalogue as Processor[]) {
    groups.set(processor.category, [...(groups.get(processor.category) ?? []), processor]);
  }
  return [...groups].map(([category, processors]) => ({ category, processors }));
})();

const PROCESSOR_NAMES = new Set((processorCatalogue as Processor[]).map(({ name }) => name));
const PROCESSOR_COUNT = PROCESSOR_NAMES.size;

/** The runner's summary as plain words: its Markdown links keep their text and lose the target. */
export const plainSummary = (summary: string): string =>
  summary.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

/**
 * A step node is `step-<index into form.processors>`, a second source `source-<index into
 * form.moreSources>` and a second output `output-<index into form.moreOutputs>`; the first
 * source, the compute step and the first output are what they were, so everything the studio
 * hangs off `"source"` still finds it.
 */
export type FlowNodeId =
  | "source"
  | "compute"
  | "output"
  | `step-${number}`
  | `source-${number}`
  | `output-${number}`;

export const stepIndexOf = (id: FlowNodeId | null): number | undefined =>
  id?.startsWith("step-") ? Number(id.slice(5)) : undefined;

export const sourceIndexOf = (id: FlowNodeId | null): number | undefined =>
  id?.startsWith("source-") ? Number(id.slice(7)) : undefined;

const isSource = (id: FlowNodeId): boolean => id === "source" || id.startsWith("source-");

export const outputIndexOf = (id: FlowNodeId | null): number | undefined =>
  id?.startsWith("output-") ? Number(id.slice(7)) : undefined;

const isOutput = (id: FlowNodeId): boolean => id === "output" || id.startsWith("output-");

export interface FlowNode {
  id: FlowNodeId;
  kind: string;
  label: string;
  summary: string;
  present: boolean;
}

export interface FlowEdge {
  from: FlowNodeId;
  to: FlowNodeId;
}

/** The one processor a `processor` step names, or nothing for a compute or `mappingRef` step. */
export function processorOf(step: StepForm["step"]): [string, unknown] | undefined {
  const { processor } = step;
  if (typeof processor !== "object" || processor === null) return undefined;
  const [entry] = Object.entries(processor);
  return entry;
}

function stepNode(entry: StepForm, index: number): FlowNode {
  const processor = processorOf(entry.step);
  const config = processor?.[1];
  const summary =
    typeof config === "string"
      ? (config.trim().split("\n")[0] ?? "")
      : config && typeof config === "object"
        ? Object.keys(config).join(" · ")
        : "";
  const kind = processor?.[0] ?? (typeof entry.step.kind === "string" ? entry.step.kind : "mapping");
  return { id: `step-${index}`, kind, label: "Step", summary, present: true };
}

/** What a source reads, in the words the canvas has room for. */
function sourceNodeOf(source: SourceForm | undefined, id: FlowNodeId): FlowNode {
  const ref =
    source?.dataSourceRef ||
    (typeof source?.endpointRef === "object"
      ? ((source.endpointRef as { name?: string })?.name ?? "")
      : source?.endpointRef) ||
    "";
  const queryType = (source?.query?.type as string | undefined) ?? "";
  return {
    id,
    kind: source?.dataSourceRef ? "datasource" : source?.endpointRef ? "space" : "none",
    label: "Source",
    summary: [ref, queryType].filter(Boolean).join(" · "),
    present: true,
  };
}

export function toFlow(form: PipelineForm | undefined): { nodes: FlowNode[]; edges: FlowEdge[] } {
  // The first source keeps `sourceKindOf`, which is the kind the studio's own source section
  // chose and can be `none` while nothing is picked yet.
  const sourceNode: FlowNode = { ...sourceNodeOf(form?.source, "source"), kind: sourceKindOf(form) };
  const moreSourceNodes = (form?.moreSources ?? []).map((source, index) =>
    sourceNodeOf(source, `source-${index}`),
  );

  const targetName = form?.targetEndpoint ? form.targetEndpoint.split(":").pop() ?? "" : "";
  const outputSummary = [form?.output?.type, form?.output?.mode, targetName]
    .filter(Boolean)
    .join(" · ");

  const outputNode: FlowNode = {
    id: "output",
    kind: "output",
    label: "Output",
    summary: outputSummary,
    present: true,
  };
  const moreOutputNodes = (form?.moreOutputs ?? []).map(
    (output, index): FlowNode => ({
      id: `output-${index}`,
      kind: "output",
      label: "Output",
      summary: [output.type, output.mode, output.targetEndpoint?.split(":").pop()]
        .filter(Boolean)
        .join(" · "),
      present: true,
    }),
  );

  let computeNode: FlowNode | undefined;
  if (form?.compute?.kind) {
    let computeSummary = "";
    if (form.compute.kind === "bloblang") {
      computeSummary = (form.compute.bloblang ?? "").trim().split("\n")[0] ?? "";
    } else if (form.compute.kind === "mapping") {
      computeSummary = form.compute.mappingRef ?? "";
    } else if (form.compute.kind === "wasm" || form.compute.kind === "container") {
      computeSummary = [form.compute.module, form.compute.function].filter(Boolean).join(".");
    }
    computeNode = {
      id: "compute",
      kind: form.compute.kind,
      label: "Compute",
      summary: computeSummary,
      present: true,
    };
  }

  // One lane, in the order the steps run (PL-56): the manifest stores no edges, so an edge is
  // nothing but two neighbours.
  const steps = (form?.processors ?? []).map((entry, index) => ({
    entry,
    node: stepNode(entry, index),
  }));
  const lane = [
    ...steps.filter(({ entry }) => !entry.after).map(({ node }) => node),
    ...(computeNode ? [computeNode] : []),
    ...steps.filter(({ entry }) => entry.after).map(({ node }) => node),
  ];
  const sources = [sourceNode, ...moreSourceNodes];
  const outputs = [outputNode, ...moreOutputNodes];
  // Every source feeds the head of the lane, which is how the runner merges them (PL-53), and
  // its tail feeds every output, which is how it fans out (PL-55): a `broker` is not a node an
  // author places, so the canvas draws none.
  const tail = lane.length > 0 ? [lane[lane.length - 1]] : sources;
  const edges: FlowEdge[] = [
    ...(lane.length > 0 ? sources.map((source) => ({ from: source.id, to: lane[0].id })) : []),
    ...lane.slice(1).map((node, index) => ({ from: lane[index].id, to: node.id })),
    ...tail.flatMap((from) => outputs.map((output) => ({ from: from.id, to: output.id }))),
  ];
  return { nodes: [...sources, ...lane, ...outputs], edges };
}

/** The form with one more source to read, and the node it became (PL-52). */
export function addSource(form: PipelineForm | undefined): { form: PipelineForm; id: FlowNodeId } {
  const base: PipelineForm = form ?? { class: "auto" };
  const more = [...(base.moreSources ?? []), {}];
  return { form: { ...base, moreSources: more }, id: `source-${more.length - 1}` };
}

/**
 * The form without the second source `index`. The first source is the one the sample, the KPI
 * preset and the access panel read, so it is never removed here — the source section clears it.
 */
export function removeSource(form: PipelineForm, index: number): PipelineForm {
  return { ...form, moreSources: (form.moreSources ?? []).filter((_, at) => at !== index) };
}

/** The form with one more output, empty until an Endpoint is picked, and the node it became. */
export function addOutput(form: PipelineForm | undefined): { form: PipelineForm; id: FlowNodeId } {
  const base: PipelineForm = form ?? { class: "auto" };
  const more = [...(base.moreOutputs ?? []), { mode: "upsert" }];
  return { form: { ...base, moreOutputs: more }, id: `output-${more.length - 1}` };
}

/** The form without the second output `index`; the first output is what the pipeline writes. */
export function removeOutput(form: PipelineForm, index: number): PipelineForm {
  return { ...form, moreOutputs: (form.moreOutputs ?? []).filter((_, at) => at !== index) };
}

/**
 * What a processor starts as. The runner refuses `mapping: {}`: a mapping is text and a
 * composition is a list, so each starts as the smallest block its own shape lints green.
 */
function blankConfig(name: string): unknown {
  if (["mapping", "mutation", "bloblang"].includes(name)) return "root = this";
  if (["catch", "try", "for_each", "switch", "group_by", "parallel"].includes(name)) return [];
  return {};
}

/**
 * The form with processor `name` put behind node `after` (PL-56), and the node it became.
 * Behind the source is the head of the lane; behind the output, or behind nothing, is its tail,
 * because nothing runs after an output. A name the runner does not ship changes nothing.
 */
export function addStep(
  form: PipelineForm | undefined,
  after: FlowNodeId | null,
  name: string,
): { form: PipelineForm; id: FlowNodeId } | undefined {
  if (!PROCESSOR_NAMES.has(name)) return undefined;
  const base: PipelineForm = form ?? { class: "auto" };
  const steps = base.processors ?? [];
  const head = steps.filter((entry) => !entry.after);
  const tail = steps.filter((entry) => entry.after);
  const step = { processor: { [name]: blankConfig(name) } };
  const at = stepIndexOf(after);
  let index: number;
  if (after === "source") {
    index = 0;
    head.unshift({ step });
  } else if (after === "compute" || (at !== undefined && steps[at]?.after)) {
    // Behind the compute step, or behind a step that already runs after it.
    index = after === "compute" ? head.length : (at as number) + 1;
    tail.splice(index - head.length, 0, { step, after: true });
  } else if (at !== undefined && at < head.length) {
    index = at + 1;
    head.splice(index, 0, { step });
  } else if (base.compute?.kind || tail.length > 0) {
    index = steps.length;
    tail.push({ step, after: true });
  } else {
    index = head.length;
    head.push({ step });
  }
  return { form: { ...base, processors: [...head, ...tail] }, id: `step-${index}` };
}

/** The form without step `index`. The list stays, empty, so the save drops the step too. */
export function removeStep(form: PipelineForm, index: number): PipelineForm {
  return { ...form, processors: (form.processors ?? []).filter((_, at) => at !== index) };
}

export function setComputeKind(form: PipelineForm | undefined, kind: string | null): PipelineForm {
  const base: PipelineForm = form ? { ...form } : { class: "auto" };
  if (!kind) {
    const rest: PipelineForm = { ...base };
    delete rest.compute;
    return rest;
  }
  const prev = base.compute;
  const compute: NonNullable<PipelineForm["compute"]> = { kind };
  if (kind === "bloblang") {
    if (prev?.bloblang) compute.bloblang = prev.bloblang;
  } else if (kind === "mapping") {
    if (prev?.mappingRef) compute.mappingRef = prev.mappingRef;
  } else if (kind === "wasm" || kind === "container") {
    if (prev?.module) compute.module = prev.module;
    if (prev?.function) compute.function = prev.function;
  }
  return { ...base, compute };
}

export interface NodePaint {
  eventsIn?: number;
  eventsOut?: number;
  error?: string;
  state: "ok" | "error" | "skipped" | "idle";
}

export function paintOf(trace: Trace | null, nodes: FlowNode[]): Record<string, NodePaint> {
  const result: Record<string, NodePaint> = {
    source: { state: "idle" },
    compute: { state: "idle" },
    output: { state: "idle" },
  };
  for (const node of nodes) result[node.id] = { state: "idle" };

  if (!trace) {
    return result;
  }

  let sourceError: string | undefined;
  let computeError: string | undefined;
  let outputError: string | undefined;
  // A mapping error that names its step (PL-43) paints that step and nothing else; the lane's
  // steps are `form.processors` and the compute step, in the order the manifest writes them.
  const stepErrors = new Map<number, string>();

  for (const err of trace.errors ?? []) {
    const stage = (err.stage || "").toLowerCase();
    if (stage.includes("mapping") || stage.includes("compute") || stage.includes("bloblang")) {
      if (typeof err.step === "number" && err.step >= 0) {
        if (!stepErrors.has(err.step)) stepErrors.set(err.step, err.message);
      } else if (!computeError) {
        computeError = err.message;
      }
    } else if (stage.includes("input") || stage.includes("source")) {
      if (!sourceError) sourceError = err.message;
    } else if (stage.includes("validation") || stage.includes("output")) {
      if (!outputError) outputError = err.message;
    } else {
      if (!computeError) computeError = err.message;
    }
  }

  if (!outputError) {
    const failedVal = trace.validation?.find((v) => !v.ok);
    if (failedVal) {
      outputError =
        failedVal.problems && failedVal.problems.length > 0
          ? failedVal.problems[0]
          : "validation failed";
    }
  }

  // A lane without a compute step still has somewhere a mapping can fail: its first step.
  const failing =
    nodes.find((node) => node.id === "compute") ??
    nodes.find((node) => stepIndexOf(node.id) !== undefined);
  // The trace has one input stage however many sources feed it, so each of them shows it.
  const sourceNodes = nodes.filter((node) => isSource(node.id));
  const read = trace.input?.events ?? 0;
  // The lane in manifest order, so a step index from the trace names the node that ran it.
  const lane = nodes.filter((node) => !isSource(node.id) && !isOutput(node.id));
  const errorsByNode: Record<string, string | undefined> = {
    ...Object.fromEntries(sourceNodes.map((node) => [node.id, sourceError])),
    ...Object.fromEntries(
      [...stepErrors].flatMap(([at, message]) => (lane[at] ? [[lane[at].id, message]] : [])),
    ),
    output: outputError,
  };
  // A mapping error that named no step, or one the lane has no node for, still has to be said:
  // it goes where it went before, on the step that would have run it.
  const unplaced =
    computeError ??
    [...stepErrors].find(([at]) => !lane[at])?.[1];
  if (unplaced && failing && !errorsByNode[failing.id]) {
    errorsByNode[failing.id] = unplaced;
  }

  const eventsInByNode: Record<string, number | undefined> = {
    ...Object.fromEntries(sourceNodes.map((node) => [node.id, read])),
    compute: read,
    output: trace.mapping?.length ?? 0,
  };

  const eventsOutByNode: Record<string, number | undefined> = {
    ...Object.fromEntries(sourceNodes.map((node) => [node.id, read])),
    compute: trace.mapping?.length ?? 0,
    output: (trace.validation ?? []).filter((v) => v.ok).length,
  };

  // The sources are one stage however many there are: the trace carries a single input stage and
  // does not say which source it came from, so a failed read marks them all rather than claiming
  // one failed and the others never ran. Behind them the lane stops at its first error.
  let errorEncountered = Boolean(sourceError);
  for (const node of nodes) {
    // Every output writes the same messages (PL-55): a second one is painted as the first.
    if (outputIndexOf(node.id) !== undefined) continue;
    const key = node.id;
    const err = errorsByNode[key];
    let state: NodePaint["state"] = "ok";
    if (isSource(node.id)) {
      state = err ? "error" : "ok";
    } else if (errorEncountered) {
      state = "skipped";
    } else if (err) {
      state = "error";
      errorEncountered = true;
    }
    result[node.id] = {
      eventsIn: eventsInByNode[key],
      eventsOut: eventsOutByNode[key],
      error: err,
      state,
    };
  }
  for (const node of nodes) {
    if (outputIndexOf(node.id) !== undefined) result[node.id] = { ...result.output };
  }

  return result;
}

/** What one component of the running stream counted, by its label (API/01 §7, PL-66). */
export type NodeCounters = Record<
  string,
  { received?: number | null; sent?: number | null; errors?: number | null }
>;

/**
 * The flow painted from the running stream (PL-66): each node with the counters of its own
 * label, `input` for the sources, `step_{j}` for the `j`-th processor step, `compute` and
 * `output`. A node with errors since the runner started is failing; one the runner reports
 * nothing for is idle. `errorsSentence` says the count in the page's language.
 */
export function paintOfCounters(
  counters: NodeCounters,
  nodes: FlowNode[],
  errorsSentence: (count: number) => string,
): Record<string, NodePaint> {
  const labelOf = (id: FlowNodeId): string => {
    if (isSource(id)) return "input";
    // The fan-out is one broker labelled `output`; its outputs are not counted one by one.
    if (isOutput(id)) return "output";
    const step = stepIndexOf(id);
    return step !== undefined ? `step_${step}` : id;
  };
  return Object.fromEntries(
    nodes.map((node) => {
      const counted = counters[labelOf(node.id)];
      if (!counted) return [node.id, { state: "idle" } satisfies NodePaint];
      const errors = counted.errors ?? 0;
      const paint: NodePaint = {
        eventsIn: counted.received ?? undefined,
        eventsOut: counted.sent ?? undefined,
        state: errors > 0 ? "error" : "ok",
        error: errors > 0 ? errorsSentence(errors) : undefined,
      };
      return [node.id, paint];
    }),
  );
}

export interface PipelineFlowProps {
  form: PipelineForm | undefined;
  onChange: (f: PipelineForm) => void;
  trace: Trace | null;
  /** The running stream's counters per node; painted whenever no test result is on screen. */
  live?: NodeCounters;
  selected: FlowNodeId | null;
  onSelect: (id: FlowNodeId | null) => void;
  dataSources: Manifest[];
  endpoints: Manifest[];
}

export function PipelineFlow({
  form,
  onChange,
  trace,
  live,
  selected,
  onSelect,
}: PipelineFlowProps): JSX.Element {
  const { t } = useTranslation();
  const { nodes, edges } = toFlow(form);
  // A test result is what the author just asked for; without one, the running stream speaks.
  const showsLive = !trace && live !== undefined && Object.keys(live).length > 0;
  const paint = showsLive
    ? paintOfCounters(live, nodes, (count) => t("pipelines.flow.liveErrors", { count }))
    : paintOf(trace, nodes);

  const nodeWidth = 200;
  const nodeHeight = 100;
  const nodeSpacing = 240;
  const rowSpacing = 120;
  const startX = 20;
  const startY = 25;

  // Sources stand in the left column and outputs in the right one, each one under the other,
  // and the lane runs between them along the middle of the taller column (PL-56).
  const sourceCount = nodes.filter((node) => isSource(node.id)).length;
  const outputCount = nodes.filter((node) => isOutput(node.id)).length;
  const laneCount = nodes.length - sourceCount - outputCount;
  const columnHeight = (Math.max(sourceCount, outputCount) - 1) * rowSpacing;
  const column = (count: number, at: number) =>
    startY + (columnHeight - (count - 1) * rowSpacing) / 2 + at * rowSpacing;
  const placed = nodes.map((node, index) => {
    if (isSource(node.id)) return { node, x: startX, y: column(sourceCount, index) };
    if (isOutput(node.id)) {
      const at = index - sourceCount - laneCount;
      return { node, x: startX + (laneCount + 1) * nodeSpacing, y: column(outputCount, at) };
    }
    return { node, x: startX + (index - sourceCount + 1) * nodeSpacing, y: startY + columnHeight / 2 };
  });
  const place = (id: FlowNodeId) => placed.find(({ node }) => node.id === id);
  const svgWidth = Math.max((laneCount + 2) * nodeSpacing + 40, 520);
  const svgHeight = 150 + columnHeight;

  const insert = (name: string, after: FlowNodeId | null) => {
    const added = addStep(form, after, name);
    if (added) {
      onChange(added.form);
      onSelect(added.id);
    }
  };
  const remove = (id: FlowNodeId) => {
    const step = stepIndexOf(id);
    const source = sourceIndexOf(id);
    const output = outputIndexOf(id);
    if (!form) return;
    onChange(
      step !== undefined
        ? removeStep(form, step)
        : source !== undefined
          ? removeSource(form, source)
          : output !== undefined
            ? removeOutput(form, output)
            : setComputeKind(form, null),
    );
    onSelect(null);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Palette */}
      <div
        role="toolbar"
        aria-label={t("pipelines.flow.palette", { defaultValue: "Compute palette" })}
        className="flex flex-wrap items-center gap-2"
      >
        <span className="text-caption font-semibold text-fg">
          {t("pipelines.flow.palette", { defaultValue: "Palette" })}:
        </span>
        {COMPUTE_KINDS.map((kind) => (
          <Button
            key={kind}
            size="sm"
            variant="secondary"
            data-testid={`palette-${kind}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", kind);
            }}
            onClick={() => {
              onChange(setComputeKind(form, kind));
              onSelect("compute");
            }}
          >
            + {kind}
          </Button>
        ))}
        <Button
          size="sm"
          variant="secondary"
          data-testid="palette-source"
          onClick={() => {
            const added = addSource(form);
            onChange(added.form);
            onSelect(added.id);
          }}
        >
          {t("pipelines.flow.addSource")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          data-testid="palette-output"
          onClick={() => {
            const added = addOutput(form);
            onChange(added.form);
            onSelect(added.id);
          }}
        >
          {t("pipelines.flow.addOutput")}
        </Button>
        {form?.compute?.kind ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onChange(setComputeKind(form, null));
              if (selected === "compute") onSelect(null);
            }}
          >
            {t("pipelines.flow.remove", { defaultValue: "Remove compute" })}
          </Button>
        ) : null}
      </div>

      {/* SVG Canvas */}
      {showsLive ? (
        <p className="text-caption text-fg-muted" data-testid="flow-live">
          {t("pipelines.flow.live")}
        </p>
      ) : null}
      <div className="w-full overflow-x-auto rounded-md border border-border bg-surface-subtle p-2">
        {/*
          A group, not an image: the canvas holds the pipeline's nodes, and every node is a
          control a person tabs to and presses. `role="img"` promised a picture with nothing
          inside it, which is `nested-interactive` — a serious axe violation, and a screen
          reader that announces the diagram and then goes silent about the nine buttons in it.
        */}
        <svg
          role="group"
          data-testid="flow-canvas"
          aria-label={t("pipelines.flow.canvas", { defaultValue: "Pipeline canvas" })}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="h-40 min-w-full"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(e) => {
            e.preventDefault();
            const kind = e.dataTransfer.getData("text/plain");
            if (kind.startsWith("processor:")) {
              // The node the drop landed on or behind. A canvas with no layout yet (no width, as
              // in a test) has no place to read, and the selection says where instead.
              const box = e.currentTarget.getBoundingClientRect();
              const x = box.width > 0 ? ((e.clientX - box.left) / box.width) * svgWidth : -1;
              const y = box.height > 0 ? ((e.clientY - box.top) / box.height) * svgHeight : -1;
              const under = placed.find(
                (spot) => x >= spot.x && x < spot.x + nodeSpacing && y >= spot.y - rowSpacing / 2,
              );
              insert(kind.slice(10), x < 0 ? selected : (under?.node.id ?? "source"));
            } else if (COMPUTE_KINDS.includes(kind as (typeof COMPUTE_KINDS)[number])) {
              onChange(setComputeKind(form, kind));
              onSelect("compute");
            }
          }}
        >
          <defs>
            <marker
              id="flow-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" className="fill-border-strong" />
            </marker>
          </defs>

          {/* Edges */}
          {edges.map((edge) => {
            const from = place(edge.from);
            const to = place(edge.to);
            if (!from || !to) return null;
            const x1 = from.x + nodeWidth;
            const y1 = from.y + nodeHeight / 2;
            const x2 = to.x;
            const y2 = to.y + nodeHeight / 2;
            return (
              <line
                key={`${edge.from}-${edge.to}`}
                x1={x1}
                y1={y1}
                x2={x2 - 4}
                y2={y2}
                className="stroke-border-strong"
                strokeWidth={2}
                markerEnd="url(#flow-arrow)"
              />
            );
          })}

          {/* Nodes */}
          {placed.map(({ node, x, y }, idx) => {
            const isSelected = selected === node.id;
            const nodePaint = paint[node.id] ?? { state: "idle" };
            // The canvas paints with the same tokens as the page around it (UI-30): an SVG
            // attribute takes a colour value, which is why these were six literals and why the
            // whole diagram stayed light grey on white in the dark theme. A class is a token.
            const strokeClass =
              nodePaint.state === "error"
                ? "stroke-danger"
                : nodePaint.state === "skipped"
                  ? "stroke-fg-subtle"
                  : nodePaint.state === "ok"
                    ? "stroke-success"
                    : isSelected
                      ? "stroke-primary-soft-fg"
                      : "stroke-border";

            const summary =
              node.summary.length > 40 ? `${node.summary.slice(0, 39)}…` : node.summary;
            const errorSummary =
              nodePaint.error && nodePaint.error.length > 60
                ? `${nodePaint.error.slice(0, 59)}…`
                : nodePaint.error;

            return (
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                data-testid={`flow-node-${node.id}`}
                data-state={nodePaint.state}
                aria-pressed={isSelected}
                aria-label={`${node.label}: ${node.kind}`}
                className="focus-ring cursor-pointer"
                onClick={() => onSelect(node.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(node.id);
                  } else if (
                    // The first source and the output are what the pipeline is; the source
                    // section clears the first one, and a pipeline always writes somewhere.
                    (e.key === "Delete" || e.key === "Backspace") &&
                    node.id !== "source" &&
                    node.id !== "output"
                  ) {
                    e.preventDefault();
                    remove(node.id);
                  } else if (e.key === "ArrowRight") {
                    e.preventDefault();
                    const nextIdx = Math.min(idx + 1, nodes.length - 1);
                    onSelect(nodes[nextIdx].id);
                  } else if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    const prevIdx = Math.max(idx - 1, 0);
                    onSelect(nodes[prevIdx].id);
                  }
                }}
              >
                <rect
                  x={x}
                  y={y}
                  width={nodeWidth}
                  height={nodeHeight}
                  rx={8}
                  className={`fill-surface ${strokeClass}`}
                  strokeWidth={isSelected ? 2.5 : 1.5}
                />
                <text
                  x={x + 12}
                  y={y + 22}
                  className="select-none fill-fg text-body font-semibold"
                >
                  {t(
                    `pipelines.flow.node.${
                      stepIndexOf(node.id) !== undefined
                        ? "step"
                        : sourceIndexOf(node.id) !== undefined
                          ? "source"
                          : outputIndexOf(node.id) !== undefined
                            ? "output"
                            : node.id
                    }`,
                    { defaultValue: node.label },
                  )}
                </text>
                <text
                  x={x + nodeWidth - 12}
                  y={y + 22}
                  textAnchor="end"
                  className="select-none fill-fg-muted font-mono text-caption"
                >
                  {node.kind}
                </text>
                {summary ? (
                  <text
                    x={x + 12}
                    y={y + 44}
                    className="select-none fill-fg-muted text-caption"
                  >
                    {summary}
                  </text>
                ) : null}

                {nodePaint.eventsIn !== undefined ? (
                  <text
                    x={x + 12}
                    y={y + 66}
                    className="select-none fill-fg-muted font-mono text-caption"
                  >
                    ↓ {nodePaint.eventsIn}  ↑ {nodePaint.eventsOut ?? 0}
                  </text>
                ) : null}

                {errorSummary ? (
                  <text
                    x={x + 12}
                    y={y + 86}
                    className="select-none fill-danger font-mono text-caption"
                  >
                    {errorSummary}
                  </text>
                ) : nodePaint.state === "ok" ? (
                  <text
                    x={x + 12}
                    y={y + 86}
                    className="select-none fill-success text-caption font-medium"
                  >
                    ok
                  </text>
                ) : nodePaint.state === "skipped" ? (
                  <text
                    x={x + 12}
                    y={y + 86}
                    className="select-none fill-fg-subtle text-caption font-medium"
                  >
                    skipped
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Below the canvas, not above it: with the 75 processors in between, a dialog at
          1280x720 could not show a palette and the canvas it drops onto at the same time, and a
          drag that scrolled the canvas into view left its palette behind. Both palettes touch
          the canvas now. */}
      {/* One fold for all of them, shut: most pipelines take none, and nine open groups were
          the tallest thing on the form (T-2754). */}
      <details className="flex flex-col gap-1" data-testid="palette-processors">
        <summary
          id="flow-processors"
          className="focus-ring cursor-pointer rounded-md text-caption font-semibold text-fg"
        >
          {t("pipelines.flow.processors")} ({PROCESSOR_COUNT})
        </summary>
        <p className="text-caption text-fg-muted">{t("pipelines.flow.processorsHint")}</p>
        {PROCESSOR_GROUPS.map(({ category, processors }) => (
          <details key={category} className="rounded-md border border-border bg-surface">
            <summary className="focus-ring cursor-pointer rounded-md px-2 py-1 text-caption font-medium text-fg">
              {category} ({processors.length})
            </summary>
            <ul className="flex flex-col gap-1 p-2" aria-label={category}>
              {processors.map((processor) => (
                <li key={processor.name} className="flex items-baseline gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0 font-mono"
                    data-testid={`palette-processor-${processor.name}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", `processor:${processor.name}`);
                    }}
                    onClick={() => insert(processor.name, selected)}
                  >
                    + {processor.name}
                  </Button>
                  <span className="text-caption text-fg-muted">
                    {plainSummary(processor.summary)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </details>
    </div>
  );
}

export interface StepBlockProps {
  entry: StepForm;
  onChange: (entry: StepForm) => void;
  onRemove: () => void;
}

/**
 * The selected step's own Bento block (PL-56): a form generated from the runner's field tree of
 * that processor (T-3088), and the block as YAML, `<processor>: <config>`, nothing of a
 * neighbour's. Both edit the same config; what is typed reaches the form only while it is one
 * processor the runner ships, and until then the form keeps the last block that was, with the
 * reason at the field or under the text. Mount it with the node's id as `key`: the text is the
 * author's until another node is chosen.
 */
// ponytail: a textarea like the compute node's mapping, not Monaco; swap in MonacoSourceView
// when authors ask for completion inside a processor's fields.
export function StepBlock({ entry, onChange, onRemove }: StepBlockProps): JSX.Element {
  const { t } = useTranslation();
  const processor = processorOf(entry.step);
  const [text, setText] = useState(() =>
    stringifyYaml(processor ? { [processor[0]]: processor[1] } : entry.step),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [view, setView] = useState<"form" | "yaml">("form");
  // What the form starts from, taken when it opens: the form owns its text from then on, so a
  // YAML box half typed is not rewritten under the cursor by its own round trip.
  const [seed, setSeed] = useState<{ data: unknown } | null>(null);
  const [boxError, setBoxError] = useState<ErrorSchema | undefined>(undefined);
  const forms = useProcessorForms();
  const id = "flow-step-yaml";
  const found = (processorCatalogue as Processor[]).find(({ name }) => name === processor?.[0]);
  const form = processor ? forms?.processors[processor[0]] : undefined;
  const shown = form && view === "form" ? "form" : "yaml";
  if (processor && form && seed === null) {
    // The forms arrive after the first render the first time; the seed is taken then.
    setSeed({ data: toFormData(processor[1], form.schema, form.uiSchema) });
  }
  const uiSchema = useMemo(
    () =>
      form
        ? {
            ...withHelp(form.uiSchema, t("pipelines.flow.stepSecretHelp")),
            "ui:submitButtonOptions": { norender: true },
          }
        : undefined,
    [form, t],
  );

  const typed = (next: string) => {
    setText(next);
    let block: unknown;
    try {
      block = parseYaml(next);
    } catch (error) {
      setProblem(
        t("pipelines.flow.stepYamlInvalid", {
          reason: (error as Error).message.split("\n")[0],
        }),
      );
      return;
    }
    const names =
      block && typeof block === "object" && !Array.isArray(block) ? Object.keys(block) : [];
    if (names.length !== 1) {
      setProblem(t("pipelines.flow.stepYamlOne"));
    } else if (!PROCESSOR_NAMES.has(names[0])) {
      setProblem(t("pipelines.flow.stepYamlUnknown", { name: names[0] }));
    } else {
      setProblem(null);
      onChange({ ...entry, step: { ...entry.step, processor: block as Record<string, unknown> } });
    }
  };

  const filled = (data: unknown) => {
    if (!processor || !form) return;
    let config: unknown;
    try {
      config = fromFormData(data, form.schema, form.uiSchema, "", processor[1]);
    } catch (error) {
      if (!(error instanceof YamlFieldError)) throw error;
      setBoxError(
        errorAt(error.field, t("pipelines.flow.stepYamlInvalid", { reason: error.detail })),
      );
      return;
    }
    setBoxError(undefined);
    // The form reports itself once on opening; a block it did not change is not an edit.
    if (JSON.stringify(config ?? {}) === JSON.stringify(processor[1] ?? {})) return;
    const block = { [processor[0]]: config ?? {} };
    setText(stringifyYaml(block));
    setProblem(null);
    onChange({ ...entry, step: { ...entry.step, processor: block } });
  };

  const switchTo = (next: "form" | "yaml") => {
    if (next === "form" && processor && form) {
      setSeed({ data: toFormData(processor[1], form.schema, form.uiSchema) });
      setBoxError(undefined);
    }
    setView(next);
  };

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
      data-testid="flow-node-editor-step"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption font-semibold text-fg">
          {t("pipelines.flow.node.step")} ({processor?.[0] ?? String(entry.step.kind ?? "mapping")})
        </span>
        <Button size="sm" variant="ghost" data-testid="flow-step-remove" onClick={onRemove}>
          {t("pipelines.flow.removeStep")}
        </Button>
      </div>
      {processor && form ? (
        <Tabs
          id="flow-step-view"
          label={t("pipelines.flow.stepView")}
          variant="pill"
          tabs={[
            { value: "form", label: t("pipelines.flow.stepForm") },
            { value: "yaml", label: t("pipelines.flow.stepYamlTab") },
          ]}
          value={shown}
          onChange={switchTo}
        />
      ) : null}
      {processor && form && shown === "form" ? (
        <div
          {...tabPanelProps("flow-step-view", "form")}
          data-testid="flow-step-form"
          className="flex flex-col gap-2"
        >
          {found ? <p className="text-caption text-fg-muted">{plainSummary(found.summary)}</p> : null}
          <SchemaForm<unknown>
            // Keyed on the seed, so reopening the form after a YAML edit starts from that edit.
            key={JSON.stringify(seed?.data ?? null)}
            schema={form.schema}
            uiSchema={uiSchema}
            formData={seed?.data}
            extraErrors={boxError}
            onSubmit={() => undefined}
            onChange={filled}
          />
        </div>
      ) : null}
      {processor && shown === "yaml" ? (
        <div {...(form ? tabPanelProps("flow-step-view", "yaml") : {})}>
          <Field
            id={id}
            label={t("pipelines.flow.stepYaml")}
            description={found ? plainSummary(found.summary) : undefined}
            help={t("pipelines.flow.stepYamlHint")}
            errors={problem ? [problem] : undefined}
          >
            {/* The Field wires `aria-describedby` and `aria-invalid` onto the control it wraps,
                so the textarea no longer rebuilds the ids by hand (T-2314). */}
            <Textarea
              id={id}
              data-testid="flow-step-yaml"
              rows={8}
              spellCheck={false}
              className="p-2 font-mono text-caption"
              value={text}
              onChange={(e) => typed(e.target.value)}
            />
          </Field>
        </div>
      ) : processor ? null : (
        <>
          <pre
            data-testid="flow-step-readonly"
            className="max-h-48 overflow-auto rounded-md border border-border bg-surface-subtle p-2 font-mono text-caption break-words whitespace-pre-wrap text-fg"
          >
            {text}
          </pre>
          <p className="text-caption text-fg-muted">{t("pipelines.flow.stepReadOnly")}</p>
        </>
      )}
    </div>
  );
}

export interface SourceBlockProps {
  project: string;
  source: SourceForm;
  dataSources: Manifest[];
  endpoints: Manifest[];
  locale: string;
  onChange: (source: SourceForm) => void;
  onRemove: () => void;
}

/**
 * A source after the first (PL-52): one DataSource, or one Endpoint read through. The runner
 * merges it with the others through a `broker` input, so it needs nothing but what it reads;
 * the query, the sample and the access panel stay with the first source, which is the one the
 * studio's own section below edits.
 */
export function SourceBlock({
  project,
  source,
  dataSources,
  endpoints,
  locale,
  onChange,
  onRemove,
}: SourceBlockProps): JSX.Element {
  const { t } = useTranslation();
  const id = "flow-source-ref";
  const value = source.dataSourceRef
    ? `DataSource:${source.dataSourceRef}`
    : source.endpointRef
      ? `Endpoint:${source.endpointRef}`
      : "";

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
      data-testid="flow-node-editor-source"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption font-semibold text-fg">{t("pipelines.flow.node.source")}</span>
        <Button size="sm" variant="ghost" data-testid="flow-source-remove" onClick={onRemove}>
          {t("pipelines.flow.removeSource")}
        </Button>
      </div>
      <Field
        id={id}
        label={t("pipelines.flow.sourceReads")}
        help={t("pipelines.flow.sourceReadsHint")}
      >
        <Select
          id={id}
          data-testid="flow-source-ref"
          value={value}
          onChange={(event) => {
            const [kind, ...name] = event.target.value.split(":");
            const picked = name.join(":");
            onChange({
              ...source,
              dataSourceRef: kind === "DataSource" ? picked : undefined,
              endpointRef: kind === "Endpoint" ? picked : undefined,
              // A query is what an endpoint is asked; a DataSource reads its own connection.
              query: kind === "Endpoint" ? source.query : undefined,
            });
          }}
        >
          <option value="">—</option>
          <optgroup label={t("nav.datasources")}>
            {dataSources.map((manifest) => (
              <option key={manifest.metadata.name} value={`DataSource:${manifest.metadata.name}`}>
                {localized(manifest.metadata.title, locale, manifest.metadata.name)}
              </option>
            ))}
          </optgroup>
          <optgroup label={t("nav.endpoints")}>
            {endpoints.map((manifest) => (
              <option key={manifest.metadata.name} value={`Endpoint:${manifest.metadata.name}`}>
                {localized(manifest.metadata.title, locale, manifest.metadata.name)}
              </option>
            ))}
          </optgroup>
        </Select>
      </Field>
      {source.endpointRef ? (
        // What an endpoint source reads (PL-42): the type its space models, the attributes and
        // a filter, as the first source asks them; without a type the runner reads nothing (T-3088).
        <EndpointQuery
          project={project}
          space={(() => {
            const ep = endpoints.find((e) => e.metadata.name === source.endpointRef);
            return ep ? spaceOf(ep) : undefined;
          })()}
          query={source.query ?? {}}
          onChange={(query) => onChange({ ...source, query })}
        />
      ) : null}
    </div>
  );
}

/** The type, attributes and filter of an endpoint source; empty values leave the query. */
function EndpointQuery({
  project,
  space,
  query,
  onChange,
}: {
  project: string;
  space: string | undefined;
  query: Record<string, unknown>;
  onChange: (query: Record<string, unknown>) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const set = (key: string, value: unknown) => {
    const next = { ...query, [key]: value };
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
      delete next[key];
    }
    onChange(next);
  };
  const attrs = Array.isArray(query.attrs) ? (query.attrs as string[]) : [];
  // The text is the author's while typing; the query keeps the names it splits into.
  const [attrsText, setAttrsText] = useState(attrs.join(", "));
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid="flow-source-query">
      <Field id="flow-source-type" label={t("pipelines.field.queryType")} required>
        <TypePicker
          id="flow-source-type"
          label={t("pipelines.field.queryType")}
          labelled
          project={project}
          space={space}
          value={typeof query.type === "string" && query.type ? [query.type] : []}
          onChange={(types) => set("type", types[0])}
        />
      </Field>
      <Field id="flow-source-attrs" label={t("pipelines.field.attrs")} help={t("pipelines.flow.attrsHint")}>
        <Input
          id="flow-source-attrs"
          value={attrsText}
          onChange={(event) => {
            setAttrsText(event.target.value);
            set(
              "attrs",
              event.target.value
                .split(",")
                .map((name) => name.trim())
                .filter(Boolean),
            );
          }}
        />
      </Field>
      <Field id="flow-source-q" label={t("pipelines.field.q")} help={t("pipelines.studio.qHint")}>
        <Input
          id="flow-source-q"
          value={typeof query.q === "string" ? query.q : ""}
          onChange={(event) => set("q", event.target.value.trim() ? event.target.value : undefined)}
        />
      </Field>
    </div>
  );
}

export interface OutputBlockProps {
  project: string;
  output: OutputForm;
  /** The Endpoints this pipeline may write through, each with its URN when it has one. */
  targets: { manifest: Manifest; urn: string | undefined }[];
  locale: string;
  onChange: (output: OutputForm) => void;
  onRemove: () => void;
}

/**
 * An output after the first (PL-55): the Endpoint it writes through, the type and the write mode.
 * The runner fans every message out to all outputs, so each is a target the pipeline writes as
 * well, not a route a message takes.
 */
export function OutputBlock({ project, output, targets, locale, onChange, onRemove }: OutputBlockProps): JSX.Element {
  const { t } = useTranslation();
  const target = targets.find((candidate) => candidate.urn === output.targetEndpoint);
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
      data-testid="flow-node-editor-output"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption font-semibold text-fg">{t("pipelines.flow.node.output")}</span>
        <Button size="sm" variant="ghost" data-testid="flow-output-remove" onClick={onRemove}>
          {t("pipelines.flow.removeOutput")}
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field id="flow-output-target" label={t("pipelines.flow.outputWrites")} help={t("pipelines.flow.outputWritesHint")} required>
          <Select
            id="flow-output-target"
            data-testid="flow-output-target"
            value={output.targetEndpoint ?? ""}
            onChange={(event) => onChange({ ...output, targetEndpoint: event.target.value || undefined })}
          >
            <option value="">—</option>
            {/* A URN the list no longer offers stays visible rather than silently replaced. */}
            {output.targetEndpoint && !target ? (
              <option value={output.targetEndpoint}>{output.targetEndpoint}</option>
            ) : null}
            {targets
              .filter((candidate) => candidate.urn)
              .map(({ manifest, urn }) => (
                <option key={manifest.metadata.name} value={urn}>
                  {localized(manifest.metadata.title, locale, manifest.metadata.name)}
                </option>
              ))}
          </Select>
        </Field>
        <Field id="flow-output-mode" label={t("pipelines.field.outputMode")}>
          <Select
            id="flow-output-mode"
            value={output.mode ?? "upsert"}
            onChange={(event) => onChange({ ...output, mode: event.target.value })}
          >
            {OUTPUT_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`pipelines.field.modeChoice.${mode}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="flow-output-type" label={t("pipelines.field.outputType")}>
          <TypePicker
            id="flow-output-type"
            label={t("pipelines.field.outputType")}
            labelled
            project={project}
            space={target ? spaceOf(target.manifest) : undefined}
            value={output.type ? [output.type] : []}
            onChange={(types) => onChange({ ...output, type: types[0] })}
          />
        </Field>
      </div>
    </div>
  );
}
