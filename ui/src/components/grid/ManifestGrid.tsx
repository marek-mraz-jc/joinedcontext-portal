/**
 * The one grid of a project's manifests (T-6115, owner 2026-10-29: "one data grid ... easy to
 * sort, query, paginate"): every list page of the sidebar draws its rows through it, so the
 * search, the filter chips, the Columns and Sort panels, the footer and the cell panel look and
 * behave the same on Endpoints, Subscriptions, Data models and Pipelines.
 *
 * The page passes its rows and columns; a column that names a `spec` field is edited in the cell
 * panel with the control the kind's jc-core JSON Schema gives it (`fieldWidget`), and the edit is
 * a checked proposal through the manifest write path, never a write of its own. The server
 * decides every edit: a refusal (403, 422) is shown on the field it was for.
 */
import { useId, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { api, queryKeys, unwrap } from "../../api/client";
import { isChange } from "../../api/manifest";
import type { Change, Manifest, ResourceProposal } from "../../api/manifest";
import { proposeChecked } from "../../api/proposal";
import { ResourceNamePicker } from "../pickers/ResourceNamePicker";
import { ToolbarPopover } from "../entities/GridToolbar";
import { PageFailed } from "../ui/PageState";
import {
  Button,
  Checkbox,
  Dialog,
  Field,
  Icon,
  Input,
  PermissionGuard,
  Select,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableSkeleton,
} from "../ui";
import { fieldWidget, specValue, withSpecValue } from "./fieldWidget";
import type { FieldWidget } from "./fieldWidget";

export interface GridColumn<T> {
  id: string;
  label: string;
  /** The column's value as text: what search, sort and the filter chips read. */
  text: (row: T) => string;
  /** What the cell draws; the text when absent. */
  cell?: (row: T) => ReactNode;
  /** The `spec` path (`audience`, `notification.format`) the cell panel edits for this column. */
  field?: string;
  /** Offers a filter chip per value the rows hold. */
  filter?: boolean;
  /** Left out until the person ticks it under Columns. */
  hidden?: boolean;
  /** Sorted as a number rather than as text. */
  numeric?: boolean;
  align?: "left" | "right";
}

export interface ManifestGridProps<T> {
  /** Names the table for a screen reader and keys the columns a person chose in this browser. */
  caption: string;
  storageKey: string;
  rows: T[];
  rowKey: (row: T) => string;
  /** The list's read, for the skeleton, the failure panel and its retry. */
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  /** The first column, the row's name: a link to the object, never hidden. */
  name: GridColumn<T>;
  columns: GridColumn<T>[];
  /** The row's menu, at the row's end. */
  actions?: (row: T) => ReactNode;
  /** What an empty list says, with the page's create action. */
  empty: ReactNode;
  /**
   * The search a page holds in its header and has already applied to `rows`; without it the grid
   * draws its own box and searches every column.
   */
  search?: string;
  onSearchChange?: (text: string) => void;
  searchLabel: string;
  /** Where cell edits go; without it the cell panel only reads. */
  edit?: {
    project: string;
    plural: string;
    kind: string;
    manifest: (row: T) => Manifest | null;
    onChange: (change: Change) => void;
  };
  pageSize?: number;
  /** How many rows the list holds before the page's own search, when `rows` is already narrowed. */
  total?: number;
}

type Sort = { column: string; desc: boolean } | null;

const PAGE = 50;

/** The browser key a grid keeps its chosen columns under: a view preference (UI-09). */
function columnsKey(storageKey: string): string {
  return `jc.list.${storageKey}.columns`;
}

function readShown(storageKey: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(columnsKey(storageKey));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) && parsed.every((each) => typeof each === "string") ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function writeShown(storageKey: string, shown: string[]): void {
  try {
    window.localStorage.setItem(columnsKey(storageKey), JSON.stringify(shown));
  } catch {
    // Kept for this page only: which columns show is a convenience, not the data.
  }
}

/** The rows `search`, `filters` and `sort` leave, in order. Exported for its test. */
export function visibleRows<T>(
  rows: T[],
  columns: GridColumn<T>[],
  search: string,
  filters: Record<string, string[]>,
  sort: Sort,
): T[] {
  const needle = search.trim().toLowerCase();
  const kept = rows.filter((row) => {
    if (needle && !columns.some((column) => column.text(row).toLowerCase().includes(needle))) return false;
    return Object.entries(filters).every(([id, values]) => {
      const column = columns.find((each) => each.id === id);
      return !column || values.length === 0 || values.includes(column.text(row));
    });
  });
  const by = sort ? columns.find((each) => each.id === sort.column) : undefined;
  if (!sort || !by) return kept;
  const sign = sort.desc ? -1 : 1;
  return [...kept].sort((a, b) => {
    const left = by.text(a);
    const right = by.text(b);
    if (by.numeric) return sign * ((Number(left) || 0) - (Number(right) || 0));
    return sign * left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
  });
}

export function ManifestGrid<T>(props: ManifestGridProps<T>): JSX.Element {
  const { caption, storageKey, rows, rowKey, query, name, columns, actions, empty, edit, searchLabel } = props;
  const { t } = useTranslation();
  const [ownSearch, setOwnSearch] = useState("");
  const search = props.search ?? ownSearch;
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [sort, setSort] = useState<Sort>(null);
  const step = props.pageSize ?? PAGE;
  // Rows shown past the first page, for this search and these filters only: a new query starts at the top.
  const [more, setMore] = useState(0);
  const [askedBefore, setAskedBefore] = useState("");
  const [shown, setShown] = useState<string[]>(
    () => readShown(storageKey) ?? columns.filter((column) => !column.hidden).map((column) => column.id),
  );
  const [panel, setPanel] = useState<{ key: string; focus?: string } | null>(null);

  const all = useMemo(() => [name, ...columns], [name, columns]);
  const visibleColumns = columns.filter((column) => shown.includes(column.id));
  const asked = JSON.stringify([search, filters]);
  if (askedBefore !== asked) {
    setAskedBefore(asked);
    setMore(0);
  }
  const limit = step + more;
  const kept = useMemo(() => visibleRows(rows, all, props.search === undefined ? ownSearch : "", filters, sort), [rows, all, props.search, ownSearch, filters, sort]);
  const page = kept.slice(0, limit);
  const width = visibleColumns.length + (actions ? 2 : 1);
  const chips = Object.entries(filters).flatMap(([id, values]) => values.map((value) => ({ id, value })));
  const filterable = columns.filter((column) => column.filter);
  const opened = panel ? rows.find((row) => rowKey(row) === panel.key) : undefined;

  if (query.isError) {
    return <PageFailed error={query.error} onRetry={() => void query.refetch()} />;
  }

  const toggleFilter = (id: string, value: string) =>
    setFilters((now) => {
      const values = now[id] ?? [];
      return { ...now, [id]: values.includes(value) ? values.filter((each) => each !== value) : [...values, value] };
    });
  const choose = (next: string[]) => {
    setShown(next);
    writeShown(storageKey, next);
  };
  const sortBy = (id: string) =>
    setSort((now) => (now?.column === id ? (now.desc ? null : { column: id, desc: true }) : { column: id, desc: false }));

  const header = (column: GridColumn<T>, primary = false) => {
    const state = sort?.column === column.id ? (sort.desc ? "descending" : "ascending") : undefined;
    return (
      <TableHeaderCell key={column.id} align={column.align} aria-sort={state} className={primary ? undefined : "whitespace-nowrap"}>
        <button
          type="button"
          className="focus-ring inline-flex items-center gap-1 rounded-sm font-semibold hover:text-primary-soft-fg"
          onClick={() => sortBy(column.id)}
          aria-label={t("grid.sortBy", { column: column.label })}
        >
          {column.label}
          {state ? <Icon name={state === "ascending" ? "arrowUp" : "arrowDown"} className="size-3.5" /> : null}
        </button>
      </TableHeaderCell>
    );
  };

  return (
    <div className="flex flex-col gap-3" data-manifest-grid={storageKey}>
      <div role="toolbar" aria-label={t("grid.toolbar", { list: caption })} className="flex flex-wrap items-center gap-2">
        {props.search === undefined ? (
          <div className="w-full sm:w-64">
            <Input type="search" aria-label={searchLabel} placeholder={searchLabel} value={ownSearch} onChange={(event) => setOwnSearch(event.target.value)} />
          </div>
        ) : null}
        {filterable.length > 0 ? (
          <ToolbarPopover label={t("grid.filter")} count={chips.length} anchored>
            <div className="flex flex-col gap-3">
              {filterable.map((column) => {
                const values = [...new Set(rows.map((row) => column.text(row)).filter(Boolean))].sort();
                return (
                  <fieldset key={column.id} className="flex flex-col gap-1">
                    <legend className="mb-1 text-caption font-semibold text-fg-muted">{column.label}</legend>
                    {values.length === 0 ? <p className="text-caption text-fg-muted">{t("grid.noValues")}</p> : null}
                    {values.map((value) => (
                      <Checkbox
                        key={value}
                        label={value}
                        hint={String(rows.filter((row) => column.text(row) === value).length)}
                        checked={(filters[column.id] ?? []).includes(value)}
                        onChange={() => toggleFilter(column.id, value)}
                      />
                    ))}
                  </fieldset>
                );
              })}
            </div>
          </ToolbarPopover>
        ) : null}
        <ToolbarPopover label={t("grid.columns")} count={columns.length - visibleColumns.length || undefined}>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-caption text-fg-muted">{t("grid.columnsHint")}</legend>
            {columns.map((column) => (
              <Checkbox
                key={column.id}
                label={column.label}
                checked={shown.includes(column.id)}
                onChange={() => choose(shown.includes(column.id) ? shown.filter((id) => id !== column.id) : [...shown, column.id])}
              />
            ))}
          </fieldset>
        </ToolbarPopover>
        <ToolbarPopover label={t("grid.sort")} count={sort ? 1 : undefined}>
          <div className="flex flex-col gap-2">
            <label className="text-caption text-fg-muted" htmlFor={`${storageKey}-sort`}>
              {t("grid.sortHint")}
            </label>
            <Select
              id={`${storageKey}-sort`}
              value={sort?.column ?? ""}
              onChange={(event) => setSort(event.target.value ? { column: event.target.value, desc: sort?.desc ?? false } : null)}
            >
              <option value="">{t("grid.sortNone")}</option>
              {all.map((column) => (
                <option key={column.id} value={column.id}>
                  {column.label}
                </option>
              ))}
            </Select>
            {sort ? (
              <Select aria-label={t("grid.sortDirection")} value={sort.desc ? "desc" : "asc"} onChange={(event) => setSort({ ...sort, desc: event.target.value === "desc" })}>
                <option value="asc">{t("grid.ascending")}</option>
                <option value="desc">{t("grid.descending")}</option>
              </Select>
            ) : null}
          </div>
        </ToolbarPopover>
        {chips.map(({ id, value }) => (
          <Button
            key={`${id}=${value}`}
            variant="secondary"
            size="sm"
            icon={<Icon name="close" className="size-3.5" />}
            aria-label={t("grid.removeFilter", { column: all.find((each) => each.id === id)?.label ?? id, value })}
            onClick={() => toggleFilter(id, value)}
          >
            {all.find((each) => each.id === id)?.label}: {value}
          </Button>
        ))}
        {chips.length > 1 ? (
          <Button variant="ghost" size="sm" onClick={() => setFilters({})}>
            {t("grid.clearFilters")}
          </Button>
        ) : null}
      </div>

      <Table data-records="" caption={caption} status={query.isPending ? t("app.loading") : undefined}>
        <TableHead>
          {header(name, true)}
          {visibleColumns.map((column) => header(column))}
          <TableHeaderCell align="right">
            <span className="sr-only">{t("grid.details")}</span>
          </TableHeaderCell>
          {actions ? <TableHeaderCell align="right">{t("approvals.actions")}</TableHeaderCell> : null}
        </TableHead>
        {query.isPending ? (
          <TableSkeleton columns={width + 1} />
        ) : (
          <TableBody>
            {page.length === 0 ? (
              <TableEmpty columns={width + 1}>
                {rows.length > 0 ? (
                  <div className="flex flex-col items-center gap-2 py-6 text-center">
                    <p className="text-body font-medium text-fg">{t("grid.noMatch")}</p>
                    <Button variant="secondary" size="sm" onClick={() => { setFilters({}); setOwnSearch(""); props.onSearchChange?.(""); }}>
                      {t("grid.clearAll")}
                    </Button>
                  </div>
                ) : (
                  empty
                )}
              </TableEmpty>
            ) : (
              page.map((row) => {
                const key = rowKey(row);
                return (
                  <TableRow key={key}>
                    <TableCell primary className="align-middle">
                      {name.cell ? name.cell(row) : name.text(row)}
                    </TableCell>
                    {visibleColumns.map((column) => (
                      <TableCell
                        key={column.id}
                        align={column.align}
                        className="align-middle"
                        // A click on a value opens it in the panel rather than the row's object.
                        onClick={(event) => {
                          event.preventDefault();
                          setPanel({ key, focus: column.id });
                        }}
                      >
                        {column.cell ? column.cell(row) : column.text(row) || <span className="text-fg-subtle">—</span>}
                      </TableCell>
                    ))}
                    <TableCell align="right" className="align-middle" onClick={(event) => event.preventDefault()}>
                      <Button variant="ghost" size="sm" aria-label={t("grid.openDetails", { name: name.text(row) })} icon={<Icon name="sidebar" className="size-4" />} onClick={() => setPanel({ key })} />
                    </TableCell>
                    {actions ? (
                      <TableCell align="right" className="align-middle" onClick={(event) => event.preventDefault()}>
                        {actions(row)}
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        )}
      </Table>

      {!query.isPending && kept.length > 0 && (kept.length > page.length || kept.length !== (props.total ?? rows.length)) ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="text-caption text-fg-muted">
            {kept.length === (props.total ?? rows.length)
              ? t("grid.footer", { shown: page.length, count: kept.length })
              : t("grid.footerOf", { shown: page.length, count: kept.length, total: props.total ?? rows.length })}
          </p>
          {kept.length > page.length ? (
            <Button variant="secondary" size="sm" onClick={() => setMore(limit)}>
              {t("grid.showMore", { count: Math.min(step, kept.length - page.length) })}
            </Button>
          ) : null}
        </div>
      ) : null}

      {opened !== undefined ? (
        <CellPanel
          row={opened}
          name={name}
          columns={columns}
          focus={panel?.focus}
          edit={edit}
          onClose={() => setPanel(null)}
        />
      ) : null}
    </div>
  );
}

/** Every column of one row, the hidden ones too, each editable field with its own control and save. */
function CellPanel<T>({
  row,
  name,
  columns,
  focus,
  edit,
  onClose,
}: {
  row: T;
  name: GridColumn<T>;
  columns: GridColumn<T>[];
  focus?: string;
  edit: ManifestGridProps<T>["edit"];
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const manifest = edit?.manifest(row) ?? null;
  const schema = useQuery({
    queryKey: ["kind-schema", edit?.kind],
    enabled: edit !== undefined,
    staleTime: 60 * 60_000,
    retry: false,
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/kinds/{kind}/schema", { params: { path: { kind: edit?.kind ?? "" } } })),
  });
  // A focused column first, so the value a person clicked is the first thing the panel reads.
  const ordered = focus ? [...columns.filter((c) => c.id === focus), ...columns.filter((c) => c.id !== focus)] : columns;
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={name.text(row)}
      description={t("grid.panelLead")}
      closeLabel={t("app.close")}
      size="md"
    >
      <dl className="flex flex-col gap-4">
        {ordered.map((column) => {
          const resolved = edit && manifest && column.field && schema.data ? fieldWidget(edit.kind, schema.data, column.field) : null;
          return (
            <div key={column.id} className="flex flex-col gap-1" data-panel-field={column.id}>
              {resolved && edit && manifest && column.field ? (
                <FieldEditor
                  label={column.label}
                  description={resolved.description}
                  widget={resolved.widget}
                  manifest={manifest}
                  path={column.field}
                  edit={edit}
                  autoFocus={column.id === focus}
                  onDone={onClose}
                />
              ) : (
                <>
                  <dt className="text-caption font-semibold text-fg-muted">{column.label}</dt>
                  <dd className="text-body text-fg">{column.cell ? column.cell(row) : column.text(row) || "—"}</dd>
                </>
              )}
            </div>
          );
        })}
      </dl>
    </Dialog>
  );
}

/** The value as the control holds it: a reference by its name, a list as a list. */
function controlValue(widget: FieldWidget, value: unknown): unknown {
  if (widget.kind === "reference") {
    if (typeof value === "string") return value;
    const named = value as { name?: unknown } | null | undefined;
    return typeof named?.name === "string" ? named.name : "";
  }
  if (widget.kind === "multiEnum") return Array.isArray(value) ? value : [];
  if (widget.kind === "boolean") return value === true;
  return value === undefined || value === null ? "" : String(value);
}

/** The control's value as the manifest stores it; `undefined` removes an optional member. */
function storedValue(widget: FieldWidget, held: unknown, before: unknown): unknown {
  if (widget.kind === "reference") {
    const text = String(held);
    // A typed reference keeps its kind and namespace; only the name moves.
    return typeof before === "object" && before !== null ? { ...before, name: text } : text;
  }
  if (widget.kind === "number") return held === "" ? undefined : Number(held);
  if (widget.kind === "boolean" || widget.kind === "multiEnum") return held;
  return held === "" ? undefined : held;
}

/** The example a field's hint shows, by its widget. */
function example(widget: FieldWidget, t: (key: string, values?: Record<string, unknown>) => string): string {
  switch (widget.kind) {
    case "enum":
    case "multiEnum":
      return t("grid.hint.choose", { example: widget.options[0]?.value ?? "" });
    case "reference":
      return t("grid.hint.reference");
    case "boolean":
      return t("grid.hint.boolean");
    case "number":
      return t("grid.hint.number", { example: widget.integer ? "60" : "1.5" });
    case "duration":
      return t("grid.hint.duration");
    case "dateTime":
      return t("grid.hint.dateTime");
    default:
      return t("grid.hint.text");
  }
}

function FieldEditor({
  label,
  description,
  widget,
  manifest,
  path,
  edit,
  autoFocus,
  onDone,
}: {
  label: string;
  description?: string;
  widget: FieldWidget;
  manifest: Manifest;
  path: string;
  edit: Omit<NonNullable<ManifestGridProps<unknown>["edit"]>, "manifest">;
  autoFocus: boolean;
  onDone: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const before = specValue(manifest, path);
  const [held, setHeld] = useState<unknown>(() => controlValue(widget, before));
  const changed = JSON.stringify(held) !== JSON.stringify(controlValue(widget, before));
  const propose = useMutation({
    mutationFn: async () => {
      const next = withSpecValue(manifest, path, storedValue(widget, held, before));
      const { status: _status, ...body } = next as Manifest & { status?: unknown };
      return proposeChecked(edit.project, edit.plural, body as unknown as ResourceProposal, false);
    },
    onSuccess: (result) => {
      if (isChange(result)) edit.onChange(result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.changes(edit.project) });
      onDone();
    },
  });
  const error = propose.error instanceof Error ? propose.error.message : propose.error ? String(propose.error) : null;
  // Only the schema's first sentence: the rest names requirement ids a person does not need here.
  const lead = description?.split(/(?<=\.)\s/)[0];
  const hint = [lead, example(widget, t)].filter(Boolean).join(" ");

  const control = (() => {
    switch (widget.kind) {
      case "enum":
        return (
          <Select id={id} autoFocus={autoFocus} value={String(held)} onChange={(event) => setHeld(event.target.value)}>
            {widget.nullable || held === "" ? <option value="">{t("grid.platformDefault")}</option> : null}
            {widget.options.map((option) => (
              <option key={option.value} value={option.value} title={option.description}>
                {option.value}
              </option>
            ))}
          </Select>
        );
      case "multiEnum": {
        const list = held as string[];
        return (
          <div id={id} role="group" aria-label={label} className="flex flex-wrap gap-x-4 gap-y-1">
            {widget.options.map((option) => (
              <Checkbox
                key={option.value}
                label={option.value}
                checked={list.includes(option.value)}
                onChange={() => setHeld(list.includes(option.value) ? list.filter((each) => each !== option.value) : [...list, option.value])}
              />
            ))}
          </div>
        );
      }
      case "reference":
        return (
          <ResourceNamePicker
            id={id}
            labelled
            label={label}
            from={{ project: edit.project, plural: widget.plural }}
            value={String(held)}
            onChange={setHeld}
            empty={t("grid.referenceEmpty")}
          />
        );
      case "boolean":
        return <Switch id={id} autoFocus={autoFocus} checked={held === true} onCheckedChange={setHeld} label={held === true ? t("grid.on") : t("grid.off")} />;
      case "number":
        return (
          <Input id={id} autoFocus={autoFocus} type="number" inputMode="numeric" min={widget.minimum} step={widget.integer ? 1 : "any"} value={String(held)} onChange={(event) => setHeld(event.target.value)} />
        );
      default:
        return <Input id={id} autoFocus={autoFocus} value={String(held)} onChange={(event) => setHeld(event.target.value)} />;
    }
  })();

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed) propose.mutate();
      }}
    >
      <Field id={id} label={label} help={hint} errors={error ? [error] : undefined}>
        {control}
      </Field>
      {changed ? (
        <div className={clsx("flex flex-wrap items-center gap-2")}>
          <PermissionGuard project={edit.project} kind={edit.kind} verb="propose">
            <Button type="submit" size="sm" variant="primary" disabled={propose.isPending}>
              {propose.isPending ? t("grid.proposing") : t("grid.propose")}
            </Button>
          </PermissionGuard>
          <Button type="button" size="sm" variant="ghost" onClick={() => { setHeld(controlValue(widget, before)); propose.reset(); }}>
            {t("grid.undo")}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
