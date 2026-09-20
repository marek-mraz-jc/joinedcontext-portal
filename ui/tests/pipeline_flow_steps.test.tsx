/**
 * T-1127, T-1128: the lane carries the runner's processors as steps (PL-52, PL-56). The palette
 * lists what the pinned runner ships by category, a processor goes in behind a chosen node, the
 * selected step shows its own Bento block as YAML, and what is removed on the canvas is removed
 * in the manifest.
 */
import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import type { Manifest } from "../src/api/manifest";
import type { PipelineForm } from "../src/pages/pipelines/PipelineEditor";
import { toEnvelope, toForm } from "../src/pages/pipelines/PipelineEditor";
import {
  PROCESSOR_GROUPS,
  PipelineFlow,
  addStep,
  paintOf,
  plainSummary,
  removeStep,
  toFlow,
} from "../src/pages/pipelines/PipelineFlow";
import { PipelineStudio } from "../src/pages/pipelines/PipelineStudio";
import type { Trace } from "../src/pages/pipelines/PipelineTest";

vi.mock("../src/branding", () => ({
  useBranding: () => ({ orgDomain: "hel.fi" }),
}));

const TARGET = "urn:ngsi-ld:Endpoint:hel.fi:mobility:ep-bikes";

const withCompute: PipelineForm = {
  name: "bikes",
  class: "auto",
  source: { dataSourceRef: "feed-bikes" },
  compute: { kind: "bloblang", bloblang: "root = this" },
  targetEndpoint: TARGET,
};

const pipeline = (steps: unknown[]): Manifest => ({
  apiVersion: "joinedcontext.com/v1alpha2",
  kind: "Pipeline",
  metadata: { name: "bikes", namespace: "helsinki" },
  spec: {
    class: "auto",
    sources: [{ dataSourceRef: { kind: "DataSource", name: "feed-bikes" } }],
    steps,
    outputs: [{ targetEndpoint: TARGET }],
  },
});

const stepsOf = (manifest: Manifest) => (manifest.spec as { steps?: unknown[] }).steps;

