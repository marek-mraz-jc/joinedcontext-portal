/** T-0222: browsing the Smart Data Models catalogue and importing one model (DM-07…DM-12). */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import {
  SmartDataModelsImport,
  deprecateUnused,
  matches,
} from "../src/pages/models/SmartDataModelsImport";
import { parseModel } from "../src/pages/models/linkml";
import en from "../src/locales/en.json";

const CATALOGUE = {
  refreshedAt: "2026-09-06T04:00:00Z",
  stale: false,
  subjects: [
    {
      name: "dataModel.Environment",
      title: "Environment",
      models: [
        {
          id: "dataModel.Environment/AirQualityObserved",
          name: "AirQualityObserved",
          description: "An observation of air quality conditions.",
          attributes: ["pm10", "pm25", "dateObserved"],
        },
        {
          id: "dataModel.Environment/NoiseLevelObserved",
          name: "NoiseLevelObserved",
          description: "A sound pressure observation.",
          attributes: ["LAeq"],
        },
      ],
    },
    {
      name: "dataModel.Transportation",
      title: "Transportation",
      models: [
        {
          id: "dataModel.Transportation/Vehicle",
          name: "Vehicle",
          description: "A vehicle of any kind.",
          attributes: ["speed", "location"],
        },
      ],
    },
  ],
};

const IMPORTED = `id: https://github.com/smart-data-models/dataModel.Environment/AirQualityObserved
name: AirQualityObserved
prefixes:
  sdm: https://smartdatamodels.org/
annotations:
  spec.source.repository: https://github.com/smart-data-models/dataModel.Environment
  spec.source.path: AirQualityObserved
  spec.source.commit: 9f1c2b7d4e6a8c0b2d4f6a8c0e2b4d6f8a0c2e4b
classes:
  AirQualityObserved:
    slots: [pm10, pm25, dateObserved]
slots:
  pm10:
    range: float
    slot_uri: sdm:pm10
  pm25:
    range: float
    slot_uri: sdm:pm25
  dateObserved:
    range: datetime
    slot_uri: sdm:dateObserved
`;

