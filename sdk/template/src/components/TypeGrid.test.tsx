import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JcProvider } from "@joinedcontext/sdk";
import type { GridColumn, Row } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import { TypeGrid } from "./TypeGrid";

const STATIONS: Row[] = [
  { id: "urn:ngsi-ld:Station:example.org:demo:1", type: "Station", name: "Kamppi", bikes: 4, slots: 8 },
  { id: "urn:ngsi-ld:Station:example.org:demo:2", type: "Station", name: "Kallio", bikes: 0, slots: 5 },
];

function shown(columns?: GridColumn[], onSelect?: (id: string) => void) {
  const client = stubClient({ entities: STATIONS });
  render(
    <JcProvider client={client}>
      <TypeGrid type="Station" columns={columns} onSelect={onSelect} />
    </JcProvider>,
  );
  return client;
}

describe("TypeGrid", () => {
  it("lists the type's rows in the SDK grid, read at the endpoint", async () => {
    const client = shown();
    const grid = await screen.findByRole("grid");
    expect(await within(grid).findByText("Kamppi")).toBeInTheDocument();
    expect(client.transport.calls.some((call) => call.path.includes("options=sysAttrs"))).toBe(true);
  });

  it("works a formula column out of each row", async () => {
    shown([{ attr: "name" }, { attr: "occupancy", formula: "bikes / slots * 100" }]);
    expect(await screen.findByText("50")).toBeInTheDocument();
  });

  it("opens a row by its name", async () => {
    const onSelect = vi.fn();
    shown(undefined, onSelect);
    fireEvent.click(await screen.findByRole("button", { name: "Kallio" }));
    expect(onSelect).toHaveBeenCalledWith(STATIONS[1].id);
  });

  it("says what is wrong with a column it cannot draw", async () => {
    shown([{ attr: "occupancy", formula: "fetch('x')" }]);
    expect(await screen.findByRole("alert")).toHaveTextContent("formula");
  });
});
