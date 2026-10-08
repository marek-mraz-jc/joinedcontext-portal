import { useMemo, useState } from "react";
import { Grid, Page, useEntities, useEntitySelection, useFilters } from "@joinedcontext/sdk";
import type { FilterBinding, TypeSchema } from "@joinedcontext/sdk";
import { BarChartCard, TimeSeriesCard } from "../components/charts";
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

/** One entity type: filters, tiles, map, charts, table and export; a map feature or a row opens the SDK's entity panel. */
/** `endpoint` names where the type is read and written, in an application reading several (SDK-02). */
export function TypePage({ type, schema, endpoint, label = type }: { type: string; schema?: TypeSchema | null; endpoint?: string; label?: string }) {
  const { rows, loading, error } = useEntities(type, endpoint ? { endpoint } : undefined);
  // The shape is read once the first rows arrive, so the filters keep their positions on a reload.
  const [firstRows, setFirstRows] = useState(rows);
  if (firstRows.length === 0 && rows.length > 0) setFirstRows(rows);
  const shape = useMemo(() => shapeOf(schema, firstRows), [schema, firstRows]);
  const filters = useMemo(() => filtersOf(shape), [shape]);
  const { shown, bind, reset } = useFilters(rows, filters);

  // The panel shows, and where the reader may, edits the entity (SDK-40); the map and the table mark it.
  const selection = useEntitySelection();
  const selectedId = selection.selected?.type === type ? selection.selected.id : null;
  const select = (id: string) => selection.select({ id, type, endpoint });

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
    </Page>
  );
}
