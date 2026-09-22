import { useEntities } from "@joinedcontext/sdk";
import { Problem } from "../components/states";
import { STATION, totals } from "../stations";

/** Three numbers for the whole city: stations, bikes available now, and stations with none. */
export function Overview() {
  const { rows, loading, error, reload } = useEntities(STATION);
  const sum = totals(rows);
  const tiles: Array<[string, number]> = [
    ["Stations", sum.stations],
    ["Bikes available", sum.bikes],
    ["Stations empty", sum.empty],
  ];
  const number = new Intl.NumberFormat();
  return (
    <section className="app-page" aria-label="Overview">
      <Problem error={error} onRetry={reload} />
      <section className="jc-tiles">
        {tiles.map(([label, value]) => (
          <div className="jc-tile" key={label}>
            <span className="jc-tile-label">{label}</span>
            <strong className="jc-tile-value">{loading ? "…" : number.format(value)}</strong>
          </div>
        ))}
      </section>
    </section>
  );
}
