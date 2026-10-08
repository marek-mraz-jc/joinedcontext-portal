import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { EditResourceDialog } from "../src/components/EditResourceDialog";
import { ResourceFormDialog } from "../src/components/ResourceFormDialog";
import type { JsonSchema } from "../src/components/forms/types";

// T-3316: a page that offers New or Edit holds only the dialogs' shells; the form engine loads
// when one opens.
const SCHEMA: JsonSchema = { type: "object", properties: { name: { type: "string", title: "Name" } } };

function wrap(node: ReactNode): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );
}

function create(open: boolean): ReactNode {
  return (
    <ResourceFormDialog<{ name?: string }>
      open={open}
      onOpenChange={() => {}}
      title="Endpoint"
      description="An endpoint"
      schema={SCHEMA}
      formData={{}}
      onChange={() => {}}
      submitLabel="Propose"
      onSubmit={() => {}}
    />
  );
}

describe("the dialogs load with their first opening", () => {
  it("renders nothing of a closed create dialog, and its form once it opens", async () => {
    const view = wrap(create(false));
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <I18nextProvider i18n={i18n}>{create(true)}</I18nextProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByLabelText(/Name/)).toBeInTheDocument();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders nothing of a closed edit dialog and asks the server nothing", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const view = wrap(
      <EditResourceDialog
        target={{ project: "helsinki", plural: "endpoints", kind: "Endpoint", name: "air" }}
        open={false}
        onOpenChange={() => {}}
      />,
    );
    expect(view.container).toBeEmptyDOMElement();
    expect(fetch).not.toHaveBeenCalled();
  });
});
