import { useMemo, useState } from "react";
import { displayName, useEntities, useFilters } from "@joinedcontext/sdk";
import type { FilterDef } from "@joinedcontext/sdk";
import { EntityDetail } from "../components/EntityDetail";
import { EntityMap } from "../components/EntityMap";
import { EntityTable } from "../components/EntityTable";
import { FilterBar, SearchBox } from "../components/filters";
import { STATION, hasBikes } from "../stations";

const SEARCH: FilterDef[] = [{ kind: "search", attrs: ["name"], label: "Station" }];
const COLUMNS = ["name", "availableBikeNumber", "freeSlotNumber", "totalSlotNumber", "status", "dateModified"];

/** Every station: a search by name, "only stations with bikes", the map coloured by bikes, the table and the detail. */
export function Stations() {
  const { rows, loading, error } = useEntities(STATION);
  const { shown: searched, bind, reset } = useFilters(rows, SEARCH);
  const [withBikes, setWithBikes] = useState(false);
  const shown = useMemo(() => (withBikes ? searched.filter(hasBikes) : searched), [searched, withBikes]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = shown.find((row) => row.id === selectedId) ?? null;

  return (
    <section className="app-page" aria-label="Stations">
      <FilterBar
        shown={shown.length}
        total={rows.length}
        onReset={() => {
          reset();
          setWithBikes(false);
        }}
      >
        <SearchBox binding={bind(0)} />
        <label className="jc-filter">
          <input type="checkbox" checked={withBikes} onChange={(event) => setWithBikes(event.target.checked)} />
          <span>Only stations with bikes</span>
        </label>
      </FilterBar>
      <EntityMap
        rows={shown}
        location="location"
        label="name"
        color="availableBikeNumber"
        selected={selectedId}
        onSelect={(row) => setSelectedId(row.id)}
      />
      <EntityTable
        rows={shown}
        columns={COLUMNS}
        loading={loading}
        error={error}
        selected={selectedId}
        onSelect={(row) => setSelectedId(row.id)}
        initialSort={{ attr: "name", dir: "asc" }}
        caption="Stations"
        empty="No station matches."
      />
      {selected && (
        <div className="app-detail">
          <EntityDetail row={selected} attrs={COLUMNS} title={displayName(selected)} onClose={() => setSelectedId(null)} />
        </div>
      )}
    </section>
  );
}