describe("the lane's steps", () => {
  it("draws the steps in the order they run, the compute step among them, neighbour to neighbour", () => {
    const form = toForm(
      pipeline([
        { processor: { unarchive: { format: "json_array" } } },
        { kind: "bloblang", bloblang: "root = this" },
        { processor: { jq: { query: ".id" } } },
      ]),
    );
    const { nodes, edges } = toFlow(form);
    expect(nodes.map((node) => `${node.id}:${node.kind}`)).toEqual([
      "source:datasource",
      "step-0:unarchive",
      "compute:bloblang",
      "step-1:jq",
      "output:output",
    ]);
    expect(nodes[1].summary).toBe("format");
    expect(edges).toEqual([
      { from: "source", to: "step-0" },
      { from: "step-0", to: "compute" },
      { from: "compute", to: "step-1" },
      { from: "step-1", to: "output" },
    ]);
  });

  it("puts a processor behind the node it was asked behind", () => {
    const head = addStep(withCompute, "source", "unarchive");
    expect(head?.id).toBe("step-0");
    expect(head?.form.processors).toEqual([{ step: { processor: { unarchive: {} } } }]);

    const behindCompute = addStep(head?.form, "compute", "jq");
    expect(behindCompute?.id).toBe("step-1");
    const tail = addStep(behindCompute?.form, null, "log");
    expect(tail?.id).toBe("step-2");
    const between = addStep(tail?.form, "step-1", "dedupe");
    expect(between?.id).toBe("step-2");
    const onOutput = addStep(between?.form, "output", "noop");

    expect(toFlow(onOutput?.form).nodes.map((node) => node.kind)).toEqual([
      "datasource",
      "unarchive",
      "bloblang",
      "jq",
      "dedupe",
      "log",
      "noop",
      "output",
    ]);
  });

  it("keeps the order in a lane without a compute step, and after one was taken out", () => {
    const bare: PipelineForm = { ...withCompute, compute: undefined };
    const one = addStep(bare, null, "unarchive");
    const two = addStep(one?.form, null, "jq");
    expect(two?.form.processors?.map((entry) => entry.after)).toEqual([undefined, undefined]);

    // The compute step is gone and a step still says it ran after it: the tail stays the tail.
    const orphaned: PipelineForm = {
      ...bare,
      processors: [{ step: { processor: { jq: {} } }, after: true }],
    };
    const added = addStep(orphaned, null, "log");
    expect(toFlow(added?.form).nodes.map((node) => node.kind)).toEqual([
      "datasource",
      "jq",
      "log",
      "output",
    ]);
  });

  it("starts a mapping as text and a composition as a list, which is what the runner lints green", () => {
    expect(addStep(undefined, null, "mapping")?.form.processors?.[0].step).toEqual({
      processor: { mapping: "root = this" },
    });
    expect(addStep(undefined, null, "catch")?.form.processors?.[0].step).toEqual({
      processor: { catch: [] },
    });
  });

  it("adds nothing for a name the runner does not ship, programs in the shared runner included", () => {
    for (const name of ["command", "subprocess", "", "__proto__", "JQ"]) {
      expect(addStep(withCompute, null, name)).toBeUndefined();
    }
    const names = PROCESSOR_GROUPS.flatMap(({ processors }) => processors.map(({ name }) => name));
    expect(names).not.toContain("command");
    expect(names).not.toContain("subprocess");
    expect(new Set(names).size).toBe(names.length);
    expect(PROCESSOR_GROUPS.every(({ processors }) => processors.length > 0)).toBe(true);
  });

  it("says a summary in words, without the runner's Markdown targets", () => {
    expect(plainSummary("offers [custom functions](#awk-functions) for it")).toBe(
      "offers custom functions for it",
    );
    expect(plainSummary("no link")).toBe("no link");
  });

  it("writes the steps around the compute step, an empty configuration included", () => {
    const form = addStep(addStep(withCompute, "source", "noop")?.form, "compute", "jq")?.form;
    const written = toEnvelope("helsinki", form as PipelineForm);
    expect(written.apiVersion).toBe("joinedcontext.com/v1alpha2");
    expect(stepsOf(written)).toEqual([
      { processor: { noop: {} } },
      { kind: "bloblang", bloblang: "root = this" },
      { processor: { jq: {} } },
    ]);
    expect(toForm(written).processors).toEqual(form?.processors);
  });

  it("drops the last step from the manifest being edited, not only from the canvas", () => {
    const editing = pipeline([{ processor: { jq: { query: ".id" } } }]);
    const form = toForm(editing);
    expect(form.processors).toHaveLength(1);

    const removed = removeStep(form, 0);
    expect(removed.processors).toEqual([]);
    expect(stepsOf(toEnvelope("helsinki", removed, editing))).toBeUndefined();
    // A form that never carried the lane keeps the steps of the manifest it edits (PL-54).
    expect(stepsOf(toEnvelope("helsinki", { ...form, processors: undefined }, editing))).toEqual([
      { processor: { jq: { query: ".id" } } },
    ]);
    // An index that names no step removes nothing.
    expect(removeStep(form, 7).processors).toEqual(form.processors);
  });

  it("paints a failed mapping on the first step of a lane that has no compute step", () => {
    const form = addStep({ ...withCompute, compute: undefined }, null, "jq")?.form;
    const trace: Trace = {
      input: { events: 2, bytes: 20 },
      mapping: [],
      validation: [],
      errors: [{ stage: "mapping", message: "jq: bad query" }],
    };
    const paint = paintOf(trace, toFlow(form).nodes);
    expect(paint.source.state).toBe("ok");
    expect(paint["step-0"]).toMatchObject({ state: "error", error: "jq: bad query" });
    expect(paint.output.state).toBe("skipped");
    expect(paintOf(null, toFlow(form).nodes)["step-0"].state).toBe("idle");
  });
});

