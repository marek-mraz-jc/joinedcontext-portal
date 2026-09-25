import { useMemo, useState } from "react";
import { displayName, Grid, Page, useAccess, useEntities, useFilters } from "@joinedcontext/sdk";
import type { FilterBinding, TypeSchema } from "@joinedcontext/sdk";
import { BarChartCard, TimeSeriesCard } from "../components/charts";
import { EntityDetail } from "../components/EntityDetail";
import { EntityForm } from "../components/EntityForm";
import { EntityMap } from "../components/EntityMap";
import { EntityTable } from "../components/EntityTable";
import { ExportButton } from "../components/ExportButton";
import { DateRangeFilter, FilterBar, RangeFilter, SearchBox, SelectFilter } from "../components/filters";
import { StatTiles } from "../components/StatTiles";
import type { StatTile } from "../components/StatTiles";
import { t } from "../i18n";
import { filtersOf, shapeOf } from "./shape";

function Filter({ binding }: { binding: FilterBinding }) {
  switch (binding.def.kind) {
    case "search":
      return <SearchBox binding={binding} />;
    case "select":
      return <SelectFilter binding={binding} />;
    case "range":
      return <RangeFilter binding={binding} />;
    case "dateRange":
      return <DateRangeFilter binding={binding} />;
  }
}

/** One entity type: filters, tiles, map, charts, table, export, detail and, where granted, an edit form. */
/** `endpoint` names where the type is read and written, in an application reading several (SDK-02). */
export function TypePage({ type, schema, endpoint, label = type }: { type: string; schema?: TypeSchema | null; endpoint?: string; label?: string }) {
  const { rows, loading, error, reload } = useEntities(type, endpoint ? { endpoint } : undefined);
  // The shape is read once the first rows arrive, so the filters keep their positions on a reload.
  const [firstRows, setFirstRows] = useState(rows);
  if (firstRows.length === 0 && rows.length > 0) setFirstRows(rows);
  const shape = useMemo(() => shapeOf(schema, firstRows), [schema, firstRows]);
  const filters = useMemo(() => filtersOf(shape), [shape]);
  const { shown, bind, reset } = useFilters(rows, filters);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // The grants of the endpoint the type is read through, not the primary's.
  const { can } = useAccess(endpoint);
  const edit = can("updateAttrs", type).ok ? can("updateAttrs", type) : can("updateEntity", type);
  const selected = shown.find((row) => row.id === selectedId) ?? null;
  const select = (id: string) => {
    setSelectedId(id);
    setEditing(false);
  };

  const measure = shape.numbers[0];
  const tiles: StatTile[] = [
    { label: type, agg: "count" },
    ...shape.numbers.slice(0, 3).map((attr): StatTile => ({ label: t("stat.average", { attr }), agg: "avg", attr })),
  ];

  return (
    <Page label={label}>
      <FilterBar shown={shown.length} total={rows.length} onReset={reset}>
        {filters.map((_, index) => (
          <Filter key={index} binding={bind(index)} />
        ))}
      </FilterBar>
      <StatTiles rows={shown} tiles={tiles} loading={loading} />
      <Grid columns={2}>
        {shape.geo && (
          <EntityMap rows={shown} location={shape.geo} label={shape.label} color={measure} selected={selectedId} onSelect={(row) => select(row.id)} />
        )}
        {shape.categories[0] && (
          <BarChartCard
            rows={shown}
            x={shape.categories[0]}
            y={measure}
            agg={measure ? "avg" : "count"}
            title={measure ? t("chart.averageBy", { measure, category: shape.categories[0] }) : t("chart.countBy", { type, category: shape.categories[0] })}
          />
        )}
        {shape.time && (
          <TimeSeriesCard rows={shown} time={shape.time} y={measure} title={t("chart.overTime", { measure: measure ?? type })} />
        )}
      </Grid>
      <EntityTable rows={shown} loading={loading} error={error} selected={selectedId} onSelect={(row) => select(row.id)} caption={label} />
      <ExportButton rows={shown} filename={type} formats={shape.geo ? ["csv", "geojson", "pdf"] : ["csv", "pdf"]} location={shape.geo} />
      {selected && !editing && (
        <div className="app-detail">
          <EntityDetail row={selected} title={displayName(shape.label ? { ...selected, name: selected[shape.label] } : selected)} onClose={() => setSelectedId(null)} />
          {edit.ok && (
            <button type="button" onClick={() => setEditing(true)}>
              {t("detail.edit")}
            </button>
          )}
        </div>
      )}
      {selected && editing && (
        <EntityForm
          type={type}
          endpoint={endpoint}
          row={selected}
          rows={rows}
          onSaved={() => {
            setEditing(false);
            reload();
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </Page>
  );
}
