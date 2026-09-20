import { useState } from "react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Manifest } from "../../api/manifest";
import { Button, Field, fieldIds } from "../../components/ui";
import processorCatalogue from "../../schemas/bento-processors.json";
import { COMPUTE_KINDS } from "../../schemas/kinds";
import type { PipelineForm, StepForm } from "./PipelineEditor";
import { sourceKindOf } from "./PipelineStudio";
import type { Trace } from "./PipelineTest";

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

/** The runner's summary as plain words: its Markdown links keep their text and lose the target. */
export const plainSummary = (summary: string): string =>
  summary.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

/** A step node is `step-<index into form.processors>`; the other three are what they were. */
export type FlowNodeId = "source" | "compute" | "output" | `step-${number}`;

export const stepIndexOf = (id: FlowNodeId | null): number | undefined =>
  id?.startsWith("step-") ? Number(id.slice(5)) : undefined;

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

export function toFlow(form: PipelineForm | undefined): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const sk = sourceKindOf(form);
  const sourceRef =
    form?.source?.dataSourceRef ||
    (typeof form?.source?.endpointRef === "object"
      ? (form.source.endpointRef as { name?: string })?.name
      : form?.source?.endpointRef) ||
    "";
  const queryType = (form?.source?.query?.type as string | undefined) ?? "";
  const sourceSummary = [sourceRef, queryType].filter(Boolean).join(" · ");

  const sourceNode: FlowNode = {
    id: "source",
    kind: sk,
    label: "Source",
    summary: sourceSummary,
    present: true,
  };

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
  const nodes = [
    sourceNode,
    ...steps.filter(({ entry }) => !entry.after).map(({ node }) => node),
    ...(computeNode ? [computeNode] : []),
    ...steps.filter(({ entry }) => entry.after).map(({ node }) => node),
    outputNode,
  ];
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));
  return { nodes, edges };
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

  for (const err of trace.errors ?? []) {
    const stage = (err.stage || "").toLowerCase();
    if (stage.includes("mapping") || stage.includes("compute") || stage.includes("bloblang")) {
      if (!computeError) computeError = err.message;
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
  const errorsByNode: Record<string, string | undefined> = {
    source: sourceError,
    [failing?.id ?? "compute"]: computeError,
    output: outputError,
  };

  const eventsInByNode: Record<string, number | undefined> = {
    source: trace.input?.events ?? 0,
    compute: trace.input?.events ?? 0,
    output: trace.mapping?.length ?? 0,
  };

  const eventsOutByNode: Record<string, number | undefined> = {
    source: trace.input?.events ?? 0,
    compute: trace.mapping?.length ?? 0,
    output: (trace.validation ?? []).filter((v) => v.ok).length,
  };

  let errorEncountered = false;
  for (const node of nodes) {
    const err = errorsByNode[node.id];
    let state: NodePaint["state"] = "ok";
    if (errorEncountered) {
      state = "skipped";
    } else if (err) {
      state = "error";
      errorEncountered = true;
    }
    result[node.id] = {
      eventsIn: eventsInByNode[node.id],
      eventsOut: eventsOutByNode[node.id],
      error: err,
      state,
    };
  }

  return result;
}

export interface PipelineFlowProps {
  form: PipelineForm | undefined;
  onChange: (f: PipelineForm) => void;
  trace: Trace | null;
  selected: FlowNodeId | null;
  onSelect: (id: FlowNodeId | null) => void;
  dataSources: Manifest[];
  endpoints: Manifest[];
}

export function PipelineFlow({
  form,
  onChange,
  trace,
  selected,
  onSelect,
}: PipelineFlowProps): JSX.Element {
  const { t } = useTranslation();
  const { nodes, edges } = toFlow(form);
  const paint = paintOf(trace, nodes);

  const nodeWidth = 200;
  const nodeHeight = 100;
  const nodeSpacing = 240;
  const startX = 20;
  const startY = 25;
  const svgWidth = Math.max(nodes.length * nodeSpacing + 40, 520);
  const svgHeight = 150;

  const insert = (name: string, after: FlowNodeId | null) => {
    const added = addStep(form, after, name);
    if (added) {
      onChange(added.form);
      onSelect(added.id);
    }
  };
  const remove = (id: FlowNodeId) => {
    const index = stepIndexOf(id);
    onChange(index === undefined || !form ? setComputeKind(form, null) : removeStep(form, index));
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

      <div className="flex flex-col gap-1" data-testid="palette-processors">
        <span id="flow-processors" className="text-caption font-semibold text-fg">
          {t("pipelines.flow.processors")}
        </span>
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
      </div>

      {/* SVG Canvas */}
      <div className="w-full overflow-x-auto rounded-md border border-border bg-surface-subtle p-2">
        <svg
          role="img"
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
              // The node the drop landed on or behind; a canvas with no layout (no width yet)
              // has no place to read, and the selection says where instead.
              const box = e.currentTarget.getBoundingClientRect();
              const x = box.width > 0 ? ((e.clientX - box.left) / box.width) * svgWidth : -1;
              const under = Math.min(Math.floor((x - startX) / nodeSpacing), nodes.length - 1);
              insert(kind.slice(10), x < 0 ? selected : under < 0 ? "source" : nodes[under].id);
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
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#94a3b8" />
            </marker>
          </defs>

          {/* Edges */}
          {edges.map((edge) => {
            const fromIdx = nodes.findIndex((n) => n.id === edge.from);
            const toIdx = nodes.findIndex((n) => n.id === edge.to);
            if (fromIdx < 0 || toIdx < 0) return null;
            const x1 = startX + fromIdx * nodeSpacing + nodeWidth;
            const y1 = startY + nodeHeight / 2;
            const x2 = startX + toIdx * nodeSpacing;
            const y2 = startY + nodeHeight / 2;
            return (
              <line
                key={`${edge.from}-${edge.to}`}
                x1={x1}
                y1={y1}
                x2={x2 - 4}
                y2={y2}
                stroke="#94a3b8"
                strokeWidth={2}
                markerEnd="url(#flow-arrow)"
              />
            );
          })}

          {/* Nodes */}
          {nodes.map((node, idx) => {
            const x = startX + idx * nodeSpacing;
            const y = startY;
            const isSelected = selected === node.id;
            const nodePaint = paint[node.id] ?? { state: "idle" };
            const strokeColor =
              nodePaint.state === "error"
                ? "#dc2626"
                : nodePaint.state === "skipped"
                  ? "#9ca3af"
                  : nodePaint.state === "ok"
                    ? "#16a34a"
                    : isSelected
                      ? "#2563eb"
                      : "var(--color-border, #cbd5e1)";

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
                className="cursor-pointer focus:outline-none"
                onClick={() => onSelect(node.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(node.id);
                  } else if (
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
                  fill="var(--color-surface, #ffffff)"
                  stroke={strokeColor}
                  strokeWidth={isSelected ? 2.5 : 1.5}
                />
                <text
                  x={x + 12}
                  y={y + 22}
                  className="font-semibold select-none"
                  style={{ fontSize: "13px" }}
                  fill="var(--color-fg, #0f172a)"
                >
                  {t(
                    `pipelines.flow.node.${stepIndexOf(node.id) === undefined ? node.id : "step"}`,
                    { defaultValue: node.label },
                  )}
                </text>
                <text
                  x={x + nodeWidth - 12}
                  y={y + 22}
                  textAnchor="end"
                  className="font-mono select-none"
                  style={{ fontSize: "11px" }}
                  fill="var(--color-fg-muted, #64748b)"
                >
                  {node.kind}
                </text>
                {summary ? (
                  <text
                    x={x + 12}
                    y={y + 44}
                    className="select-none"
                    style={{ fontSize: "11px" }}
                    fill="var(--color-fg-muted, #475569)"
                  >
                    {summary}
                  </text>
                ) : null}

                {nodePaint.eventsIn !== undefined ? (
                  <text
                    x={x + 12}
                    y={y + 66}
                    className="font-mono select-none"
                    style={{ fontSize: "11px" }}
                    fill="var(--color-fg-muted, #64748b)"
                  >
                    ↓ {nodePaint.eventsIn}  ↑ {nodePaint.eventsOut ?? 0}
                  </text>
                ) : null}

                {errorSummary ? (
                  <text
                    x={x + 12}
                    y={y + 86}
                    className="font-mono select-none"
                    style={{ fontSize: "10px" }}
                    fill="#dc2626"
                  >
                    {errorSummary}
                  </text>
                ) : nodePaint.state === "ok" ? (
                  <text
                    x={x + 12}
                    y={y + 86}
                    className="font-medium select-none"
                    style={{ fontSize: "11px" }}
                    fill="#16a34a"
                  >
                    ok
                  </text>
                ) : nodePaint.state === "skipped" ? (
                  <text
                    x={x + 12}
                    y={y + 86}
                    className="font-medium select-none"
                    style={{ fontSize: "11px" }}
                    fill="#9ca3af"
                  >
                    skipped
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

export interface StepBlockProps {
  entry: StepForm;
  onChange: (entry: StepForm) => void;
  onRemove: () => void;
}

/**
 * The selected step's own Bento block as YAML (PL-56): `<processor>: <config>`, nothing of a
 * neighbour's. What is typed reaches the form only while it is one processor the runner ships;
 * until then the form keeps the last block that was, and the reason stands under the text.
 * Mount it with the node's id as `key`: the text is the author's until another node is chosen.
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
  const id = "flow-step-yaml";
  const found = (processorCatalogue as Processor[]).find(({ name }) => name === processor?.[0]);

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
      {processor ? (
        <Field
          id={id}
          label={t("pipelines.flow.stepYaml")}
          description={found ? plainSummary(found.summary) : undefined}
          help={t("pipelines.flow.stepYamlHint")}
          errors={problem ? [problem] : undefined}
        >
          <textarea
            id={id}
            data-testid="flow-step-yaml"
            rows={8}
            spellCheck={false}
            aria-invalid={problem ? true : undefined}
            aria-describedby={[
              found ? fieldIds(id).description : "",
              fieldIds(id).help,
              problem ? fieldIds(id).error : "",
            ]
              .filter(Boolean)
              .join(" ")}
            className="focus-ring w-full rounded-md border border-border bg-surface p-2 font-mono text-caption text-fg"
            value={text}
            onChange={(e) => typed(e.target.value)}
          />
        </Field>
      ) : (
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