describe("the canvas and the step's block", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ items: [] }), {
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function canvas(form: PipelineForm, selected: Parameters<typeof PipelineFlow>[0]["selected"]) {
    const onChange = vi.fn();
    const onSelect = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <PipelineFlow
          form={form}
          onChange={onChange}
          trace={null}
          selected={selected}
          onSelect={onSelect}
          dataSources={[]}
          endpoints={[]}
        />
      </I18nextProvider>,
    );
    return { onChange, onSelect };
  }

  it("lists every processor under its category with the runner's summary", () => {
    canvas(withCompute, null);
    const palette = screen.getByTestId("palette-processors");
    for (const { category, processors } of PROCESSOR_GROUPS) {
      const list = within(palette).getByRole("list", { name: category, hidden: true });
      expect(within(list).getAllByRole("listitem", { hidden: true })).toHaveLength(
        processors.length,
      );
    }
    const awk = within(palette).getByTestId("palette-processor-awk").closest("li");
    expect(awk).toHaveTextContent("custom functions");
    expect(awk).not.toHaveTextContent("#awk-functions");
  });

  it("puts a clicked processor behind the selected node and selects it", async () => {
    const { onChange, onSelect } = canvas(withCompute, "compute");
    await userEvent.click(screen.getByTestId("palette-processor-jq"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ processors: [{ step: { processor: { jq: {} } }, after: true }] }),
    );
    expect(onSelect).toHaveBeenCalledWith("step-0");
  });

  it("takes a dropped processor and refuses a dropped name the runner does not ship", () => {
    const { onChange, onSelect } = canvas(withCompute, "source");
    const drop = (text: string) =>
      fireEvent.drop(screen.getByTestId("flow-canvas"), {
        dataTransfer: { getData: () => text, dropEffect: "" },
      });
    drop("processor:command");
    drop("processor:");
    expect(onChange).not.toHaveBeenCalled();

    drop("processor:unarchive");
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ processors: [{ step: { processor: { unarchive: {} } } }] }),
    );
    expect(onSelect).toHaveBeenCalledWith("step-0");
  });

  it("removes a step with Delete and leaves the source and the output alone", () => {
    const form = addStep(withCompute, "source", "jq")?.form as PipelineForm;
    const { onChange, onSelect } = canvas(form, "step-0");
    fireEvent.keyDown(screen.getByTestId("flow-node-source"), { key: "Delete" });
    fireEvent.keyDown(screen.getByTestId("flow-node-output"), { key: "Backspace" });
    expect(onChange).not.toHaveBeenCalled();

    const node = screen.getByTestId("flow-node-step-0");
    expect(node).toHaveAccessibleName("Step: jq");
    fireEvent.keyDown(node, { key: "Delete" });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ processors: [] }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  function Studio({ initial, seen }: { initial: PipelineForm; seen: (form: PipelineForm) => void }) {
    const [draft, setDraft] = useState(initial);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <PipelineStudio
            project="helsinki"
            draft={draft}
            onChange={(form) => {
              seen(form);
              setDraft(form);
            }}
            dataSources={[]}
            endpoints={[]}
            toManifest={vi.fn()}
          />
        </I18nextProvider>
      </QueryClientProvider>
    );
  }

  it("shows the selected step's own block, takes an edit, and says why it keeps the last good one", async () => {
    const seen = vi.fn();
    const initial: PipelineForm = {
      ...withCompute,
      processors: [
        { step: { processor: { jq: { query: ".id" } } } },
        {
          step: {
            processor: {
              http: {
                url: "https://feed.example",
                headers: { Authorization: "${FEED_TOKEN}" },
              },
            },
          },
          after: true,
        },
      ],
    };
    render(<Studio initial={initial} seen={seen} />);

    await userEvent.click(screen.getByTestId("flow-node-step-0"));
    const block = screen.getByTestId("flow-step-yaml") as HTMLTextAreaElement;
    expect(block.value).toBe("jq:\n  query: .id\n");
    // Its own block and nothing of a neighbour's (PL-56).
    expect(block.value).not.toContain("feed.example");
    expect(block).toHaveAccessibleName("This step's Bento block");
    expect(block).toHaveAccessibleDescription(/A secret stays a \$\{VAR\} reference\./);

    fireEvent.change(block, { target: { value: "jq:\n  query: .name\n" } });
    expect(seen).toHaveBeenLastCalledWith(
      expect.objectContaining({
        processors: [{ step: { processor: { jq: { query: ".name" } } } }, initial.processors?.[1]],
      }),
    );

    const calls = seen.mock.calls.length;
    for (const [text, said] of [
      ["jq: [", /This is not YAML yet/],
      ["jq: {}\nlog: {}\n", /A step is one processor/],
      ["", /A step is one processor/],
      ["- jq", /A step is one processor/],
      ["command:\n  name: rm\n", /ships no processor named "command"/],
    ] as const) {
      fireEvent.change(block, { target: { value: text } });
      expect(screen.getByRole("alert")).toHaveTextContent(said);
      expect(block).toBeInvalid();
    }
    expect(seen.mock.calls.length).toBe(calls);

    fireEvent.change(block, { target: { value: "jq:\n  query: .id\n" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(block).toBeValid();
  });

  it("keeps a secret reference a reference in the block it shows", async () => {
    const initial: PipelineForm = {
      ...withCompute,
      processors: [
        {
          step: {
            processor: {
              http: {
                url: "https://feed.example",
                headers: { Authorization: "${FEED_TOKEN}" },
              },
            },
          },
        },
      ],
    };
    render(<Studio initial={initial} seen={vi.fn()} />);
    await userEvent.click(screen.getByTestId("flow-node-step-0"));
    expect((screen.getByTestId("flow-step-yaml") as HTMLTextAreaElement).value).toContain(
      "Authorization: ${FEED_TOKEN}",
    );
  });

  it("shows a second compute step as it is written and removes it from its own button", async () => {
    const seen = vi.fn();
    const initial: PipelineForm = {
      ...withCompute,
      processors: [{ step: { kind: "bloblang", bloblang: "root.extra = 1" }, after: true }],
    };
    render(<Studio initial={initial} seen={seen} />);
    await userEvent.click(screen.getByTestId("flow-node-step-0"));
    expect(screen.queryByTestId("flow-step-yaml")).not.toBeInTheDocument();
    expect(screen.getByTestId("flow-step-readonly")).toHaveTextContent("root.extra = 1");

    await userEvent.click(screen.getByTestId("flow-step-remove"));
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ processors: [] }));
    expect(screen.queryByTestId("flow-node-editor-step")).not.toBeInTheDocument();
  });
});
