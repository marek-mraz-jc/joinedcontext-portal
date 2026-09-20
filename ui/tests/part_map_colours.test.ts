/**
 * T-1807, T-1808: the map follows the theme (UI-15, UI-16, TS-19).
 *
 * The map was the one surface of the Portal an installation's brand and the dark theme never
 * reached: eight colour literals written into MapLibreView and DeckGlOverlay, because a canvas
 * paints with values and cannot be handed a class. The chrome now reads `tokens.css` at paint
 * time; the sequential ramp deliberately does not, and these cases hold both halves of that.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  basemapColour,
  outlineColour,
  plainColour,
  RAMP,
  rgbOf,
  themeColour,
} from "../src/components/dashboards/mapColours";

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

describe("the map's palette", () => {
  it("takes_the_installations_own_colour_when_the_theme_carries_one", () => {
    document.documentElement.style.setProperty("--portal-primary", "#7c2d12");
    document.documentElement.style.setProperty("--portal-surface-subtle", "#101014");
    document.documentElement.style.setProperty("--portal-neutral-900", "#f4f4f5");

    expect(plainColour()).toBe("#7c2d12");
    expect(basemapColour()).toBe("#101014");
    expect(outlineColour()).toBe("#f4f4f5");
  });

  it("falls_back_only_where_there_is_no_stylesheet_to_read", () => {
    // jsdom with nothing set, a screenshot worker before the CSS lands: the map still paints.
    expect(plainColour()).toBe("#2563eb");
    expect(basemapColour()).toBe("#eef1f4");
    expect(outlineColour()).toBe("#1f2937");
  });

  it("a_token_whose_value_is_blank_is_not_a_colour", () => {
    document.documentElement.style.setProperty("--portal-primary", "   ");
    expect(plainColour()).toBe("#2563eb");
  });

  it("reads_a_token_by_name_and_trims_what_the_browser_returns", () => {
    document.documentElement.style.setProperty("--portal-info", " #0ea5e9 ");
    expect(themeColour("--portal-info", "#000000")).toBe("#0ea5e9");
    expect(themeColour("--portal-nothing-defines-this", "#abcdef")).toBe("#abcdef");
  });

  it("the_data_ramp_is_four_stops_and_does_not_follow_the_brand", () => {
    document.documentElement.style.setProperty("--portal-primary", "#7c2d12");
    // A reader who has learnt that red means "high" must not find it means something else
    // because an installation changed its primary: the ramp is a scale, not a brand colour.
    expect(RAMP).toEqual(["#ffffb2", "#fecc5c", "#fd8d3c", "#e31a1c"]);
  });
});

describe("what deck.gl can be handed", () => {
  it("reads_the_six_and_three_digit_hex_a_theme_may_carry", () => {
    expect(rgbOf("#2563eb")).toEqual([37, 99, 235]);
    expect(rgbOf("#FFFFB2")).toEqual([255, 255, 178]);
    expect(rgbOf("#fff")).toEqual([255, 255, 255]);
    expect(rgbOf("#08f")).toEqual([0, 136, 255]);
  });

  it("reads_the_rgb_form_a_browser_returns_for_a_computed_property", () => {
    // `getComputedStyle` gives back `rgb(37, 99, 235)` for a resolved colour in most browsers,
    // which is why the hex-only parser this replaced would have drawn every themed layer black.
    expect(rgbOf("rgb(37, 99, 235)")).toEqual([37, 99, 235]);
    expect(rgbOf("rgba(37 99 235 / 0.5)")).toEqual([37, 99, 235]);
  });

  it("clamps_and_rounds_rather_than_handing_deckgl_a_channel_it_cannot_use", () => {
    expect(rgbOf("rgb(-5, 300, 12.6)")).toEqual([0, 255, 13]);
  });

  it("draws_black_for_a_value_it_cannot_read_rather_than_dropping_the_layer", () => {
    // `oklch()` and `color-mix()` are what `tokens.css` is written in; a browser resolves them
    // before `getComputedStyle` answers, but a layer must never vanish if one ever arrives raw.
    expect(rgbOf("oklch(0.7 0.1 250)")).toEqual([0, 0, 0]);
    expect(rgbOf("")).toEqual([0, 0, 0]);
  });
});

/**
 * T-1493: axe on dev reported `link-in-text-block` (serious) on every dashboard.
 *
 * MapLibre writes the attribution itself — a link inside a line of text, told apart from that text
 * by colour alone (UI-16, UI-30). The control is the library's DOM, and jsdom draws no map, so what
 * is held here is the rule that dresses it.
 */
describe("the map's own attribution", () => {
  it("underlines its link, because colour is not the only way to tell it from the text", () => {
    const css = readFileSync(join(__dirname, "..", "src", "index.css"), "utf8");
    const rule = /\.maplibregl-ctrl-attrib a\s*\{[^}]*text-decoration:\s*underline/;

    expect(css, "the rule lives in index.css: the element belongs to maplibre-gl").toMatch(rule);
  });
});
