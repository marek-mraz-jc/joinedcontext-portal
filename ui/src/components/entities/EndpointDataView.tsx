/**
 * What one Endpoint answers (T-1433; UI-69, EP-07): the grid, read only, over the endpoint itself.
 *
 * The types and their attributes come from the endpoint's own published schema rather than from the
 * DataModel, because the schema is already projected to the policy: what it lists is what this
 * endpoint may publish at all (EP-46, EP-61). An attribute the steward hides is left out of the
 * columns here too, so the effect of a tick in the form is visible as data and not only as a name.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { EntityCompare, enumsOf, originTransport, parseGridConfig, parseQ, relationsOf, sourceFor } from "@joinedcontext/sdk";
import type { ColumnFilter, FilterColumn, FilterKind, GridColumn } from "@joinedcontext/sdk";
import { fetchJson, publishedTypes } from "../../pages/endpoints/SchemaProjectionPanel";
import { classSlots, parseModel } from "../../pages/models/linkml";
import type { ClassView, LinkmlModel, LinkmlSlot } from "../../pages/models/linkml";
import { Button, Checkbox, Field, InlineError, Select, safeHref } from "../ui";
import { columnLabel, displayOrder } from "./displayOrder";
import { gridLabels, PortalEntityGrid } from "./PortalEntityGrid";
import { filtersFromQ } from "./presetFilters";

interface SchemaIndex {
  models?: { name?: string; version?: number }[];
}

/** What a link to this view holds (T-5082): the type, the query as typed, and the order. */
export interface DataLink {
  type?: string;
  q?: string;
  /** `attr` or `attr;desc`, as `orderBy` takes it (CIM 009 4.23). */
  sort?: string;
  /** The reader removed the model's default filter (DM-135): the link opens without it. */
  noDefault?: boolean;
}

/** One value of a row card (DM-135): its label, unit, kind and enum titles as the model gives them. */
export interface CardField {
  name: string;
  label: string;
  /** The unit's symbol, e.g. °C. */
  unit?: string;
  /** The schema's kind: `date`, `date-time`, `number`, `integer`, `uri`, `string`, or empty. */
  kind?: string;
  /** What a reader reads for an enum value, by value. */
  titles?: Record<string, string>;
  /** `view_hidden`: shown under the card's developer fold. */
  hidden?: boolean;
}

/** How a host draws one row of a type as a card for a reader (DM-135, T-5231). */
export interface RowCard {
  type: string;
  /** The class's label in the page's language, else its name made readable. */
  typeLabel: string;
  /** The attribute holding the row's title. */
  title: string;
  fields: CardField[];
  /** The publisher's map defaults for the type (API/11 EP-163), which the host checks against the model. */
  map?: MapDefaults;
}

/** What the widget's map starts from for one type, as `widget.json` lists it. */
export interface MapDefaults {
  geometry?: string;
  colour?: string;
  popup?: string[];
  cluster?: boolean;
}

