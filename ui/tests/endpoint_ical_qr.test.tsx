/**
 * T-5296: the QR code of a webcal:// address (the Endpoint page no longer shows it since the owner's
 * 2026-10-30 pass; the component waits for its next home).
 */
import { render, screen } from "@testing-library/react";
import { encode } from "uqr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { QrCode } from "../src/components/endpoints/QrCode";

const SLUG = "k7m2qz4tv6xh3n5jb2ryd3wcfa";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function darkModules(svg: Element): number {
  return (svg.querySelector("path")?.getAttribute("d")?.match(/M/g) ?? []).length;
}

describe("the QR code", () => {
  it("draws every dark module of the encoded address inside a four-module quiet zone", () => {
    const value = `webcal://api.dev.example/api/endpoint/${SLUG}/ical/v1/kalendar.ics`;
    render(<QrCode value={value} label={`QR ${value}`} />);
    const svg = screen.getByRole("img", { name: `QR ${value}` });
    const { data } = encode(value, { ecc: "M", border: 4 });
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${data.length} ${data.length}`);
    expect(darkModules(svg)).toBe(data.flat().filter(Boolean).length);
    // The quiet zone: the outer four rows and columns stay light.
    expect(data.slice(0, 4).flat().some(Boolean)).toBe(false);
    expect(data.map((row) => row.slice(0, 4)).flat().some(Boolean)).toBe(false);
  });

  it("encodes another address into other modules", () => {
    const { container } = render(
      <>
        <QrCode value="webcal://a.example/ical/v1/a.ics" label="a" />
        <QrCode value="webcal://a.example/ical/v1/b.ics" label="b" />
      </>,
    );
    const [a, b] = Array.from(container.querySelectorAll("path")).map((p) => p.getAttribute("d"));
    expect(a).not.toBe(b);
  });
});
