/** T-6136: the broker page's connected-clients cell and the chip list input, rendered on their own. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { ChipInput } from "../src/pages/mqttbrokers/BrokerEditor";
import { Connected } from "../src/pages/mqttbrokers/MqttBrokersPage";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

describe("connected clients of a role (T-6103)", () => {
  it("names each account with its count and says a dash while nothing was measured", () => {
    const measured = {
      measured: true,
      observedAt: "2026-10-12T08:47:00Z",
      messagesPerSecond: 0,
      publishers: 2,
      reason: null,
      accounts: [{ serviceAccount: "cam-1", connected: 2, since: "2026-10-12T08:46:51Z" }],
      rates: [],
    };
    const { container, unmount } = render(<Connected accounts={["cam-1", "cam-2"]} measured={measured as never} />);
    expect(container.querySelector('[data-account="cam-1"]')?.textContent).toMatch(/^cam-1: 2, newest since /);
    expect(container.querySelector('[data-account="cam-2"]')?.textContent).toBe("cam-2: 0");
    unmount();
    render(<Connected accounts={["cam-1"]} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});

describe("chip list input (T-6103)", () => {
  it("adds a typed value on Enter, refuses a duplicate and removes a chip", () => {
    const onChange = vi.fn();
    render(
      <ChipInput label="Topics" help="One topic per entry" values={["a/b"]} disabled={false} problem={() => undefined} onChange={onChange} />,
    );
    const input = screen.getByRole("textbox", { name: "Topics" });
    fireEvent.change(input, { target: { value: "a/b" } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: " c/d " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(["a/b", "c/d"]);
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("shows the values without an input when read-only", () => {
    render(<ChipInput label="Topics" help="h" values={["a/b"]} disabled problem={() => undefined} onChange={vi.fn()} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("a/b")).toBeTruthy();
  });
});
