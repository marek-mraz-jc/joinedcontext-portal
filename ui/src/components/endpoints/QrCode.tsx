import { useMemo } from "react";
import { encode } from "uqr";

/**
 * `value` as a QR code a phone camera opens (T-5296): one SVG path of the dark modules, built
 * from uqr's module matrix, so no markup string reaches the DOM. Black on white with the
 * four-module quiet zone ISO/IEC 18004 asks for, in both themes, since a scanner reads contrast;
 * `label` is the accessible name and should carry the address itself.
 */
export function QrCode({ value, label, size = 128 }: { value: string; label: string; size?: number }) {
  const { path, width } = useMemo(() => {
    const { data } = encode(value, { ecc: "M", border: 4 });
    let d = "";
    data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { path: d, width: data.length };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${width} ${width}`}
      shapeRendering="crispEdges"
      className="rounded-sm"
    >
      <title>{label}</title>
      <rect width={width} height={width} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