/** The map defaults of `type` in a `widget.json` answer, members of the wrong shape left out. */
export function mapDefaultsOf(answer: unknown, type: string): MapDefaults | undefined {
  const map = (answer as { map?: unknown } | null)?.map;
  const one = map && typeof map === "object" && Object.hasOwn(map, type) ? (map as Record<string, unknown>)[type] : undefined;
  if (!one || typeof one !== "object") return undefined;
  const { geometry, colour, popup, cluster } = one as Record<string, unknown>;
  const out: MapDefaults = {
    ...(typeof geometry === "string" ? { geometry } : {}),
    ...(typeof colour === "string" ? { colour } : {}),
    ...(Array.isArray(popup) && popup.every((p) => typeof p === "string") ? { popup: popup as string[] } : {}),
    ...(typeof cluster === "boolean" ? { cluster } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Where the publisher starts the table of `type` (API/11 EP-164), as `widget.json` lists it under
 * `table`; members of the wrong shape are left out. It ranks above the model's `view_*` (DM-134).
 */
export function tableDefaultsOf(answer: unknown, type: string): ClassView | undefined {
  const table = (answer as { table?: unknown } | null)?.table;
  const one = table && typeof table === "object" && Object.hasOwn(table, type) ? (table as Record<string, unknown>)[type] : undefined;
  if (!one || typeof one !== "object") return undefined;
  const { filter, orderBy, pageLength, columns } = one as Record<string, unknown>;
  const out: ClassView = {
    ...(typeof filter === "string" ? { filter } : {}),
    ...(typeof orderBy === "string" ? { orderBy } : {}),
    ...(typeof pageLength === "number" && (PAGE_LENGTHS as readonly number[]).includes(pageLength) ? { pageLength } : {}),
    ...(Array.isArray(columns) && columns.length > 0 && columns.every((c) => typeof c === "string") ? { columns: columns as string[] } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

type Sort = { attr: string; dir: "asc" | "desc" } | null;

/** Where the grid stands: the typed query (or none), the column inputs and the order. */
export interface OpenedView {
  filterText: string | null;
  filters?: Record<string, ColumnFilter>;
  sort: Sort;
}

/** Rows per page a reader picks; the model's `view_page_length` picks the first (DM-134). */
export const PAGE_LENGTHS = [10, 20, 50, 100] as const;

/** A link's order, kept only when it names a column of the type: nothing else reaches `orderBy`. */
export function sortOfLink(raw: string | undefined, attributes: string[]): Sort {
  const [attr, dir, ...rest] = (raw ?? "").split(";");
  if (rest.length > 0 || (dir !== undefined && dir !== "asc" && dir !== "desc")) return null;
  return attr === "id" || attributes.includes(attr) ? { attr, dir: dir === "desc" ? "desc" : "asc" } : null;
}

/** One row of the Fields table: an attribute, its type and its description in the schema. */
export interface FieldRow {
  name: string;
  kind: string;
  description: string;
  /** The model's label in the page's language; absent without a published model. */
  label?: string;
}

/**
 * The columns of a type as its published model orders and names them (T-5192, DM-98, DM-100): the
 * ranked slots in rank order are shown, everything else the endpoint answers stays one tick away;
 * a GeoProperty is left to the map. Without a model the schema's attributes keep their order, all
 * shown. Titles resolve model label > model title > field-order.json > the name made readable.
 */
export function columnModel(
  slots: readonly LinkmlSlot[],
  attributes: readonly string[],
  locale: string,
  columns?: readonly string[],
): { order: string[]; shown: string[]; labels: Record<string, string>; widths: Record<string, number>; title?: string } {
  const bySlot = new Map(slots.map((slot) => [slot.name, slot]));
  const titled = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, columnLabel(bySlot.get(name), name, locale)]));
  if (slots.length === 0) return { order: [...attributes], shown: [...attributes], labels: titled(attributes), widths: {} };
  const named = (columns ?? []).filter((name) => attributes.includes(name));
  // `view_columns` orders and picks the shown ones; the rest follow in the model's order.
  const order = [...new Set([...named, ...displayOrder(slots, attributes)])];
  const ranked = order.filter((name) => bySlot.get(name)?.rank !== undefined && bySlot.get(name)?.kind !== "GeoProperty");
  const shown = (named.length > 0 ? named : ranked.length > 0 ? ranked : order).filter((name) => !bySlot.get(name)?.hidden);
  // A width in characters as the cell's pixels at the grid's 14 px type, padding included.
  const widths = Object.fromEntries(
    order.flatMap((name) => {
      const width = bySlot.get(name)?.width;
      return width ? [[name, Math.round(width * 8 + 24)]] : [];
    }),
  );
  const title = order.find((name) => bySlot.get(name)?.role === "title");
  return { order, shown, labels: titled(order), widths, ...(title ? { title } : {}) };
}

/** The card of a type (DM-135): every attribute in the table's order, under its label. */
export function cardOf(
  type: string,
  klass: { label?: Record<string, string> } | undefined,
  slots: readonly LinkmlSlot[],
  shape: { order: string[]; labels: Record<string, string>; title?: string },
  kinds: ReadonlyMap<string, string>,
  enums: Record<string, readonly { value: string; title?: string }[]>,
  locale: string,
  map?: MapDefaults,
): RowCard {
  const bySlot = new Map(slots.map((slot) => [slot.name, slot]));
  return {
    ...(map ? { map } : {}),
    type,
    typeLabel: columnLabel(klass, type, locale),
    title: shape.title ?? "name",
    fields: shape.order.map((name) => {
      const slot = bySlot.get(name);
      // Every enum value, its title or itself: the host offers an enum as a map colour by its titles (T-5239).
      const titles = Object.fromEntries((enums[name] ?? []).map((one) => [one.value, one.title ?? one.value]));
      return {
        name,
        label: shape.labels[name] ?? columnLabel(undefined, name, locale),
        ...(slot?.unit?.symbol ? { unit: slot.unit.symbol } : {}),
        ...(kinds.get(name) ? { kind: kinds.get(name) } : {}),
        ...(Object.keys(titles).length > 0 ? { titles } : {}),
        ...(slot?.hidden ? { hidden: true } : {}),
      };
    }),
  };
}

/** A default filter in words (DM-135): column labels for names, the reader's word for `today`, ≥ for >=. */
export function filterWords(q: string, labels: Record<string, string>, today: string): string {
  return q
    .replace(/[A-Za-z_][A-Za-z0-9_]*/g, (word) => (word === "today" ? today : Object.hasOwn(labels, word) ? labels[word] : word))
    .replace(/>=/g, " ≥ ")
    .replace(/<=/g, " ≤ ")
    .replace(/==/g, " = ")
    .replace(/!=/g, " ≠ ")
    .replace(/(^|[^≥≤=≠ ])([<>])/g, "$1 $2 ")
    .replace(/;/g, ", ")
    .replace(/\|/g, " | ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The same filter, whatever the grid wrote for an empty input. */
function sameFilter(a: OpenedView, b: OpenedView | null): boolean {
  if (!b) return false;
  const filled = (view: OpenedView) =>
    JSON.stringify(Object.entries(view.filters ?? {}).filter(([, one]) => JSON.stringify(one) !== "{}").sort(([x], [y]) => x.localeCompare(y)));
  return (a.filterText ?? "") === (b.filterText ?? "") && filled(a) === filled(b);
}

/**
 * `today`, `today+7d`, `today-1d` in a default filter as dates of the reader's calendar (DM-134),
 * quoted or not; the rest of the `q` stays as written.
 */
export function relativeDates(q: string, today: Date): string {
  return q.replace(/\btoday(?:([+-])(\d{1,3})d)?\b/g, (_match, sign: string | undefined, days: string | undefined) => {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + (sign === "-" ? -1 : 1) * Number(days ?? 0));
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  });
}

/** What filters a column of this schema kind takes: chosen by the schema, never by the loaded rows (critic B5). */
export function formatOfKind(kind: string): GridColumn["format"] | undefined {
  if (kind === "date" || kind === "date-time") return "date";
  if (kind === "number" || kind === "integer") return "number";
  if (kind === "uri") return "link";
  return kind === "string" ? "text" : undefined;
}

const KIND_OF_FORMAT: Record<string, FilterKind> = { date: "date", number: "number", link: "text", text: "text" };

/**
 * Where a table opens without a link of its own (DM-133, DM-134): the model's default filter as
 * filled column inputs, or as text when one input per column cannot hold it; else `view_upcoming`.
 * A filter the `q` parser refuses or that names a column the endpoint does not answer is ignored.
 */
export function presetView(
  view: ClassView | undefined,
  columns: readonly GridColumn[],
  enums: Record<string, unknown[]>,
  today: Date,
): OpenedView | null {
  const attributes = columns.map((column) => column.attr);
  const day = relativeDates("today", today);
  const upcoming = modelView(view, attributes, day);
  if (!view?.filter) return upcoming;
  const q = relativeDates(view.filter, today);
  const sort = upcoming?.sort ?? null;
  const known: FilterColumn[] = columns.map((column) => ({
    key: column.attr,
    attr: column.attr,
    kind: enums[column.attr]?.length ? "enum" : (KIND_OF_FORMAT[column.format ?? "text"] ?? "text"),
  }));
  const filters = filtersFromQ(q, known);
  if (filters) return { filterText: null, filters, sort };
  // Otherwise text the reader can read and clear, but only a `q` the parser takes whose every
  // term names a column of this type: anything else is a publisher's mistake, and the table opens as without it.
  const parsed = parseQ(q);
  const fits = parsed !== null && parsed.every((all) => all.every((term) => attributes.includes(term.path[0] ?? "")));
  return fits ? { filterText: q, sort } : upcoming;
}

/**
 * Where a table opens when its link names no query or order (T-5192): as the class's model says
 * (`view_order_by`, `view_upcoming`), for any type; an events model opens at today, soonest first,
 * the undated last. An attribute the endpoint does not answer is ignored.
 */
export function modelView(
  view: { orderBy?: string; upcoming?: string } | undefined,
  attributes: readonly string[],
  today: string,
): { filterText: string | null; sort: Sort } | null {
  const upcoming = view?.upcoming && attributes.includes(view.upcoming) ? view.upcoming : undefined;
  const sort = sortOfLink(view?.orderBy, [...attributes]) ?? (upcoming ? { attr: upcoming, dir: "asc" as const } : null);
  if (!upcoming && !sort) return null;
  return { filterText: upcoming ? `!${upcoming}|${upcoming}>="${today}"` : null, sort };
}

/** An http(s) address a person opens in a new tab; anything else stays text. */
function webLink(value: unknown, text: string): JSX.Element | string {
  const safe = typeof value === "string" && /^https?:\/\//i.test(value.trim()) ? safeHref(value) : undefined;
  if (!safe) return typeof value === "string" ? value : "";
  return (
    <a className="text-primary-soft-fg underline hover:no-underline" href={safe} target="_blank" rel="noopener noreferrer" title={safe}>
      {text}
    </a>
  );
}

/** The Fields of one type from the endpoint's JSON Schema, in the column order. */
export function fieldsOf(definition: unknown, attributes: string[]): FieldRow[] {
  const properties = ((definition ?? {}) as { properties?: Record<string, unknown> }).properties ?? {};
  return attributes.map((name) => {
    const property = (properties[name] ?? {}) as { type?: unknown; format?: unknown; $ref?: unknown; description?: unknown; anyOf?: unknown };
    const branch = Array.isArray(property.anyOf) ? ((property.anyOf.find((each) => each && typeof each === "object") ?? {}) as typeof property) : property;
    const ref = typeof branch.$ref === "string" ? branch.$ref.split("/").pop() : undefined;
    const kind = typeof branch.format === "string" ? branch.format : typeof branch.type === "string" ? branch.type : ref ?? "";
    return { name, kind, description: typeof property.description === "string" ? property.description : "" };
  });
}

/** The definitions of an endpoint's JSON Schema, `$defs` and `definitions` alike. */
function definitionsOf(schema: unknown): Record<string, unknown> {
  const document = (schema ?? {}) as { definitions?: Record<string, unknown>; $defs?: Record<string, unknown> };
  return { ...document.$defs, ...document.definitions };
}

/** The download of exactly the rows the grid asked: the endpoint's `file.csv` with its type, query and order. */
function csvHref(origin: string | undefined, slug: string, type: string, q: string | undefined, orderBy: string | undefined): string {
  const query = new URLSearchParams({ type, ...(q ? { q } : {}), ...(orderBy ? { orderBy } : {}) });
  return `${origin ?? ""}/api/endpoint/${encodeURIComponent(slug)}/file.csv?${query.toString()}`;
}

/**
 * The attributes of the type as a list rather than a table: three columns do not fit a phone, one
 * entry a line does. With a published model each entry ticks its column in or out (T-5192).
 */
function FieldList({ fields, shown, onShown }: { fields: FieldRow[]; shown?: string[]; onShown?: (next: string[]) => void }): JSX.Element {
  const { t } = useTranslation();
  return (
    <details className="rounded border border-border p-2">
      <summary className="cursor-pointer text-body font-medium text-fg">{t("endpoints.data.fields")}</summary>
      {onShown ? <p className="mt-1 text-caption text-fg-muted">{t("endpoints.data.fieldsHint")}</p> : null}
      <ul className="mt-2 divide-y divide-border" aria-label={t("endpoints.data.fields")}>
        {fields.map((field) => (
          <li key={field.name} className="flex flex-col gap-0.5 py-2">
            <span className="text-body">
              {onShown && shown ? (
                <Checkbox
                  label={field.label ?? field.name}
                  checked={shown.includes(field.name)}
                  onChange={() => onShown(shown.includes(field.name) ? shown.filter((each) => each !== field.name) : [...shown, field.name])}
                />
              ) : (
                <span className="font-mono">{field.name}</span>
              )}
              <span className="text-caption text-fg-muted">
                {field.label ? <> · <span className="font-mono">{field.name}</span></> : null}
                {" · "}
                {t("endpoints.data.fieldType")}: {field.kind || "—"}
              </span>
            </span>
            <span className="text-caption text-fg-muted">{field.description || t("endpoints.data.noDescription")}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The view's actions: compare with the space (only when the endpoint serves one, T-1435), the full
 * window, and the CSV download of the current query.
 */
function DataActions({
  space,
  comparing,
  onCompare,
  full,
  onFull,
  csv,
}: {
  space?: string;
  comparing: boolean;
  onCompare: () => void;
  full: boolean;
  onFull: () => void;
  csv?: string;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {space ? (
          <Button size="sm" variant="secondary" onClick={onCompare}>
            {comparing ? t("endpoints.data.compareClose") : t("endpoints.data.compare")}
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" aria-pressed={full} onClick={onFull}>
          {full ? t("endpoints.data.fullLeave") : t("endpoints.data.full")}
        </Button>
        {csv ? (
          <a className="focus-ring touch-target rounded-sm text-caption text-primary-soft-fg underline hover:no-underline" href={safeHref(csv)} download>
            {t("endpoints.data.csv")}
          </a>
        ) : null}
      </div>
      {csv ? <p className="text-caption text-fg-muted">{t("endpoints.data.csvHelp")}</p> : null}
    </>
  );
}

export interface EndpointDataViewProps {
  project: string;
  /** The endpoint's slug: the grid reads through it, never through a URL of its own (EP-55). */
  slug: string;
  /** `spec.projection.hiddenAttributes`, including what the open form has ticked but not saved. */
  hidden?: string[];
  /**
   * The space this endpoint serves (`spec.contextSpaceRef`), for the comparison of T-1435. Without
   * one there is nothing to compare against and the button is absent.
   */
  space?: string;
  /** Where the view opens: a shared link's type, query and order (T-5082). */
  link?: DataLink;
  /** Every change of type, query or order, for a host that writes them into its address. */
  onLink?: (next: DataLink) => void;
  /** The card of the chosen type, for a host that draws a row's detail itself (DM-135). */
  onCard?: (card: RowCard) => void;
  /** A row opened by the reader, for a host that shows it in its own card instead of the grid's detail. */
  onOpenRow?: (id: string) => void;
  /** The endpoint serves `file.csv`, so the current query can be downloaded as a table. */
  csv?: boolean;
  /**
   * Where `/api/endpoint/{slug}` answers: the Portal's own origin with the person's session
   * (default), or the catalogue's `https://api.{domain}`, read without a cookie or token (T-5082).
   */
  origin?: string;
}

/** Where the grid opens: the kept or preset view, else the link's query and order; the page length and order as text. */
function gridState(kept: OpenedView | null, link: DataLink | undefined, columns: string[], pageLength: number | null, modelLength: number | undefined) {
  const opened: OpenedView = kept ?? { filterText: link?.q ?? null, sort: sortOfLink(link?.sort, columns) };
  return {
    opened,
    filtered: opened.filterText !== null || Object.keys(opened.filters ?? {}).length > 0,
    rowsPerPage: pageLength ?? modelLength ?? 20,
    sortText: opened.sort ? `${opened.sort.attr}${opened.sort.dir === "desc" ? ";desc" : ""}` : undefined,
  };
}

/** A `uri` column's cell as a link named in words (T-5192). */
function linkRenderers(links: Set<string>, text: string): Record<string, (cell: unknown) => JSX.Element | string> {
  return Object.fromEntries(
    [...links].map((name) => [
      name,
      (cell: unknown) => webLink(cell && !Array.isArray(cell) ? (cell as { value?: unknown }).value : undefined, text),
    ]),
  );
}

/** The full window is a modal dialog over the page; Escape leaves it. */
function windowProps(full: boolean, label: string): JSX.IntrinsicElements["div"] {
  return full
    ? { className: "fixed inset-0 z-50 flex flex-col gap-3 overflow-auto bg-bg p-4", role: "dialog", "aria-modal": true, "aria-label": label }
    : { className: "flex flex-col gap-3" };
}

/** The endpoint's published schema: its index, the JSON Schema of the newest version and its model. */
function useEndpointSchema(base: string, slug: string) {
  const index = useQuery({
    queryKey: ["endpoint-schema-index", slug],
    retry: false,
    queryFn: () => fetchJson(`${base}/index.json`) as Promise<SchemaIndex>,
  });
  const version = index.data?.models?.[0]?.version ?? 1;
  const schema = useQuery({
    queryKey: ["endpoint-schema-artifact", slug, version, "json-schema"],
    enabled: index.isSuccess,
    retry: false,
    queryFn: () => fetchJson(`${base}/v${version}/json-schema`),
  });

  // The published model names and orders the columns (T-5192); an endpoint without one, or a read
  // that fails, keeps the schema's own attribute names.
  const model = useQuery({
    queryKey: ["endpoint-schema-artifact", slug, version, "linkml"],
    enabled: index.isSuccess,
    retry: false,
    queryFn: async () => {
      const answer = await fetch(new Request(`${base}/v${version}/model.linkml.yaml`, { headers: { Accept: "text/yaml" } }));
      return answer.ok ? parseModel(await answer.text()) : null;
    },
  });
  return { index, schema, model };
}

/** The chosen type of the schema and its columns as the published model presents them (DM-134). */
function useTypeColumns(
  schemaData: unknown,
  modelData: LinkmlModel | null | undefined,
  chosen: string,
  hidden: string[],
  picked: string[] | null,
  language: string,
  widgetData: unknown,
) {
  const types = useMemo(() => publishedTypes(schemaData), [schemaData]);
  const type = types.find((each) => each.name === chosen) ?? types[0];
  const columns = useMemo(() => (type ? type.attributes.filter((attribute) => !hidden.includes(attribute)) : []), [type, hidden]);
  const klass = type && modelData ? modelData.classes.find((each) => each.name === type.name) : undefined;
  // The Endpoint's table start wins over the model's, member by member (EP-164, DM-134).
  const view = useMemo((): ClassView | undefined => {
    const table = type ? tableDefaultsOf(widgetData, type.name) : undefined;
    return klass?.view || table ? { ...klass?.view, ...table } : undefined;
  }, [klass, widgetData, type]);
  const slots = useMemo(() => (klass && modelData ? classSlots(modelData, klass) : []), [modelData, klass]);
  const shape = useMemo(() => columnModel(slots, columns, language, view?.columns), [slots, columns, language, view]);
  const shownColumns = useMemo(() => shape.order.filter((name) => (picked ?? shape.shown).includes(name)), [shape, picked]);
  // The endpoint's own schema names its enums: such a column is filtered by picking (UI-86).
  const defs = useMemo(() => definitionsOf(schemaData), [schemaData]);
  const enums = useMemo(() => (type ? enumsOf(defs[type.name], defs, language) : {}), [defs, type, language]);
  // Its relationship ends are columns picked from the target's entities (UI-84).
  const relations = useMemo(() => (type ? relationsOf(defs[type.name]) : {}), [defs, type]);
  const kinds = useMemo(
    () => new Map(type ? fieldsOf(defs[type.name], columns).map((field) => [field.name, field.kind]) : []),
    [defs, type, columns],
  );
  // A `uri` attribute is a link a person opens, named in words rather than printed whole (T-5192).
  const links = useMemo(() => new Set([...kinds].filter(([, kind]) => kind === "uri").map(([name]) => name)), [kinds]);
  // Every column as the model presents it (DM-134): its label, its width, the row's title pinned
  // first, and the filter its schema type takes.
  const gridColumns = useMemo(
    (): GridColumn[] =>
      shownColumns.map((attribute) => {
        const format = formatOfKind(kinds.get(attribute) ?? "");
        return {
          attr: attribute,
          // Without a `view_role: title`, `name` is the label attribute of the Smart Data Models (T-3097).
          ...(attribute === (shape.title ?? "name") ? { pinned: true } : {}),
          ...(shape.labels[attribute] ? { label: shape.labels[attribute] } : {}),
          ...(shape.widths[attribute] ? { width: shape.widths[attribute] } : {}),
          ...(format ? { format } : {}),
        };
      }),
    [shownColumns, kinds, shape],
  );
  return { types, type, columns, klass, view, slots, shape, shownColumns, defs, enums, relations, links, kinds, gridColumns };
}

/** The model's default view, and whether the reader removed it (DM-135): kept in the link. */
function useDefaultView(
  view: ClassView | undefined,
  gridColumns: readonly GridColumn[],
  enums: Record<string, unknown[]>,
  link: DataLink | undefined,
) {
  const [dropped, setDropped] = useState(link?.noDefault === true);
  const defaults = useMemo(() => presetView(view, gridColumns, enums, new Date()), [view, gridColumns, enums]);
  const preset = link?.q || link?.sort || dropped ? null : defaults;
  return { dropped, setDropped, defaults, preset };
}

/** Hands the host the card of the chosen type (DM-135) whenever it changes. */
function useRowCard(
  type: string | undefined,
  klass: { label?: Record<string, string> } | undefined,
  slots: readonly LinkmlSlot[],
  shape: { order: string[]; labels: Record<string, string>; title?: string },
  kinds: ReadonlyMap<string, string>,
  enums: Record<string, readonly { value: string; title?: string }[]>,
  locale: string,
  map: MapDefaults | undefined,
  onCard: ((card: RowCard) => void) | undefined,
) {
  const card = useMemo(
    () => (type ? cardOf(type, klass, slots, shape, kinds, enums, locale, map) : null),
    [type, klass, slots, shape, kinds, enums, locale, map],
  );
  useEffect(() => {
    if (card) onCard?.(card);
  }, [card, onCard]);
}

/** A class's label in the page's language, else its name made readable. */
function classLabel(model: LinkmlModel | null | undefined, name: string, locale: string): string {
  return columnLabel(model?.classes.find((one) => one.name === name), name, locale);
}

/** A host that opens rows itself takes them from the grid, which then opens none. */
function openRowProps(onOpenRow: ((id: string) => void) | undefined) {
  return onOpenRow ? { openRow: null, onOpenRow: (id: string | null) => id && onOpenRow(id) } : {};
}

/**
 * The model's default filter as a chip the reader removes (DM-135), shown as filled inputs too (DM-134);
 * a reset of every filter and a way back to the default.
 */
function DefaultFilter({
  filter,
  defaults,
  opened,
  filtered,
  labels,
  onClear,
  onRestore,
}: {
  filter: string | undefined;
  defaults: OpenedView | null;
  opened: OpenedView;
  filtered: boolean;
  labels: Record<string, string>;
  onClear: () => void;
  onRestore: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const set = defaults !== null && (defaults.filterText !== null || Object.keys(defaults.filters ?? {}).length > 0);
  const words = filter && set ? filterWords(filter, labels, t("endpoints.data.today")) : null;
  const atDefault = words !== null && sameFilter(opened, defaults);
  return (
    <>
      {atDefault ? (
        <span className="inline-flex min-h-11 items-center gap-1 rounded-full border border-border bg-surface-muted pl-3 text-body">
          {t("endpoints.data.defaultFilter", { filter: words })}
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11 min-w-11 rounded-full"
            aria-label={t("endpoints.data.removeDefault", { filter: words })}
            onClick={onClear}
          >
            <span aria-hidden="true">×</span>
          </Button>
        </span>
      ) : null}
      {filtered ? (
        <Button size="sm" variant="secondary" onClick={onClear}>
          {t("endpoints.data.resetFilters")}
        </Button>
      ) : null}
      {words !== null && !atDefault ? (
        <Button size="sm" variant="secondary" onClick={onRestore}>
          {t("endpoints.data.restoreDefault")}
        </Button>
      ) : null}
    </>
  );
}

export function EndpointDataView({
  project,
  slug,
  hidden = [],
  space,
  link,
  onLink,
  onCard,
  onOpenRow,
  csv = false,
  origin,
}: EndpointDataViewProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const [chosen, setChosen] = useState<string>(link?.type ?? "");
  const [full, setFull] = useState(false);
  // The query the grid last asked, for the link and the download of exactly these rows.
  const [asked, setAsked] = useState<string | undefined>(link?.q);
  const [comparing, setComparing] = useState(false);
  const root = origin ?? window.location.origin;
  const base = `${root}/api/endpoint/${slug}/schema`;
  // Another origin is read anonymously: a cross-origin fetch with `same-origin` credentials sends no cookie.
  const source = useMemo(
    () => (origin ? sourceFor({ kind: "endpoint", slug }, originTransport((path, init) => fetch(origin + String(path), init)), i18n.language) : undefined),
    [origin, slug, i18n.language],
  );

  const { index, schema, model } = useEndpointSchema(base, slug);
  // The publisher's widget defaults (EP-163, EP-164); none, or an error, leaves the model's.
  const widget = useQuery({
    queryKey: ["endpoint-widget", slug],
    retry: false,
    queryFn: () => fetchJson(`${root}/api/endpoint/${slug}/widget.json`),
  });
  const [picked, setPicked] = useState<string[] | null>(null);
  const { types, type, columns, klass, view: classView, slots, shape, shownColumns, defs, enums, relations, links, kinds, gridColumns } =
    useTypeColumns(schema.data, model.data, chosen, hidden, picked, i18n.language, widget.data);
  // The order, the column inputs and the typed query the grid opens with; the grid holds them from then on.
  const [view, setView] = useState<OpenedView | null>(null);
  const [pageLength, setPageLength] = useState<number | null>(null);
  const { dropped, setDropped, defaults, preset } = useDefaultView(classView, gridColumns, enums, link);
  const { opened, filtered, rowsPerPage, sortText } = gridState(view ?? preset, link, columns, pageLength, classView?.pageLength);
  useEffect(() => {
    if (type) onLink?.({ type: type.name, q: asked || undefined, sort: sortText, ...(dropped ? { noDefault: true } : {}) });
  }, [type, asked, sortText, dropped, onLink]);
  const map = useMemo(() => (type ? mapDefaultsOf(widget.data, type.name) : undefined), [widget.data, type]);
  useRowCard(type?.name, klass, slots, shape, kinds, enums, i18n.language, map, onCard);
  const onQuery = useCallback((query: { q?: string }) => setAsked(query.q), []);

  // Escape leaves the full window, as it closes a dialog.
  useEffect(() => {
    if (!full) return;
    const leave = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [full]);
  const config = useMemo(() => {
    if (!type) {
      return null;
    }
    return (
      parseGridConfig({
        source: { kind: "endpoint", slug },
        type: type.name,
        columns: gridColumns,
        pageSize: rowsPerPage,
        // Read only here: a value is corrected in the explorer, where the person chose the endpoint
        // for that purpose.
        mode: "view",
        history: { enabled: true },
      }).config ?? null
    );
  }, [slug, type, gridColumns, rowsPerPage]);

  const compareLabels = useMemo(
    () => ({
      left: t("endpoints.data.spaceSide"),
      right: t("endpoints.data.endpointSide"),
      missingRow: t("endpoints.data.missingRow"),
      hiddenColumn: t("endpoints.data.hiddenColumn"),
      lead: t("endpoints.data.compareLead"),
      same: t("endpoints.data.same"),
      loading: t("app.loading"),
      error: t("app.error.generic"),
      leftRefused: t("endpoints.data.spaceRefused"),
      previous: t("entityGrid.previous"),
      next: t("entityGrid.next"),
      page: t("entityGrid.page"),
    }),
    [t],
  );
  const labels = useMemo(() => gridLabels(t), [t]);
  const fields = useMemo(
    () => (type ? fieldsOf(defs[type.name], shape.order).map((field) => ({ ...field, label: shape.labels[field.name] })) : []),
    [defs, type, shape],
  );
  const renderers = useMemo(() => linkRenderers(links, t("endpoints.data.openLink")), [links, t]);

  // A refused or failed schema read says why, in the surface's own sentence (a 403 names the grant).
  const failed = index.error ?? schema.error;
  if (failed) {
    return <InlineError>{failed.message}</InlineError>;
  }
  if (index.isPending || schema.isPending || widget.isPending) {
    return <p role="status">{t("endpoints.projection.loading")}</p>;
  }
  if (!type || !config) {
    return <p className="text-caption text-fg-muted">{t("endpoints.data.noSchema")}</p>;
  }

  return (
    <div {...windowProps(full, t("endpoints.data.title"))}>
      {/* One level of controls (T-5415): type and page size side by side from md (768 px), full width each
          on a phone, so both selects have one width and one left edge. */}
      <div className="grid gap-3 md:grid-cols-2">
      <Field id={`endpoint-data-type-${slug}`} label={t("endpoints.data.type")} description={t("endpoints.data.typeHelp")}>
        <Select
          id={`endpoint-data-type-${slug}`}
          value={type.name}
          onChange={(event) => {
            setChosen(event.target.value);
            // Another type has other columns: its query and order start empty.
            setView({ filterText: null, sort: null });
            setPicked(null);
            setAsked(undefined);
          }}
        >
          {types.map((each) => (
            <option key={each.name} value={each.name}>
              {classLabel(model.data, each.name, i18n.language)}
            </option>
          ))}
        </Select>
      </Field>
        <Field id={`endpoint-data-rows-${slug}`} label={t("endpoints.data.pageLength")} description={t("endpoints.data.pageLengthHelp")}>
          <Select id={`endpoint-data-rows-${slug}`} value={String(rowsPerPage)} onChange={(event) => setPageLength(Number(event.target.value))}>
            {PAGE_LENGTHS.map((each) => (
              <option key={each} value={each}>
                {each}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {/* Two doors on the same page of entities: what this endpoint's filter and projection leave
          out is marked on the space's side (T-1435). The CSV is the whole answer of this query as
          one table, built by the endpoint under its own limits and read with the person's own
          session, as the rows are (EP-08, EP-44). */}
      <DataActions
        space={space}
        comparing={comparing}
        onCompare={() => setComparing((each) => !each)}
        full={full}
        onFull={() => setFull((each) => !each)}
        csv={csv ? csvHref(origin, slug, type.name, asked, sortText) : undefined}
      />
      <div className="flex flex-wrap items-center gap-2 empty:hidden">
        <DefaultFilter
          filter={classView?.filter}
          defaults={defaults}
          opened={opened}
          filtered={filtered}
          labels={shape.labels}
          onClear={() => {
            setDropped(true);
            setView({ filterText: null, filters: {}, sort: opened.sort });
          }}
          onRestore={() => {
            setDropped(false);
            setView(defaults);
          }}
        />
      </div>
      <FieldList fields={fields} {...(slots.length > 0 ? { shown: shownColumns, onShown: setPicked } : {})} />

      {comparing && space ? (
        <EntityCompare
          key={`${slug}-${type.name}-${space}`}
          config={config}
          left={sourceFor({ kind: "space", space }, originTransport(), i18n.language)}
          right={sourceFor({ kind: "endpoint", slug }, originTransport(), i18n.language)}
          labels={compareLabels}
          gridLabels={labels}
        />
      ) : (
        <PortalEntityGrid
          key={`${slug}-${type.name}`}
          project={project}
          config={config}
          source={source}
          enums={enums}
          relations={relations}
          renderers={renderers}
          view={opened}
          onGridState={(next) => setView({ filterText: next.filterText ?? null, filters: next.filters, sort: next.sort ?? null })}
          onQuery={onQuery}
          {...openRowProps(onOpenRow)}
        />
      )}
    </div>
  );
}
