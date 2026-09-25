import { useMemo } from "react";
import { Card, Grid, Page, useClient, useEntities, useFunction } from "@joinedcontext/sdk";
import type { Schema, TypeSchema } from "@joinedcontext/sdk";
import { navigate } from "../components/AppShell";
import { BarChartCard } from "../components/charts";
import { Loading, Problem } from "../components/states";
import { StatTiles } from "../components/StatTiles";
import type { Summary } from "../../functions/summary";
import { t } from "../i18n";
import { sourcesOf } from "../endpoints";
import type { TypeSource } from "../endpoints";
import { shapeOf } from "./shape";

function TypeCard({ source, schema }: { source: TypeSource; schema?: TypeSchema }) {
  const { type, endpoint } = source;
  const { rows, loading, error } = useEntities(type, endpoint ? { endpoint } : undefined);
  const shape = useMemo(() => shapeOf(schema, rows), [schema, rows]);
  const measure = shape.numbers[0];
  return (
    <Card
      title={type}
      actions={
        <button type="button" onClick={() => navigate(source.id)}>
          {t("overview.open")}
        </button>
      }
    >
      {endpoint && <p className="app-source">{t("overview.from", { endpoint })}</p>}
      <Problem error={error} />
      <StatTiles
        rows={rows}
        loading={loading}
        tiles={[{ label: t("overview.entities"), agg: "count" }, ...(measure ? [{ label: t("stat.average", { attr: measure }), agg: "avg" as const, attr: measure }] : [])]}
      />
      {shape.categories[0] && <BarChartCard rows={rows} x={shape.categories[0]} y={measure} agg={measure ? "avg" : "count"} top={10} />}
    </Card>
  );
}

/**
 * A card per entity type from the rows, and the same counts computed by the `summary` function.
 * An application reading several endpoints (SDK-02) names on each card the endpoint its type is
 * read through: the client picks it by type, so a page only names the type.
 */
export function Overview({ schema }: { schema: Schema }) {
  const types = Object.keys(schema).sort();
  const { config } = useClient();
  const sources = sourcesOf(types, config);
  const summary = useFunction<Summary>("summary", { types }, { enabled: types.length > 0 });
  return (
    <Page label={t("page.overview")}>
      <Grid columns={4}>
        {sources.map((source) => (
          <TypeCard key={source.id} source={source} schema={schema[source.type]} />
        ))}
      </Grid>
      <Card title={t("overview.summary")}>
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
