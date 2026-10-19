import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { AttributeHistory } from "../src/components/entities/history/AttributeHistory";

const HISTORY_FIXTURE = {
  id: "urn:ngsi-ld:ParkingSpot:p-1",
  type: "ParkingSpot",
  status: [
    {
      type: "Property",
      value: "occupied",
      observedAt: "2026-10-18T07:00:00Z",
      instanceId: "urn:inst:old",
      supersededAt: "2026-10-18T09:12:40Z",
      provenance: {
        channel: "pipeline",
        actor: "pipeline-parking",
        operation: "create",
        writtenAt: "2026-10-18T07:00:02Z",
      },
    },
    {
      type: "Property",
      value: "free",
      observedAt: "2026-10-18T07:00:00Z",
      instanceId: "urn:inst:new",
      provenance: {
        channel: "ui",
        actor: "steward-1",
        operation: "correct",
        reason: "Sensor checked on site",
        writtenAt: "2026-10-18T09:12:40Z",
      },
    },
    {
      type: "Property",
      value: "occupied",
      observedAt: "2026-10-18T06:00:00Z",
      instanceId: "urn:inst:base",
      provenance: {
        channel: "api",
        actor: "gateway",
      },
    },
  ],
};

describe("AttributeHistory component", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mount(
    canEdit: boolean,
    canEditHistory: boolean,
    onFetch?: (url: string, req: Request) => Promise<Response | undefined>,
  ) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        if (onFetch) {
          const custom = await onFetch(req.url, req);
          if (custom) return custom;
        }
        if (req.url.includes("/temporal/entities/")) {
          return new Response(JSON.stringify(HISTORY_FIXTURE), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(null, { status: 204 });
      }),
    );

    render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <AttributeHistory
            slug="parking"
            entityId="urn:ngsi-ld:ParkingSpot:p-1"
            attribute="status"
            canEdit={canEdit}
            canEditHistory={canEditHistory}
          />
        </I18nextProvider>
      </QueryClientProvider>,
    );
  }

  it("shows versions with channel, actor, reason on timeline", async () => {
    mount(true, true);
    expect(await screen.findByText("pipeline")).toBeInTheDocument();
    expect(screen.getByText("pipeline-parking")).toBeInTheDocument();
    expect(screen.getByText("Sensor checked on site")).toBeInTheDocument();
    expect(screen.getByText("steward-1")).toBeInTheDocument();
  });

  it("hides Save, Revert, and Import controls for viewers", async () => {
    mount(false, false);
    await screen.findByText("pipeline");
    expect(screen.queryByRole("button", { name: en.attributeHistory.save })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.attributeHistory.revert })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.attributeHistory.confirmImport })).not.toBeInTheDocument();
  });

  it("keeps Save disabled until a reason is typed", async () => {
    mount(true, false);
    const saveButton = await screen.findByRole("button", { name: en.attributeHistory.save });
    expect(saveButton).toBeDisabled();

    const reasonInput = screen.getByLabelText(new RegExp(en.attributeHistory.reason));
    await userEvent.type(reasonInput, "routine check");
    expect(saveButton).toBeEnabled();
  });

  it("datetime picker writes an ISO instant into the POST body", async () => {
    let capturedBody = "";
    mount(true, true, async (url, req) => {
      if (req.method === "POST" && url.includes("/temporal/entities/")) {
        capturedBody = await req.clone().text();
        return new Response(null, { status: 204 });
      }
      return undefined;
    });

    await screen.findByText("pipeline");

    const dateInputs = screen.getAllByLabelText(new RegExp(en.attributeHistory.observedAt));
    const dtInput = dateInputs[0];
    await userEvent.type(dtInput, "2020-05-10T12:00");

    const valueInputs = screen.getAllByLabelText(new RegExp(en.attributeHistory.value));
    await userEvent.type(valueInputs[1], "free");

    const reasonInputs = screen.getAllByLabelText(new RegExp(en.attributeHistory.reason));
    await userEvent.type(reasonInputs[1], "backfill historical log");

    const saveButtons = screen.getAllByRole("button", { name: en.attributeHistory.save });
    await userEvent.click(saveButtons[1]);

    await waitFor(() => expect(capturedBody).not.toBe(""));
    const parsed = JSON.parse(capturedBody) as { status: { observedAt: string; value: string }[] };
    expect(parsed.status[0].value).toBe("free");
    expect(parsed.status[0].observedAt.endsWith("Z")).toBe(true);
  });

  it("shows preview count for 2 new, 1 duplicates, 1 corrections against fixture", async () => {
    mount(true, true);
    await screen.findByText("pipeline");

    const csvContent = `observedAt,value
2026-10-18T07:00:00Z,free
2026-10-18T06:00:00Z,free
2026-10-18T05:00:00Z,free
2026-10-18T04:00:00Z,free
`;
    const file = new File([csvContent], "import.csv", { type: "text/csv" });
    const fileInput = screen.getByLabelText(en.attributeHistory.file);
    await userEvent.upload(fileInput, file);

    expect(await screen.findByText("2 new, 1 duplicates, 1 corrections")).toBeInTheDocument();
  });
});