function renderWizard(options: { catalogue?: unknown; status?: number; spaces?: string[]; previewStatus?: number; linkml?: string } = {}) {
  const onImport = vi.fn();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/tools/sdm-catalog") {
      return Promise.resolve(
        new Response(JSON.stringify(options.catalogue ?? CATALOGUE), {
          status: options.status ?? 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify(
          options.previewStatus && options.previewStatus >= 400
            ? { status: options.previewStatus, title: "Service Unavailable" }
            : { linkml: options.linkml ?? IMPORTED },
        ),
        {
          status: options.previewStatus ?? 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <SmartDataModelsImport onImport={onImport} spaces={options.spaces ?? []} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { onImport, fetchMock, user: userEvent.setup() };
}

describe("Smart Data Models import wizard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists the catalogue by subject, through the Portal and not the catalogue itself", async () => {
    const { fetchMock } = renderWizard();

    expect(await screen.findByRole("button", { name: /AirQualityObserved/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Vehicle/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Environment" })).toBeInTheDocument();
    for (const call of fetchMock.mock.calls) {
      expect(new URL((call[0] as Request).url).origin).toBe(window.location.origin);
    }
  });

  it("searches by model name, description and attribute name", async () => {
    const { user } = renderWizard();
    await screen.findByRole("button", { name: /AirQualityObserved/ });

    await user.type(screen.getByLabelText("Search models and attributes"), "pm25");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Vehicle/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /AirQualityObserved/ })).toBeInTheDocument();

    expect(matches(CATALOGUE.subjects[1].models[0], "sound")).toBe(false);
    expect(matches(CATALOGUE.subjects[0].models[1], "sound")).toBe(true);
  });

  it("filters by subject", async () => {
    const { user } = renderWizard();
    await screen.findByRole("button", { name: /AirQualityObserved/ });

    await user.selectOptions(screen.getByLabelText("Subject"), "dataModel.Transportation");

    expect(await screen.findByRole("button", { name: /Vehicle/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /AirQualityObserved/ })).not.toBeInTheDocument();
  });

  it("previews the upstream model with the provenance of the commit it was pinned to", async () => {
    const { user, fetchMock } = renderWizard();

    await user.click(await screen.findByRole("button", { name: /AirQualityObserved/ }));

    expect(await screen.findByText(/spec.source.commit/)).toBeInTheDocument();
    const post = fetchMock.mock.calls
      .map((call) => call[0] as Request)
      .find((request) => request.method === "POST");
    expect(new URL(post!.url).pathname).toBe("/api/v1/tools/import-sdm");
  });

  it("imports the model and keeps the slots the user did not pick, marked deprecated", async () => {
    const { user, onImport } = renderWizard();

    await user.click(await screen.findByRole("button", { name: /AirQualityObserved/ }));
    await user.click(await screen.findByLabelText("pm25"));
    await user.click(screen.getByRole("button", { name: "Import AirQualityObserved" }));

    expect(onImport).toHaveBeenCalledTimes(1);
    const [source, model] = onImport.mock.calls[0];
    const imported = parseModel(source as string);
    expect(model).toMatchObject({ id: "dataModel.Environment/AirQualityObserved" });
    // DM-11: an unused upstream slot stays in the model so a partner's payload still validates.
    expect(imported.slots.map((slot) => slot.name)).toEqual(["pm10", "pm25", "dateObserved"]);
    expect(imported.slots.find((slot) => slot.name === "pm25")?.deprecated).toBe(true);
    expect(imported.slots.find((slot) => slot.name === "pm10")?.deprecated).toBe(false);
  });

  /// T-1109: Model Tools timing out is the ordinary failure here; picking the model again to
  /// try once more is a step nobody should have to know about.
  it("offers a retry when the import itself failed, and runs it", async () => {
    const { user, fetchMock } = renderWizard({ previewStatus: 503 });

    await user.click(await screen.findByRole("button", { name: /AirQualityObserved/ }));
    const before = fetchMock.mock.calls.filter((call) =>
      new URL((call[0] as Request).url).pathname.includes("/tools/import-sdm"),
    ).length;
    expect(before).toBeGreaterThan(0);

    await user.click(await screen.findByRole("button", { name: en.app.error.retry }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter((call) =>
          new URL((call[0] as Request).url).pathname.includes("/tools/import-sdm"),
        ).length,
      ).toBeGreaterThan(before);
    });
  });

  /// T-1107: a model of the catalogue can carry two hundred attributes.
  it("finds an attribute by name and puts the required ones first", async () => {
    const { user } = renderWizard();

    await user.click(await screen.findByRole("button", { name: /AirQualityObserved/ }));
    await screen.findByLabelText("pm10");

    // The model's own order is pm10, pm25, dateObserved; required first regardless.
    const before = screen.getAllByRole("checkbox").map((box) => box.getAttribute("name"));
    expect(before.length).toBe(3);

    await user.type(screen.getByLabelText(en.models.sdm.findAttribute), "pm2");
    await waitFor(() => {
      expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    });
    expect(screen.getByLabelText(/pm25/)).toBeInTheDocument();

    await user.clear(screen.getByLabelText(en.models.sdm.findAttribute));
    await user.type(screen.getByLabelText(en.models.sdm.findAttribute), "nothing-of-the-sort");
    expect(await screen.findByText(en.models.sdm.noAttribute)).toBeInTheDocument();
  });

  /// T-1108, DM-57: the space a model belongs to, chosen where the model is chosen.
  it("carries the space the person picked into the import", async () => {
    const { user, onImport } = renderWizard({ spaces: ["mobility", "air-quality"] });

    await user.click(await screen.findByRole("button", { name: /AirQualityObserved/ }));
    await user.selectOptions(await screen.findByLabelText(en.models.sdm.space), "air-quality");
    await user.click(screen.getByRole("button", { name: "Import AirQualityObserved" }));

    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onImport.mock.calls[0][2]).toBe("air-quality");
  });

  it("leaves the space to the editor when the project has none to offer", async () => {
    const { user, onImport } = renderWizard();

    await user.click(await screen.findByRole("button", { name: /AirQualityObserved/ }));
    expect(screen.queryByLabelText(en.models.sdm.space)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Import AirQualityObserved" }));

    expect(onImport.mock.calls[0][2]).toBeUndefined();
  });

  it("works from the cached index when a refresh did not reach the catalogue", async () => {
    const { user, fetchMock } = renderWizard({
      catalogue: { ...CATALOGUE, stale: true },
    });

    expect(await screen.findByText(/Cached index from/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /AirQualityObserved/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh now" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) =>
          (call[0] as Request).url.includes("refresh=true"),
        ),
      ).toBe(true),
    );
  });

  it("says the catalogue is unreachable without blocking the editor", async () => {
    renderWizard({ catalogue: { title: "Service Unavailable" }, status: 503 });

    expect(await screen.findByText(/The catalogue is not reachable/)).toBeInTheDocument();
  });

  // UI-15, UI-16 (T-1851): the catalogue holds about a thousand models; listed all at once it
  // made a page 92 000 px tall on dev with the preview left at the top of it.
  it("lists a page of a large catalogue inside a bounded region and the rest on request", async () => {
    const many = {
      ...CATALOGUE,
      subjects: [
        {
          name: "dataModel.Many",
          title: "Many",
          models: Array.from({ length: 150 }, (_, index) => ({
            id: `dataModel.Many/Model${index}`,
            name: `Model${index}`,
          })),
        },
      ],
    };
    const { user } = renderWizard({ catalogue: many });

    expect(await screen.findByText("150 models")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Model\d+$/ })).toHaveLength(60);
    const list = screen.getByRole("button", { name: "Model0" }).closest("ul")?.parentElement?.closest("ul");
    expect(list?.className).toMatch(/max-h-96/);
    expect(list?.className).toMatch(/overflow-auto/);

    await user.click(screen.getByRole("button", { name: "Show 90 more" }));
    expect(screen.getAllByRole("button", { name: /^Model\d+$/ })).toHaveLength(150);
    expect(screen.queryByRole("button", { name: /^Show \d+ more$/ })).not.toBeInTheDocument();

    // A new search starts from a page again: the person narrowed it, the page is enough.
    await user.type(screen.getByLabelText(en.models.sdm.search), "Model1");
    await waitFor(() => expect(screen.getByText("61 models")).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: /^Model\d+$/ })).toHaveLength(60);
  });

  // UI-15 (T-1851): the wait is announced and an unreachable catalogue is not called empty.
  it("announces the wait for the catalogue, and an unreachable one is not an empty one", async () => {
    renderWizard({ status: 503 });
    expect(screen.getByRole("status")).toHaveTextContent(en.models.sdm.catalogueLoading);
    expect(await screen.findByText(en.models.sdm.unavailable)).toBeInTheDocument();
    expect(screen.queryByText(en.models.sdm.noMatches)).not.toBeInTheDocument();
    expect(screen.queryByText(en.models.sdm.catalogueLoading)).not.toBeInTheDocument();
  });

  // UI-16, DM-11 (T-1851): keeping 8 attributes of 46 must not take 38 clicks.
  it("keeps only the required attributes with one button, and all of them with the other", async () => {
    const withRequired = IMPORTED.replace("  dateObserved:\n    range: datetime", "  dateObserved:\n    required: true\n    range: datetime");
    const { user, onImport } = renderWizard({ linkml: withRequired });

    await user.click(await screen.findByRole("button", { name: /AirQualityObserved/ }));
    await screen.findByLabelText("pm10");
    expect(screen.getByText("3 of 3 attributes kept")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: en.models.sdm.onlyRequired }));
    expect(screen.getByText("1 of 3 attributes kept")).toBeInTheDocument();
    expect(screen.getByLabelText("pm10")).not.toBeChecked();
    expect(screen.getByLabelText(/dateObserved/)).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Import AirQualityObserved" }));
    const imported = parseModel(onImport.mock.calls[0][0] as string);
    expect(imported.slots.filter((slot) => slot.deprecated).map((slot) => slot.name)).toEqual(["pm10", "pm25"]);

    await user.click(screen.getByRole("button", { name: en.models.sdm.allAttributes }));
    expect(screen.getByText("3 of 3 attributes kept")).toBeInTheDocument();
  });

  it("marks every unpicked slot and nothing else", () => {
    const marked = parseModel(deprecateUnused(IMPORTED, ["pm10"]));
    expect(marked.slots.filter((slot) => slot.deprecated).map((slot) => slot.name)).toEqual([
      "pm25",
      "dateObserved",
    ]);
  });
});
