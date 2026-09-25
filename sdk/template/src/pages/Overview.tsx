import { useMemo } from "react";
import { Card, Grid, Page, useEntities, useFunction } from "@joinedcontext/sdk";
import type { Schema, TypeSchema } from "@joinedcontext/sdk";
import { navigate } from "../components/AppShell";
import { BarChartCard } from "../components/charts";
import { Loading, Problem } from "../components/states";
import { StatTiles } from "../components/StatTiles";
import type { Summary } from "../../functions/summary";
import { shapeOf } from "./shape";

function TypeCard({ type, schema }: { type: string; schema?: TypeSchema }) {
  const { rows, loading, error } = useEntities(type);
  const shape = useMemo(() => shapeOf(schema, rows), [schema, rows]);
  const measure = shape.numbers[0];
  return (
    <Card
      title={type}
      actions={
        <button type="button" onClick={() => navigate(type)}>
          Open
        </button>
      }
    >
      <Problem error={error} />
      <StatTiles
        rows={rows}
        loading={loading}
        tiles={[{ label: "Entities", agg: "count" }, ...(measure ? [{ label: `Average ${measure}`, agg: "avg" as const, attr: measure }] : [])]}
      />
      {shape.categories[0] && <BarChartCard rows={rows} x={shape.categories[0]} y={measure} agg={measure ? "avg" : "count"} top={10} />}
    </Card>
  );
}

/** A card per entity type from the rows, and the same counts computed by the `summary` function. */
export function Overview({ schema }: { schema: Schema }) {
  const types = Object.keys(schema).sort();
  const summary = useFunction<Summary>("summary", { types }, { enabled: types.length > 0 });
  return (
    <Page label="Overview">
      <Grid columns={4}>
        {types.map((type) => (
          <TypeCard key={type} type={type} schema={schema[type]} />
        ))}
      </Grid>
      <Card title="Server summary">
        {summary.loading && <Loading />}
        <Problem error={summary.error} onRetry={summary.reload} />
        {summary.data && (
          <ul>
            {summary.data.types.map((item) => (
              <li key={item.type}>
                {item.type}: {item.count}
                {Object.entries(item.averages).map(([attr, value]) => ` · ${attr} ${value}`)}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
