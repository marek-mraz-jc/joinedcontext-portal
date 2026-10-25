import type { ReactNode } from "react";
import { render, renderHook, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import type { Verdict } from "../src/api/drafts";
import { ResourceFormFooter, verdictStateOf } from "../src/components/forms/ResourceFormFooter";
import { ResourceFormNotes } from "../src/components/forms/ResourceFormNotes";
import { ResourceYamlPanel } from "../src/components/forms/ResourceYamlPanel";
import { useYamlEditor } from "../src/components/forms/useYamlEditor";
import { useFormArrangement } from "../src/components/forms/useFormArrangement";
import type { ManifestSource } from "../src/components/forms/types";

vi.mock("../src/pages/models/MonacoSourceView", () => ({
  default: ({ value }: { value: string }) => <textarea aria-label="YAML" value={value} readOnly />,
}));

// T-5515: the parts ResourceFormDialogBody was split into, each rendered on its own.

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </QueryClientProvider>
  );
}

const VERDICT = { ok: true, inputDigest: "d1", checkedAt: new Date().toISOString(), findings: [] } as unknown as Verdict;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ResourceFormFooter", () => {
  it("says_the_verdict_and_why_propose_waits_and_checks_on_click", async () => {
    const onCheck = vi.fn();
    const onCancel = vi.fn();
    render(
      <ResourceFormFooter
        onCancel={onCancel}
        check={{ onClick: onCheck, disabled: false, disabledReason: "" }}
        stoppedMessage={null}
        verdict={{ verdict: VERDICT, state: verdictStateOf(VERDICT, "d2"), refused: false }}
        proposeReason={en.drafts.proposeReason.stale}
        lax={false}
        error="the check was refused"
      />,
      { wrapper },
    );
    expect(screen.getByTestId("draft-verdict")).toHaveTextContent(en.drafts.verdict.stale);
    expect(screen.getByTestId("propose-reason")).toHaveTextContent(en.drafts.proposeReason.stale);
    expect(screen.getByRole("alert")).toHaveTextContent("the check was refused");
    await userEvent.click(screen.getByRole("button", { name: en.form.check }));
    await userEvent.click(screen.getByRole("button", { name: en.form.cancel }));
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("reads_a_verdict_against_the_digest_it_judged", () => {
    expect(verdictStateOf(null, "d1")).toBe("none");
    expect(verdictStateOf(VERDICT, "d1")).toBe("green");
    expect(verdictStateOf(VERDICT, "d2")).toBe("stale");
    expect(verdictStateOf({ ...VERDICT, ok: false }, "d1")).toBe("red");
    expect(verdictStateOf({ ...VERDICT, waitsOn: ["c-1"] }, "d1")).toBe("waiting");
  });
});

describe("ResourceFormNotes", () => {
  it("lists_every_finding_and_the_refused_save", () => {
    const verdict = {
      ...VERDICT,
      ok: false,
      findings: [
        { level: "error", path: "spec.url", message: "the address does not answer" },
        { level: "warning", path: "", message: "the space keeps no history" },
      ],
    } as unknown as Verdict;
    render(
      <ResourceFormNotes
        kind="DataSource"
        conflict={null}
        saveRefused="the draft store is read-only"
        draftKind="DataSource"
        draft={null}
        strict
        verdict={verdict}
        restartsStream={false}
      />,
      { wrapper },
    );
    const findings = screen.getByTestId("draft-findings");
    expect(findings).toHaveTextContent("spec.url: the address does not answer");
    expect(findings).toHaveTextContent("the space keeps no history");
    expect(screen.getByRole("alert")).toHaveTextContent("the draft store is read-only");
    expect(screen.getByRole("button", { name: en.form.fillFromSentence })).toBeVisible();
  });
});

describe("ResourceYamlPanel", () => {
  type Form = { name: string };
  const SOURCE: ManifestSource<Form> = {
    toManifest: (form) => ({ kind: "DataSource", metadata: { name: form.name, namespace: "p1" } }),
    fromManifest: (manifest) => ({ name: (manifest as { metadata: { name: string } }).metadata.name }),
  };

  it("refuses_a_file_with_a_literal_secret_and_reads_a_clean_one_into_the_form", async () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useYamlEditor<Form>(SOURCE, "p1", onChange), { wrapper });
    const { rerender } = render(
      <ResourceYamlPanel editor={result.current} viewsId="v" disabled={false} downloadName="air" footer={null} />,
      { wrapper },
    );
    const leaked = new File(["kind: DataSource\nspec:\n  password: hunter2hunter2\n"], "leak.yaml");
    await act(async () => {
      await result.current.upload(leaked);
    });
    rerender(<ResourceYamlPanel editor={result.current} viewsId="v" disabled={false} downloadName="air" footer={null} />);
    expect(screen.getByRole("alert")).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();

    const moved = new File(["kind: DataSource\nmetadata:\n  name: air\n  namespace: other\n"], "air.yaml");
    await act(async () => {
      await result.current.upload(moved);
    });
    rerender(<ResourceYamlPanel editor={result.current} viewsId="v" disabled={false} downloadName="air" footer={null} />);
    expect(onChange).toHaveBeenCalledWith({ name: "air" });
    expect(screen.getByTestId("yaml-upload-note")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "YAML" })).toHaveValue(
      "kind: DataSource\nmetadata:\n  name: air\n  namespace: p1\n",
    );
    expect(screen.getByRole("button", { name: en.form.yamlDownload })).toBeVisible();
  });
});

describe("useFormArrangement", () => {
  it("locks_the_name_of_a_resource_that_exists", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    const { result } = renderHook(
      () =>
        useFormArrangement({
          open: true,
          kind: "NoSuchKind",
          schema: { type: "object", properties: { name: { type: "string" } } },
          uiSchema: { name: { "ui:help": "the name" } },
          lockedName: "air",
        }),
      { wrapper },
    );
    expect(result.current.uiSchema).toEqual({ name: { "ui:help": "the name", "ui:readonly": true } });
    expect(result.current.advancedFields).toBe(false);
    act(() => result.current.setAdvanced(true, false));
    expect(result.current.advanced).toBe(true);
  });
});
