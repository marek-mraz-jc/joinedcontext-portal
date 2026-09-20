/**
 * T-1807, T-1808: the map's palette, in one place (UI-15).
 *
 * A canvas paints with colour *values*, not classes: MapLibre parses the strings in a paint
 * spec itself and deck.gl wants an RGB triple, so neither can be handed `bg-primary` or a
 * `var(--color-primary)` a browser would resolve. That is why the map was the one surface of
 * the Portal an installation's brand and the dark theme never reached — eight literals written
 * into two components.
 *
 * The chrome the map draws — the ground it falls back to, the outline that keeps a shape legible,
 * the colour a layer takes when it encodes nothing — is read from `tokens.css` at paint time, so
 * it follows the brand and flips with the theme like everything else. The sequential ramp does
 * not: it is a data scale (ColorBrewer YlOrRd, which is what the Layer manifests name), it has to
 * stay readable against the basemap in both themes, and a reader who has learnt that red means
 * "high" must not find it means something else because an installation changed its primary.
 *
 * The literals below are the last resort, for a renderer with no stylesheet — jsdom in the unit
 * tests, a screenshot worker before the CSS lands. A browser resolves the token every time. They
 * are the only colour values left in the `dashboards` folder, and this is their reason.
 */

/** The value of a CSS custom property on the document, or `fallback` where there is no document. */
export function themeColour(token: string, fallback: string): string {
  if (typeof document === "undefined") {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value === "" ? fallback : value;
}

/** The ground under a map with no basemap: the page's own surface. */
export const basemapColour = (): string => themeColour("--portal-surface-subtle", "#eef1f4");

/** The line that keeps a circle or a polygon legible against whatever is under it. */
export const outlineColour = (): string => themeColour("--portal-neutral-900", "#1f2937");

/** What a layer is painted when it encodes no value: the installation's own primary. */
export const plainColour = (): string => themeColour("--portal-primary", "#2563eb");

/**
 * Yellow→orange→red, the "YlOrRd" ramp the Layer manifests name, as four stops. A data scale,
 * not a brand colour, and deliberately the same in both themes — see the note above.
 */
export const RAMP = ["#ffffb2", "#fecc5c", "#fd8d3c", "#e31a1c"];

/** `#rrggbb` as the RGB triple deck.gl accessors return, and `[0, 0, 0]` for anything else. */
export function rgbOf(colour: string): [number, number, number] {
  const hex = colour.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  const long = /^#([0-9a-f]{6})$/i.exec(hex);
  if (short) {
    return [short[1], short[2], short[3]].map((part) => Number.parseInt(part + part, 16)) as [
      number,
      number,
      number,
    ];
  }
  if (long) {
    const value = Number.parseInt(long[1], 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }
  const parsed = /^rgba?\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)/i.exec(hex);
  if (parsed) {
    return [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])].map((part) =>
      Math.max(0, Math.min(255, Math.round(part))),
    ) as [number, number, number];
  }
  // A token that resolved to something deck.gl cannot read — `oklch()`, a colour name — is
  // drawn black rather than dropped, so a layer is never invisible without saying why.
  return [0, 0, 0];
}
