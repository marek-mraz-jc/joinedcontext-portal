/**
 * T-3373: the record the Apps' coverage gate reads, which controls a test file rendered and which
 * its tests clicked or typed into. A control no test touched shows as rendered and not exercised.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { controlId, recordControls } from "../src/sdk/testing";

describe("the controls record (T-3373)", () => {
  it("names a control by its role and the name a person reads", () => {
    render(
      <div>
        <button type="button">Save the change</button>
        <label>
          Station <input name="station" />
        </label>
        <select aria-label="Measure">
          <option>events</option>
        </select>
        <a href="https://example.org">Open in the Portal</a>
      </div>,
    );
    expect(controlId(screen.getByRole("button"))).toBe("button: Save the change");
    expect(controlId(screen.getByRole("textbox"))).toBe("textbox: Station");
    expect(controlId(screen.getByRole("combobox"))).toBe("combobox: Measure");
    expect(controlId(screen.getByRole("link"))).toBe("link: Open in the Portal");
  });

  it("writes what was rendered and what a test exercised, leaving out a disabled control", async () => {
    const dir = mkdtempSync(join(tmpdir(), "controls-"));
    let done: (() => Promise<void>) | undefined;
    recordControls((callback) => {
      done = callback;
    }, dir);
    render(
      <div>
        <button type="button">Clicked</button>
        <button type="button">Never touched</button>
        <button type="button" disabled>
          Disabled
        </button>
        <input aria-label="Typed into" />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clicked" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Typed into" }), { target: { value: "x" } });
    await done?.();
    const [file] = readdirSync(dir);
    const record = JSON.parse(readFileSync(join(dir, file), "utf8")) as { rendered: string[]; exercised: string[] };
    expect(record.rendered).toEqual(expect.arrayContaining(["button: Clicked", "button: Never touched", "textbox: Typed into"]));
    expect(record.rendered).not.toContain("button: Disabled");
    expect(record.exercised).toEqual(["button: Clicked", "textbox: Typed into"]);
  });

  it("does nothing without a directory to write to", () => {
    let registered = false;
    recordControls(() => {
      registered = true;
    }, undefined);
    expect(registered).toBe(false);
  });
});
