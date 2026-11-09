/** A value picked from a list draws its label as text with the whole value on hover (T-6645). */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EnumCell } from "../src/grid/GridCellEditors";

describe("EnumCell", () => {
  it("shows the chosen value as text and as its title, and the select still changes it", () => {
    const onChange = vi.fn();
    const { container } = render(
      <EnumCell
        label="Edit Space"
        value="air-quality-and-weather-observations"
        options={[{ value: "air-quality-and-weather-observations" }, { value: "liikenne" }]}
        changed={false}
        notInList="not in the list"
        onChange={onChange}
      />,
    );
    const text = container.querySelector(".jc-grid-enum-text");
    expect(text).toHaveTextContent("air-quality-and-weather-observations");
    expect(text).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".jc-grid-enum")).toHaveAttribute("title", "air-quality-and-weather-observations");
    fireEvent.change(screen.getByRole("combobox", { name: "Edit Space" }), { target: { value: "liikenne" } });
    expect(onChange).toHaveBeenCalledWith("liikenne");
  });

  it("names a value outside the list as such", () => {
    const { container } = render(
      <EnumCell label="Edit Space" value="gone" options={[{ value: "liikenne" }]} changed notInList="not in the list" onChange={() => undefined} />,
    );
    expect(container.querySelector(".jc-grid-enum-text")).toHaveTextContent("gone (not in the list)");
    expect(container.querySelector(".jc-grid-enum")).toHaveClass("jc-grid-cell-changed", "jc-grid-cell-invalid");
  });
});
