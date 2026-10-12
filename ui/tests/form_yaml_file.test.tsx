import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { ResourceFormDialogBody as ResourceFormDialog } from "../src/components/ResourceFormDialogBody";
import type { JsonSchema } from "../src/components/forms/types";

vi.mock("../src/pages/models/MonacoSourceView", () => ({
  default: ({ value }: { value: string }) => <textarea aria-label="manifest-text" value={value} readOnly />,
}));

// T-3977: the YAML view downloads the manifest it holds and reads one back from a file; a file
// with a secret written out is refused, one from another project is moved into this one.
const SCHEMA: JsonSchema = {
  type: "object",
  properties: { name: { type: "string", title: "Name" }, mapping: { type: "string", title: "Mapping" } },
};

interface Form {
  name?: string;
  mapping?: string;
  secretRefs?: { name?: string; key?: string }[];
}

const source = {
  toManifest: (form: Form) => ({
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "Pipeline",
    metadata: { name: form.name, namespace: "helsinki" },
    spec: { mapping: form.mapping, secretRefs: form.secretRefs },
  }),
  fromManifest: (manifest: unknown) => {
    const m = manifest as { metadata?: { name?: string }; spec?: { mapping?: string; secretRefs?: Form["secretRefs"] } };
    return { name: m.metadata?.name, mapping: m.spec?.mapping, secretRefs: m.spec?.secretRefs };
  },
};

function open(seen: (form: Form) => void): void {
  function Harness(): React.JSX.Element {
    const [form, setForm] = useState<Form>({ name: "air", mapping: "root = this", secretRefs: [{ name: "mqtt", key: "password" }] });
    return (
      <ResourceFormDialog<Form>
        open
        onOpenChange={() => {}}
        title="Pipeline"
        description="A pipeline"
        schema={SCHEMA}
        formData={form}
        onChange={(next) => {
          seen(next ?? {});
          setForm(next ?? {});
        }}
        submitLabel="Propose"
        source={source}
        project="helsinki"
        onSubmit={() => {}}
      />
    );
  }
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nextProvider i18n={i18n}>
        <Harness />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

function file(text: string): File {
  return new File([text], "pipeline.yaml", { type: "application/yaml" });
}

describe("a manifest moves as a file", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads what the YAML view holds, references and no values, named after the resource", async () => {
    const blobs: Blob[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (blob: Blob) => (blobs.push(blob), "blob:x"), revokeObjectURL: () => {} }));
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("air.yaml");
    });
    open(vi.fn());
    await userEvent.click(screen.getByRole("tab", { name: "YAML" }));
    await userEvent.click(screen.getByTestId("yaml-download"));
    expect(clicked).toHaveBeenCalledOnce();
    const text = await blobs[0].text();
    expect(text).toContain("name: air");
    expect(text).toContain("secretRefs:");
    expect(text).toContain("key: password");
    clicked.mockRestore();
  });

  it("refuses a file with a secret written out and reads nothing of it", async () => {
    const seen = vi.fn();
    open(seen);
    await userEvent.click(screen.getByRole("tab", { name: "YAML" }));
    await userEvent.upload(
      screen.getByLabelText("Upload YAML"),
      file("kind: Pipeline\nmetadata:\n  name: leak\nspec:\n  password: hunter2\n"),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(en.form.yamlUploadSecret.replace("{keys}", "password"));
    expect(seen).not.toHaveBeenCalled();
    expect((screen.getByLabelText("manifest-text") as HTMLTextAreaElement).value).not.toContain("hunter2");
  });

  it("moves a manifest of another project into this one, says so, and hands the form what it read", async () => {
    const seen = vi.fn();
    open(seen);
    await userEvent.click(screen.getByRole("tab", { name: "YAML" }));
    await userEvent.upload(
      screen.getByLabelText("Upload YAML"),
      file("kind: Pipeline\nmetadata:\n  name: copied\n  namespace: espoo\nspec:\n  mapping: root.id = this.id\n"),
    );
    expect(await screen.findByTestId("yaml-upload-note")).toHaveTextContent("project espoo");
    await waitFor(() => expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ name: "copied", mapping: "root.id = this.id" })));
    const yaml = (screen.getByLabelText("manifest-text") as HTMLTextAreaElement).value;
    expect(yaml).toContain("namespace: helsinki");
    expect(yaml).not.toContain("espoo");
  });

  it("names a file that is no YAML and keeps what was there", async () => {
    const seen = vi.fn();
    open(seen);
    await userEvent.click(screen.getByRole("tab", { name: "YAML" }));
    await userEvent.upload(screen.getByLabelText("Upload YAML"), file("metadata: [unclosed\n"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Correct the YAML");
    expect(seen).not.toHaveBeenCalled();
    expect((screen.getByLabelText("manifest-text") as HTMLTextAreaElement).value).toContain("name: air");
  });
});
