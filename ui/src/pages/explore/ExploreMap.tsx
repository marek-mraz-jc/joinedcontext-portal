/**
 * The explorer's map (T-3256): every located entity of the view on one map, counted circles at low
 * zoom that open as one zooms in, a popup with the entity's main attributes, and a button to open
 * the entity itself. It reads the same view as the table, the page's filter and the grid's filter
 * row joined, through the person's endpoint with their session, so it shows what they may read.
 */
import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { fetchEntities } from "../../components/entities/filters";
import type { EntityQuery } from "../../components/entities/filters";
import { MapLibreView } from "../../components/dashboards/MapLibreView";
import { PageFailed, PageLoading } from "../../components/ui/PageState";
import { collect, geometryOf } from "./exportView";

/** The most entities the map draws; past it, the person narrows the filter. */
export const MAP_MAX = 5_000;

type Entity = Record<string, unknown>;

/** The located entities as one feature collection, each carrying its id and its shown attributes. */
export function mapFeatures(entities: Entity[], columns: string[]): { type: "FeatureCollection"; features: unknown[] } {
  const features = entities.flatMap((entity) => {
    const geometry = geometryOf(entity);
    if (!geometry || typeof entity.id !== "string") return [];
    const properties: Record<string, unknown> = { id: entity.id };
    for (const column of columns) {
      const value = entity[column];
      if (value !== undefined && value !== null && typeof value !== "object") properties[column] = value;
    }
    return [{ type: "Feature", geometry, properties }];
  });
  return { type: "FeatureCollection", features };
}

/** Whether a type has a place: a GeoProperty in its model, or the conventional `location`. */
export function isLocated(slots: { name: string; kind: string }[]): boolean {
  return slots.some((slot) => slot.kind === "GeoProperty" || slot.name === "location");
}

export function ExploreMap({
  project,
  slug,
  query,
  columns,
  geo,
  onOpen,
}: {
  project: string;
  slug: string;
  /** The view: the type and both filters joined. */
  query: EntityQuery;
  /** The attributes a popup shows, the main ones first. */
  columns: string[];
  /** The type's geometry attributes, `location` first. */
  geo: string[];
  onOpen: (id: string) => void;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const shown = columns.slice(0, 4);
  const attrs = [...new Set([...geo, ...shown])];
  const located = useQuery({
    queryKey: ["explore-map", slug, query.type, query.q, query.scopeQ, query.idPattern, attrs.join(",")],
    enabled: Boolean(query.type),
    retry: false,
    queryFn: () =>
      collect(
        async (offset, limit) => {
          // keyValues and only what the popup shows, beside the geometry: a map of thousands of
          // points does not need their whole entities.
          const page = await fetchEntities(slug, { ...query, attrs }, { limit, offset, count: offset === 0 });
          return { rows: page.rows as Entity[], count: page.count };
        },
        { max: MAP_MAX },
      ),
  });

  if (located.isPending) return <PageLoading label={t("explore.map.loading")} lines={4} />;
  if (located.isError) return <PageFailed error={located.error} onRetry={() => void located.refetch()} />;
  const collection = mapFeatures(located.data.entities, shown);
  const number = new Intl.NumberFormat(i18n.language);
  return (
    <div className="space-y-2">
      <p role="status" className="text-caption text-fg-muted">
        {collection.features.length === 0
          ? t("explore.map.none")
          : t("explore.map.count", {
              count: collection.features.length,
              shown: number.format(collection.features.length),
              total: number.format(located.data.total ?? located.data.entities.length),
            })}
        {located.data.truncated ? ` ${t("explore.map.truncated", { max: number.format(MAP_MAX) })}` : ""}
      </p>
      <div className="h-96 overflow-hidden rounded-lg border border-border">
        <MapLibreView
          project={project}
          label={t("explore.map.label", { type: query.type ?? "" })}
          layers={[
            {
              name: "explore-entities",
              url: "",
              data: collection,
              style: "circle",
              cluster: true,
              popupProperties: shown,
              open: { label: t("explore.map.open"), onOpen },
            },
          ]}
        />
      </div>
    </div>
  );
}
