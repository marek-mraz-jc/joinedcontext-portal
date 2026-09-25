/**
 * One indicator's districts as bars, largest first (T-2922, AP-123).
 *
 * Plain HTML rather than a drawing: the bars are a list a screen reader reads as "district, value,
 * unit", and the labels stay at reading size at 375 px, where a scaled drawing shrinks its text
 * with it. The width of a bar is the only thing computed from the data, and it is a number; the
 * colour is the body's design token, never a value an entity carries.
 */
import type { CSSProperties } from "react";
import type { Strings } from "./locales";

export interface Bar {
  territory: string;
  value: number;
}

export function DistrictChart({
  id,
  title,
  unit,
  bars,
  s,
}: {
  id: string;
  title: string;
  unit: string;
  bars: Bar[];
  s: Strings;
}) {
  const max = Math.max(0, ...bars.map((bar) => bar.value));
  const format = new Intl.NumberFormat(s.locale, { maximumFractionDigits: 2 });
  const captionId = `chart-${id}`;
  return (
    <figure className="district-chart" aria-labelledby={captionId}>
      <figcaption id={captionId}>
        {s.districtsCompared}: {title}
      </figcaption>
      <ol className="bars">
        {bars.map((bar) => {
          const name = s.territory[bar.territory] ?? bar.territory;
          const share = max > 0 ? Math.max(0, bar.value / max) : 0;
          return (
            <li key={bar.territory} className="bar-row">
              <span className="bar-label">{name}</span>
              <span className="bar-track" aria-hidden="true">
                <span className="bar" style={{ "--share": share } as CSSProperties} />
              </span>
              <span className="bar-value">
                {format.format(bar.value)} {unit}
              </span>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
