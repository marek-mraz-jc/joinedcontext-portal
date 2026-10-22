/**
 * T-5066: keeping a new model as a shared draft writes `?draft=<name>` into the address (AG-61).
 * The page wrote that address for itself, so the page stays mounted: the view the person chose in
 * the editor stays open. Written with a bare `history.replaceState`, HandOff took it for an
 * assistant hand-off and mounted the page afresh, and the live journey's Source tab fell back to
 * Structure a moment after Monaco opened.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../src/locales/en.json";
import { jsonResponse, renderRoute } from "./pageHarness";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a new model kept as a draft", () => {
  it("keeps the editor view the person chose when the draft lands in the address", async () => {
    const user = userEvent.setup();
    const kept: string[] = [];
    await renderRoute({
      path: "/projects/helsinki/models?new=blank&lang=en",
      answer: (path, request) => {
        if (request.method === "PUT" && path.startsWith("/api/v1/projects/helsinki/drafts/DataModel/")) {
          kept.push(path);
          return jsonResponse({
            project: "helsinki",
            kind: "DataModel",
            name: "stations",
            manifest: {},
            touchedBy: "demo.steward",
            touchedKind: "person",
            version: 1,
            updatedAt: "2026-10-21T21:00:00Z",
          });
        }
        return undefined;
      },
    });
    const region = await screen.findByRole("region", { name: en.models.create.title });
    await user.type(within(region).getByLabelText(en.models.create.name, { exact: true }), "stations");
    // A first edit is what makes the page keep the model.
    await user.type(screen.getByLabelText("New type"), "Station");
    await user.click(screen.getByRole("button", { name: "Add type" }));
    await user.click(screen.getByRole("tab", { name: en.models.view.preview }));
    expect(screen.getByRole("tab", { name: en.models.view.preview })).toHaveAttribute("aria-selected", "true");

    await waitFor(() => expect(new URL(window.location.href).searchParams.get("draft")).toBe("stations"));
    expect(kept).toEqual(["/api/v1/projects/helsinki/drafts/DataModel/stations"]);
    expect(await screen.findByText(en.models.create.held.replace("{name}", "stations"))).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: en.models.view.preview })).toHaveAttribute("aria-selected", "true");
    // Kept once: with nothing changed, the page writes the same draft no second time. It wrote it
    // again every 600 ms while the page stayed open (T-5066, seen on dev).
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(kept).toHaveLength(1);
  });

  it("keeps the Source view of a model drafted from a sample file once the draft is kept", async () => {
    const user = userEvent.setup();
    const kept: string[] = [];
    const linkml = [
      "id: https://example.org/sample",
      "name: sample",
      "prefixes:",
      "  linkml: https://w3id.org/linkml/",
      "default_range: string",
      "classes:",
      "  Sample:",
      "    attributes:",
      "      pm10:",
      "        range: float",
      "",
    ].join("\n");
    await renderRoute({
      path: "/projects/helsinki/models?new=file&lang=en",
      answer: (path, request) => {
        if (request.method === "POST" && path === "/api/v1/tools/infer-schema") {
          return jsonResponse({ linkml, operations: [], matches: {}, untyped: [], rows: 2 });
        }
        if (request.method === "PUT" && path.startsWith("/api/v1/projects/helsinki/drafts/DataModel/")) {
          kept.push(path);
          return jsonResponse({
            project: "helsinki",
            kind: "DataModel",
            name: "sample",
            manifest: {},
            touchedBy: "demo.steward",
            touchedKind: "person",
            version: 1,
            updatedAt: "2026-10-22T00:00:00Z",
          });
        }
        return undefined;
      },
    });
    const csv = new File(["station,pm10\nkallio,12.5\n"], "sample.csv", { type: "text/csv" });
    await user.upload(await screen.findByLabelText("Choose a sample file"), csv);
    const draft = await screen.findByRole("dialog", { name: /sample\.csv/ });
    await user.click(within(draft).getByRole("button", { name: en.models.infer.populate }));
    await user.click(await screen.findByRole("tab", { name: en.models.view.source }));

    await waitFor(() => expect(new URL(window.location.href).searchParams.get("draft")).toBe("sample"));
    expect(kept).toEqual(["/api/v1/projects/helsinki/drafts/DataModel/sample"]);
    expect(await screen.findByText(en.models.create.held.replace("{name}", "sample"))).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: en.models.view.source })).toHaveAttribute("aria-selected", "true");
  });
});
