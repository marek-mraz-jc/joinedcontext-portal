/**
 * The explorer's map (T-3256): every located entity of the view on one map, counted circles at low
 * zoom that open as one zooms in, a popup with the entity's main attributes, and a button to open
 * the entity itself. It reads the same view as the table, the page's filter and the grid's filter
 * row joined, through the person's endpoint with their session, so it shows what they may read.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { fetchEntities } from "../../components/entities/filters";
import type { EntityQuery } from "../../components/entities/filters";
import { MapLibreView } from "../../components/dashboards/MapLibreView";
import type { Bbox } from "../../components/dashboards/MapLibreView";
import { InlineError } from "../../components/ui/InlineError";
import { PageFailed, PageLoading } from "../../components/ui/PageState";
import { collect, geometryOf } from "./exportView";

/** The most entities the map draws at once; past it, the map reads the part in view. */
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
  const key = [slug, query.type, query.q, query.scopeQ, query.idPattern, attrs.join(",")];
  // keyValues and only what the popup shows, beside the geometry: a map of thousands of points
  // does not need their whole entities.
  const read = (within?: Bbox) =>
    collect(
      async (offset, limit) => {
        const page = await fetchEntities(slug, { ...query, attrs }, { limit, offset, count: offset === 0, within, geoproperty: geo[0] });
        return { rows: page.rows as Entity[], count: page.count };
      },
      { max: MAP_MAX },
    );
  const located = useQuery({
    queryKey: ["explore-map", ...key],
    enabled: Boolean(query.type),
    retry: false,
    queryFn: () => read(),
  });
  // Past MAP_MAX the map reads the part in view after every pan or zoom (T-5061), as the
  // catalogue's map and the dashboards do, so a view of 10 000 entities stays whole where one looks.
  const [view, setView] = useState<Bbox | null>(null);
  const onMoveEnd = useCallback((box: Bbox) => setView(box), []);
  const paged = located.data?.truncated === true;
  const inView = useQuery({
    queryKey: ["explore-map-view", ...key, view?.join(",")],
    enabled: paged && view !== null,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: () => read(view ?? undefined),
  });

  if (located.isPending) return <PageLoading label={t("explore.map.loading")} lines={4} />;
  if (located.isError) return <PageFailed error={located.error} onRetry={() => void located.refetch()} />;
  const drawn = paged && inView.data ? inView.data : located.data;
  const collection = mapFeatures(drawn.entities, shown);
  const number = new Intl.NumberFormat(i18n.language);
  const total = number.format(located.data.total ?? located.data.entities.length);
  let status: string;
  if (collection.features.length === 0) {
    status = t(paged && inView.data ? "explore.map.noneInView" : "explore.map.none");
  } else {
    status = t(paged && inView.data ? "explore.map.inView" : "explore.map.count", {
      count: collection.features.length,
      shown: number.format(collection.features.length),
      total,
    });
  }
  if (paged) {
    status += `${status.endsWith(".") ? "" : "."} ${t(inView.data?.truncated ? "explore.map.truncated" : "explore.map.paged", { max: number.format(MAP_MAX) })}`;
  }
  return (
    <div className="space-y-2">
      <p role="status" className="text-caption text-fg-muted">
        {status}
        {inView.isFetching ? ` ${t("explore.map.reading")}` : ""}
      </p>
      {inView.isError ? (
        <InlineError>
          {t("explore.map.viewFailed", { reason: inView.error instanceof Error ? inView.error.message : String(inView.error) })}
        </InlineError>
      ) : null}
      {collection.features.length === 0 && !paged ? null : (
      <div className="h-96 overflow-hidden rounded-lg border border-border">
        <MapLibreView
          project={project}
          label={t("explore.map.label", { type: query.type ?? "" })}
          onMoveEnd={paged ? onMoveEnd : undefined}
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
      )}
    </div>
  );
}
