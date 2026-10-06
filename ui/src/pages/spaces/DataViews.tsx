/**
 * The views of a space's entities beside the grid (ADR-N-042 §3.2; T-3100…T-3102): the same rows,
 * read through the same space surface with the person's session and narrowed by the same filter,
 * drawn as cards, as a board or on a calendar. Nothing is copied out of the space: each view is a
 * renderer over one page of the type, and a click opens the row whole.
 */
import { useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { cellText, EntityHistory, toRichRow } from "@joinedcontext/sdk";
import { api, unwrap } from "../../api/client";
import type { components } from "../../api/schema";
import type { EntitySource, RichRow } from "@joinedcontext/sdk";
import { Alert, Button, Card, Checkbox, ConfirmDialog, Dialog, ExternalLink, Field, Input, Select } from "../../components/ui";
import { safeHref } from "../../components/ui/safeHref";
import { gridLabels } from "../../components/entities/PortalEntityGrid";

/** How many entities a card, board or calendar view reads: one page, said when it is cut. */
export const VIEW_ROWS = 500;

/** The most fields a card shows beside its primary one (T-3100). */
export const CARD_FIELDS = 5;

/** One page of the type, filtered by `q`, for every view that is not the grid. */
export function useViewRows(source: EntitySource, space: string, type: string, q: string | undefined) {
  return useQuery({
    queryKey: ["space-view-rows", space, type, q ?? ""],
    enabled: type !== "",
    retry: false,
    queryFn: () => source.query({ type, q }, { offset: 0, limit: VIEW_ROWS }),
  });
}

/** What a row is called: its `name`, else its id (ADR-N-042, the primary field of T-3097). */
export function primaryOf(row: RichRow): string {
  return cellText(row.cells.name).trim() || row.id;
}

/** The attributes the rows of a page carry, in name order. */
export function attributesOf(rows: RichRow[]): string[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row.cells)))].sort();
}

/** The attributes whose values are links, the candidates for a card's image. */
export function linkAttributes(rows: RichRow[]): string[] {
  return attributesOf(rows).filter((attr) =>
    rows.some((row) => /^(https?:\/\/|\/(?!\/))/i.test(cellText(row.cells[attr]).trim())),
  );
}

/**
 * Where a card's image comes from. The Portal's CSP loads images from its own origin only
 * (`img-src 'self'`), and widening it would let any value in a space call any host from the page,
 * so a picture elsewhere stays a link the person opens (`external`), never an `<img>`.
 */
export function imageOf(
  row: RichRow,
  attr: string | undefined,
  origin: string = window.location.origin,
): { src: string } | { external: string } | undefined {
  if (!attr) return undefined;
  const text = cellText(row.cells[attr]).trim();
  // A path on this origin or an http(s) URL; a word is not an address.
  if (!/^(https?:\/\/|\/(?!\/))/i.test(text)) return undefined;
  const href = safeHref(text);
  if (!href) return undefined;
  try {
    const url = new URL(href, origin);
    return url.origin === origin ? { src: url.toString() } : { external: url.toString() };
  } catch {
    return undefined;
  }
}

/** The whole row as attribute and value, opened from any view (T-3100). */
export function RowDialog({
  row,
  onClose,
  source,
  children,
  onDelete,
}: {
  row: RichRow | null;
  onClose: () => void;
  /** Where each attribute's history is read (NGSI-LD temporal, T-3107); none, no history. */
  source?: EntitySource;
  /** What the view adds under the attributes: the calendar's reschedule. */
  children?: ReactNode;
  /** Deletes the row, keeping the person's copy (T-3107); none, no delete is offered. */
  onDelete?: (row: RichRow) => Promise<void>;
}): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const [history, setHistory] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  if (!row) return null;
  const attrs = Object.keys(row.cells).sort();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={primaryOf(row)}
      description={<span className="font-mono [overflow-wrap:anywhere]">{row.id}</span>}
      closeLabel={t("app.close")}
      size="md"
    >
      <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[auto_1fr]" data-testid="view-row-detail">
        {attrs.map((attr) => {
          const cell = row.cells[attr];
          const recorded = source?.history && !Array.isArray(cell) && cell?.kind === "property";
          return (
            <div key={attr} className="contents">
              <dt className="text-caption font-semibold text-fg-muted">{attr}</dt>
              <dd className="flex flex-wrap items-center gap-2 text-body text-fg [overflow-wrap:anywhere]">
                <span>{cellText(cell) || "—"}</span>
                {recorded ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-pressed={history === attr}
                    aria-label={t("spaces.views.historyOf", { attr })}
                    onClick={() => setHistory(history === attr ? null : attr)}
                  >
                    {t("spaces.views.history")}
                  </Button>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
      {history && source?.history ? (
        <EntityHistory
          key={history}
          source={source}
          id={row.id}
          attr={history}
          unit={Array.isArray(row.cells[history]) ? undefined : (row.cells[history] as { unitCode?: string }).unitCode}
          heading={t("spaces.views.historyOf", { attr: history })}
          locale={i18n.language}
          labels={gridLabels(t).historyLabels}
          onClose={() => setHistory(null)}
        />
      ) : null}
      {children}
      {refused ? (
        <Alert role="alert" tone="danger">
          {refused}
        </Alert>
      ) : null}
      {onDelete ? (
        <div className="flex justify-end">
          <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
            {t("spaces.views.delete")}
          </Button>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={t("spaces.views.deleteTitle", { name: primaryOf(row) })}
            description={t("spaces.views.deleteLead")}
            confirmLabel={t("spaces.views.delete")}
            tone="danger"
            pending={deleting}
            onConfirm={async () => {
              setDeleting(true);
              setRefused(null);
              try {
                await onDelete(row);
                setConfirming(false);
                onClose();
              } catch (error) {
                setConfirming(false);
                setRefused(
                  t("spaces.views.deleteRefused", {
                    name: primaryOf(row),
                    reason: error instanceof Error ? error.message : String(error),
                  }),
                );
              } finally {
                setDeleting(false);
              }
            }}
          />
        </div>
      ) : null}
    </Dialog>
  );
}

/** The page cut at `VIEW_ROWS`, said rather than shown as if it were the whole type. */
function Truncated({ count }: { count: number }): JSX.Element | null {
  const { t } = useTranslation();
  return count >= VIEW_ROWS ? (
    <p className="text-caption text-fg-muted">{t("spaces.views.truncated", { count: VIEW_ROWS })}</p>
  ) : null;
}

/**
 * Cards (T-3100): the image the person chose, the primary field and up to five fields; a click or
 * Enter on a card opens the row.
 */
export function GalleryView({
  rows,
  source,
  onDelete,
}: {
  rows: RichRow[];
  source?: EntitySource;
  onDelete?: (row: RichRow) => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation();
  const images = useMemo(() => linkAttributes(rows), [rows]);
  const attrs = useMemo(() => attributesOf(rows).filter((attr) => attr !== "name"), [rows]);
  const [image, setImage] = useState<string | null>(null);
  const [fields, setFields] = useState<string[] | null>(null);
  const [open, setOpen] = useState<RichRow | null>(null);
  const chosenImage = image ?? images[0] ?? "";
  const chosenFields = fields ?? attrs.filter((attr) => attr !== chosenImage).slice(0, CARD_FIELDS);

  return (
    <div className="flex flex-col gap-3" data-testid="view-gallery">
      <div className="flex flex-wrap items-end gap-3">
        <Field id="gallery-image" label={t("spaces.views.image")} className="w-fit">
          <Select id="gallery-image" value={chosenImage} onChange={(event) => setImage(event.target.value)}>
            <option value="">{t("spaces.views.noImage")}</option>
            {images.map((attr) => (
              <option key={attr} value={attr}>
                {attr}
              </option>
            ))}
          </Select>
        </Field>
        <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <legend className="text-caption font-semibold text-fg">
            {t("spaces.views.fields", { count: CARD_FIELDS })}
          </legend>
          {attrs.map((attr) => {
            const on = chosenFields.includes(attr);
            return (
              <Checkbox
                key={attr}
                label={attr}
                checked={on}
                disabled={!on && chosenFields.length >= CARD_FIELDS}
                disabledReason={t("spaces.views.fieldsFull", { count: CARD_FIELDS })}
                onChange={(event) =>
                  setFields(
                    event.target.checked
                      ? [...chosenFields, attr]
                      : chosenFields.filter((field) => field !== attr),
                  )
                }
              />
            );
          })}
        </fieldset>
      </div>
      <Truncated count={rows.length} />
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] gap-3">
        {rows.map((row) => {
          const picture = imageOf(row, chosenImage || undefined);
          return (
            <li key={row.id}>
              <Card className="flex h-full flex-col gap-2 p-3">
                {picture && "src" in picture ? (
                  <img src={picture.src} alt="" className="aspect-video w-full rounded-md object-cover" loading="lazy" />
                ) : picture ? (
                  <ExternalLink href={picture.external} className="text-caption">
                    {t("spaces.views.openImage")}
                  </ExternalLink>
                ) : null}
                <Button
                  variant="ghost"
                  className="justify-start px-0 text-left font-semibold [overflow-wrap:anywhere]"
                  onClick={() => setOpen(row)}
                >
                  {primaryOf(row)}
                </Button>
                <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-caption">
                  {chosenFields.map((attr) => (
                    <div key={attr} className="contents">
                      <dt className="text-fg-muted">{attr}</dt>
                      <dd className="text-fg [overflow-wrap:anywhere]">{cellText(row.cells[attr]) || "—"}</dd>
                    </div>
                  ))}
                </dl>
              </Card>
            </li>
          );
        })}
      </ul>
      <RowDialog row={open} onClose={() => setOpen(null)} source={source} onDelete={onDelete} />
    </div>
  );
}

/** One option of an enum slot, as the model titles it (UI-86). */
export interface EnumChoice {
  value: string;
  title?: string;
}

/**
 * The cards of a board, by column: one per permissible value in the model's order, and the rows
 * whose value is none of them (absent, or a value the model no longer lists) under `""`.
 */
export function columnsOf(
  rows: RichRow[],
  attr: string,
  values: EnumChoice[],
  moved: Record<string, string> = {},
): Map<string, RichRow[]> {
  const columns = new Map<string, RichRow[]>(values.map((choice) => [choice.value, []]));
  columns.set("", []);
  for (const row of rows) {
    const value = moved[row.id] ?? cellText(row.cells[attr]).trim();
    (columns.get(value) ?? (columns.get("") as RichRow[])).push(row);
  }
  return columns;
}

/** One move a person made: the row, the value it had and the value it was given. */
interface Move {
  row: RichRow;
  from: string;
  to: string;
}

/**
 * The moves of one view (T-3107): the value each moved row shows until the page is read again, the
 * write itself, and the person's own moves to undo and redo, each replayed as the compensating
 * write through the same source, refused like any write. A move from no value is not offered for
 * undo: the write that compensates it would remove the attribute, which is a deletion, not a move.
 */
export function useMoves(
  current: (row: RichRow) => string | undefined,
  write: (row: RichRow, to: string) => Promise<void>,
) {
  const [shown, setShown] = useState<Record<string, string | undefined>>({});
  const [undone, setUndone] = useState<Move[]>([]);
  const [done, setDone] = useState<Move[]>([]);
  const [refused, setRefused] = useState<{ row: RichRow; reason: string } | null>(null);
  const valueOf = (row: RichRow) => (row.id in shown ? shown[row.id] : current(row));

  const apply = async (row: RichRow, to: string, as: "do" | "undo" | "redo"): Promise<void> => {
    const from = valueOf(row);
    if (to === "" || to === from) return;
    setRefused(null);
    setShown((now) => ({ ...now, [row.id]: to }));
    try {
      await write(row, to);
    } catch (error) {
      setShown((now) => ({ ...now, [row.id]: from }));
      setRefused({ row, reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    const move = { row, from: from ?? "", to };
    if (as === "do") {
      if (move.from !== "") setDone((now) => [...now, move]);
      setUndone([]);
    } else if (as === "undo") {
      setUndone((now) => [...now, { row, from: to, to: move.from }]);
    } else {
      setDone((now) => [...now, { row, from: move.from, to }]);
    }
  };

  const last = done[done.length - 1];
  const next = undone[undone.length - 1];
  return {
    valueOf,
    refused,
    move: (row: RichRow, to: string) => apply(row, to, "do"),
    lastDone: last,
    lastUndone: next,
    undo: async () => {
      if (!last) return;
      setDone((now) => now.slice(0, -1));
      await apply(last.row, last.from, "undo");
    },
    redo: async () => {
      if (!next) return;
      setUndone((now) => now.slice(0, -1));
      await apply(next.row, next.to, "redo");
    },
  };
}

/** Undo and redo of a view's moves, with what each would do in its name; Ctrl+Z and Ctrl+Shift+Z. */
function UndoBar({ moves }: { moves: ReturnType<typeof useMoves> }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={!moves.lastDone}
        disabledReason={t("spaces.views.nothingToUndo")}
        onClick={() => void moves.undo()}
      >
        {moves.lastDone
          ? t("spaces.views.undo", { name: primaryOf(moves.lastDone.row), value: moves.lastDone.from })
          : t("spaces.views.undoNone")}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={!moves.lastUndone}
        disabledReason={t("spaces.views.nothingToRedo")}
        onClick={() => void moves.redo()}
      >
        {moves.lastUndone
          ? t("spaces.views.redo", { name: primaryOf(moves.lastUndone.row), value: moves.lastUndone.to })
          : t("spaces.views.redoNone")}
      </Button>
    </div>
  );
}

/** Ctrl+Z (Cmd+Z) undoes and Ctrl+Shift+Z or Ctrl+Y redoes, anywhere in the view but a text field. */
function undoKeys(moves: ReturnType<typeof useMoves>) {
  return (event: React.KeyboardEvent) => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test((event.target as HTMLElement).tagName)) return;
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) {
      event.preventDefault();
      void moves.undo();
    } else if ((key === "z" && event.shiftKey) || key === "y") {
      event.preventDefault();
      void moves.redo();
    }
  };
}

/**
 * A board (T-3101): columns are the values of one enum attribute of the model, each with how many
 * cards it holds. Dragging a card, or choosing its column from the card itself (the keyboard and
 * screen-reader way to the same move), writes the attribute through the space surface with the
 * person's session; the Endpoint's Policy decides, and a refused move goes back with its words.
 */
export function KanbanView({
  rows,
  source,
  enums,
  onDelete,
}: {
  rows: RichRow[];
  source: EntitySource;
  enums: Record<string, EnumChoice[]>;
  onDelete?: (row: RichRow) => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation();
  const attrs = Object.keys(enums).sort();
  const [chosen, setChosen] = useState("");
  const attr = attrs.includes(chosen) ? chosen : (attrs[0] ?? "");
  const [open, setOpen] = useState<RichRow | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const moves = useMoves(
    (row) => cellText(row.cells[attr]).trim() || undefined,
    async (row, to) => {
      if (!source.patch) throw new Error(t("spaces.views.readOnly"));
      await source.patch(row.id, { [attr]: { type: "Property", value: to } });
    },
  );

  if (attrs.length === 0) {
    return <p className="text-body text-fg-muted">{t("spaces.views.noEnum")}</p>;
  }
  const values = enums[attr];
  const moved = Object.fromEntries(rows.map((row) => [row.id, moves.valueOf(row) ?? ""]));
  const columns = columnsOf(rows, attr, values, moved);
  const titleOf = (value: string) =>
    value === "" ? t("spaces.views.noValue") : (values.find((choice) => choice.value === value)?.title ?? value);

  const move = moves.move;
  const refused = moves.refused
    ? t("spaces.views.moveRefused", { name: primaryOf(moves.refused.row), reason: moves.refused.reason })
    : null;

  return (
    <div className="flex flex-col gap-3" data-testid="view-kanban" onKeyDown={undoKeys(moves)}>
      <UndoBar moves={moves} />
      <Field id="kanban-attr" label={t("spaces.views.groupBy")} className="w-fit">
        <Select id="kanban-attr" value={attr} onChange={(event) => setChosen(event.target.value)}>
          {attrs.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
      </Field>
      {refused ? (
        <Alert role="alert" tone="danger">
          {refused}
        </Alert>
      ) : null}
      <Truncated count={rows.length} />
      <div className="flex gap-3 overflow-x-auto pb-2" role="group" aria-label={t("spaces.views.board", { attr })}>
        {[...columns].map(([value, cards]) =>
          value === "" && cards.length === 0 ? null : (
            <section
              key={value || "none"}
              aria-label={t("spaces.views.column", { title: titleOf(value), count: cards.length })}
              className="flex w-64 shrink-0 flex-col gap-2 rounded-lg border border-border bg-surface-subtle p-2"
              data-testid={`kanban-column-${value || "none"}`}
              onDragOver={(event) => {
                if (dragging && value !== "") event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const row = rows.find((candidate) => candidate.id === dragging);
                setDragging(null);
                if (row) void move(row, value);
              }}
            >
              <h3 className="flex items-center justify-between text-caption font-semibold text-fg">
                <span>{titleOf(value)}</span>
                <span className="tabular-nums text-fg-muted">{cards.length}</span>
              </h3>
              <ul className="flex flex-col gap-2">
                {cards.map((row) => (
                  <li
                    key={row.id}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", row.id);
                      setDragging(row.id);
                    }}
                    onDragEnd={() => setDragging(null)}
                  >
                    <Card className="flex flex-col gap-1 p-2">
                      <Button
                        variant="ghost"
                        className="justify-start px-0 text-left font-semibold [overflow-wrap:anywhere]"
                        onClick={() => setOpen(row)}
                      >
                        {primaryOf(row)}
                      </Button>
                      <label className="flex items-center gap-1 text-caption text-fg-muted">
                        <span className="shrink-0">{t("spaces.views.moveTo")}</span>
                        <Select
                          aria-label={t("spaces.views.moveCard", { name: primaryOf(row) })}
                          value={value}
                          onChange={(event) => void move(row, event.target.value)}
                        >
                          {value === "" ? <option value="">{t("spaces.views.noValue")}</option> : null}
                          {values.map((choice) => (
                            <option key={choice.value} value={choice.value}>
                              {choice.title ?? choice.value}
                            </option>
                          ))}
                        </Select>
                      </label>
                    </Card>
                  </li>
                ))}
              </ul>
            </section>
          ),
        )}
      </div>
      <RowDialog row={open} onClose={() => setOpen(null)} source={source} onDelete={onDelete} />
    </div>
  );
}

/** A date key of a row: an attribute's value, or `attr.observedAt`, when the observation was made. */
const OBSERVED = ".observedAt";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** The day a row falls on by `key`, as `YYYY-MM-DD`, or nothing when that is no date. */
export function dayOf(row: RichRow, key: string): string | undefined {
  const observed = key.endsWith(OBSERVED);
  const cell = row.cells[observed ? key.slice(0, -OBSERVED.length) : key];
  const first = Array.isArray(cell) ? cell[0] : cell;
  const text = observed ? first?.observedAt : first?.kind === "property" ? first.value : undefined;
  return typeof text === "string" && ISO_DATE.test(text) ? text.slice(0, 10) : undefined;
}

/** The date keys a page offers: attributes holding dates, then when each attribute was observed. */
export function dateKeys(rows: RichRow[]): string[] {
  const keys = attributesOf(rows);
  return [
    ...keys.filter((key) => rows.some((row) => dayOf(row, key) !== undefined)),
    ...keys
      .map((key) => `${key}${OBSERVED}`)
      .filter((key) => rows.some((row) => dayOf(row, key) !== undefined)),
  ];
}

/**
 * The attribute moved to `day`, in the shape it was written: a `DateTime` object stays one, a
 * date-time keeps its time of day, a date stays a date. `undefined` for a key that is not a value
 * the person may write (when it was observed is the source's, not an edit).
 */
export function rescheduled(row: RichRow, key: string, day: string): Record<string, unknown> | undefined {
  if (key.endsWith(OBSERVED) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const raw = (row.raw[key] as { value?: unknown } | undefined)?.value;
  const moved = (text: string) => (text.length > 10 ? `${day}${text.slice(10)}` : day);
  if (typeof raw === "string" && ISO_DATE.test(raw)) {
    return { [key]: { type: "Property", value: moved(raw) } };
  }
  const typed = raw as { "@type"?: unknown; "@value"?: unknown } | undefined;
  if (typed && typeof typed["@value"] === "string" && ISO_DATE.test(typed["@value"])) {
    return { [key]: { type: "Property", value: { "@type": typed["@type"], "@value": moved(typed["@value"]) } } };
  }
  return undefined;
}

export type CalendarSpan = "month" | "week" | "day";

/** The days a calendar shows around `at` (`YYYY-MM-DD`): whole weeks from Monday for a month. */
export function daysOf(at: string, span: CalendarSpan): string[] {
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const anchor = new Date(`${at}T00:00:00Z`);
  if (span === "day") return [at];
  const monday = (date: Date) => {
    const copy = new Date(date);
    copy.setUTCDate(copy.getUTCDate() - ((copy.getUTCDay() + 6) % 7));
    return copy;
  };
  const start =
    span === "week"
      ? monday(anchor)
      : monday(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1)));
  const end =
    span === "week"
      ? new Date(start.getTime() + 6 * 86_400_000)
      : (() => {
          const last = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
          const sunday = new Date(last);
          sunday.setUTCDate(last.getUTCDate() + ((7 - last.getUTCDay()) % 7));
          return sunday;
        })();
  const days: string[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) days.push(day(new Date(t)));
  return days;
}

/** `at` moved by one span forward (`+1`) or back (`-1`). */
export function stepOf(at: string, span: CalendarSpan, by: 1 | -1): string {
  const date = new Date(`${at}T00:00:00Z`);
  if (span === "month") date.setUTCMonth(date.getUTCMonth() + by, 1);
  else date.setUTCDate(date.getUTCDate() + by * (span === "week" ? 7 : 1));
  return date.toISOString().slice(0, 10);
}

/**
 * A calendar (T-3102): each row on the day of a date attribute, or of when an attribute was
 * observed, by month, week or day. Dragging a row to another day, or choosing the day in the row's
 * own dialog, writes the attribute through the space surface; when it was observed is not editable.
 */
export function CalendarView({
  rows,
  source,
  today = new Date().toISOString().slice(0, 10),
  onDelete,
}: {
  rows: RichRow[];
  source: EntitySource;
  today?: string;
  onDelete?: (row: RichRow) => Promise<void>;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const keys = useMemo(() => dateKeys(rows), [rows]);
  const [chosen, setChosen] = useState("");
  const key = keys.includes(chosen) ? chosen : (keys[0] ?? "");
  const [span, setSpan] = useState<CalendarSpan>("month");
  const [at, setAt] = useState(today);
  const [open, setOpen] = useState<RichRow | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [newDay, setNewDay] = useState("");
  const moves = useMoves(
    (row) => dayOf(row, key),
    async (row, day) => {
      const patch = rescheduled(row, key, day);
      if (!patch) throw new Error(t("spaces.views.readOnly"));
      if (!source.patch) throw new Error(t("spaces.views.readOnly"));
      await source.patch(row.id, patch);
    },
  );

  if (keys.length === 0) {
    return <p className="text-body text-fg-muted">{t("spaces.views.noDate")}</p>;
  }
  const days = daysOf(at, span);
  const month = at.slice(0, 7);
  const onDay = (day: string) => rows.filter((row) => moves.valueOf(row) === day);
  const heading = new Intl.DateTimeFormat(i18n.language, {
    month: "long",
    year: "numeric",
    ...(span === "month" ? {} : { day: "numeric" }),
    timeZone: "UTC",
  }).format(new Date(`${at}T00:00:00Z`));
  const dayLabel = new Intl.DateTimeFormat(i18n.language, { weekday: "short", day: "numeric", timeZone: "UTC" });
  const editable = !key.endsWith(OBSERVED);

  const reschedule = moves.move;
  const refused = moves.refused
    ? t("spaces.views.rescheduleRefused", { name: primaryOf(moves.refused.row), reason: moves.refused.reason })
    : null;

  return (
    <div className="flex flex-col gap-3" data-testid="view-calendar" onKeyDown={undoKeys(moves)}>
      {editable ? <UndoBar moves={moves} /> : null}
      <div className="flex flex-wrap items-end gap-3">
        <Field id="calendar-key" label={t("spaces.views.dateBy")} className="w-fit">
          <Select id="calendar-key" value={key} onChange={(event) => setChosen(event.target.value)}>
            {keys.map((name) => (
              <option key={name} value={name}>
                {name.endsWith(OBSERVED)
                  ? t("spaces.views.observed", { attr: name.slice(0, -OBSERVED.length) })
                  : name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="calendar-span" label={t("spaces.views.span")} className="w-fit">
          <Select id="calendar-span" value={span} onChange={(event) => setSpan(event.target.value as CalendarSpan)}>
            {(["month", "week", "day"] as const).map((value) => (
              <option key={value} value={value}>
                {t(`spaces.views.spans.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="secondary" onClick={() => setAt(stepOf(at, span, -1))}>
            {t("spaces.views.previous")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setAt(today)}>
            {t("spaces.views.today")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setAt(stepOf(at, span, 1))}>
            {t("spaces.views.next")}
          </Button>
        </div>
      </div>
      <h3 className="text-body font-semibold text-fg" aria-live="polite">
        {heading}
      </h3>
      {refused ? (
        <Alert role="alert" tone="danger">
          {refused}
        </Alert>
      ) : null}
      <Truncated count={rows.length} />
      <ol
        className={
          span === "day"
            ? "flex flex-col gap-2"
            : "grid grid-cols-1 gap-1 sm:grid-cols-7"
        }
        aria-label={heading}
      >
        {days.map((day) => {
          const here = onDay(day);
          return (
            <li
              key={day}
              data-testid={`calendar-day-${day}`}
              className={`flex min-h-20 flex-col gap-1 rounded-md border border-border p-1 ${
                span === "month" && day.slice(0, 7) !== month ? "bg-surface-subtle text-fg-subtle" : "bg-surface"
              } ${day === today ? "ring-2 ring-primary" : ""}`}
              onDragOver={(event) => {
                if (dragging && editable) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const row = rows.find((candidate) => candidate.id === dragging);
                setDragging(null);
                if (row) void reschedule(row, day);
              }}
            >
              <span className="text-caption font-semibold">{dayLabel.format(new Date(`${day}T00:00:00Z`))}</span>
              {here.map((row) => (
                <Button
                  key={row.id}
                  size="sm"
                  variant="ghost"
                  draggable={editable}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/plain", row.id);
                    setDragging(row.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                  className="justify-start truncate px-1 text-left"
                  onClick={() => {
                    setNewDay(moves.valueOf(row) ?? "");
                    setOpen(row);
                  }}
                >
                  {primaryOf(row)}
                </Button>
              ))}
            </li>
          );
        })}
      </ol>
      {open ? (
        <RowDialog row={open} onClose={() => setOpen(null)} source={source} onDelete={onDelete}>
          {editable && rescheduled(open, key, dayOf(open, key) ?? "") ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void reschedule(open, newDay);
                setOpen(null);
              }}
            >
              <Field id="calendar-reschedule" label={t("spaces.views.reschedule", { attr: key })}>
                <Input id="calendar-reschedule" type="date" required value={newDay} onChange={(event) => setNewDay(event.target.value)} />
              </Field>
              <Button type="submit" size="sm">
                {t("spaces.views.rescheduleSave")}
              </Button>
            </form>
          ) : null}
        </RowDialog>
      ) : null}
    </div>
  );
}

/**
 * A timeline (T-3102): one bar per row from a start to an end date attribute, placed on the span
 * from the earliest start to the latest end, in start order; a row missing either date is left out
 * and counted.
 */
export function TimelineView({
  rows,
  source,
  onDelete,
}: {
  rows: RichRow[];
  source?: EntitySource;
  onDelete?: (row: RichRow) => Promise<void>;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const keys = useMemo(() => dateKeys(rows).filter((key) => !key.endsWith(OBSERVED)), [rows]);
  const [startKey, setStartKey] = useState("");
  const [endKey, setEndKey] = useState("");
  const [open, setOpen] = useState<RichRow | null>(null);
  const start = keys.includes(startKey) ? startKey : (keys[0] ?? "");
  const end = keys.includes(endKey) ? endKey : (keys[1] ?? keys[0] ?? "");
  if (keys.length === 0) {
    return <p className="text-body text-fg-muted">{t("spaces.views.noDate")}</p>;
  }
  const spans = rows
    .map((row) => ({ row, from: dayOf(row, start), to: dayOf(row, end) }))
    .filter((span): span is { row: RichRow; from: string; to: string } => !!span.from && !!span.to)
    .map((span) => (span.to < span.from ? { ...span, from: span.to, to: span.from } : span))
    .sort((a, b) => a.from.localeCompare(b.from));
  const left = rows.length - spans.length;
  const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
  const first = spans.length ? ms(spans[0].from) : 0;
  const last = spans.length ? Math.max(...spans.map((span) => ms(span.to))) + 86_400_000 : 1;
  const width = Math.max(last - first, 86_400_000);
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeZone: "UTC" });

  return (
    <div className="flex flex-col gap-3" data-testid="view-timeline">
      <div className="flex flex-wrap items-end gap-3">
        <Field id="timeline-start" label={t("spaces.views.start")} className="w-fit">
          <Select id="timeline-start" value={start} onChange={(event) => setStartKey(event.target.value)}>
            {keys.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="timeline-end" label={t("spaces.views.end")} className="w-fit">
          <Select id="timeline-end" value={end} onChange={(event) => setEndKey(event.target.value)}>
            {keys.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Truncated count={rows.length} />
      {left > 0 ? <p className="text-caption text-fg-muted">{t("spaces.views.undated", { count: left })}</p> : null}
      <ol className="flex flex-col gap-1">
        {spans.map(({ row, from, to }) => (
          <li key={row.id} className="grid grid-cols-1 items-center gap-1 sm:grid-cols-[12rem_1fr]">
            <Button
              size="sm"
              variant="ghost"
              className="justify-start truncate px-1 text-left"
              onClick={() => setOpen(row)}
            >
              {primaryOf(row)}
            </Button>
            <div className="relative h-6 rounded bg-surface-subtle">
              {/* The bar is drawn, not styled: its place is data, and the page takes no inline style (UI-01). */}
              <svg
                aria-hidden="true"
                viewBox="0 0 100 1"
                preserveAspectRatio="none"
                className="absolute inset-0 h-full w-full"
              >
                <rect
                  x={((ms(from) - first) / width) * 100}
                  width={Math.max(((ms(to) + 86_400_000 - ms(from)) / width) * 100, 1)}
                  height={1}
                  className="fill-primary/70"
                />
              </svg>
              <span className="relative px-1 text-caption text-fg">
                {date.format(new Date(ms(from)))} – {date.format(new Date(ms(to)))}
              </span>
            </div>
          </li>
        ))}
      </ol>
      <RowDialog row={open} onClose={() => setOpen(null)} source={source} onDelete={onDelete} />
    </div>
  );
}

/** The members a broker writes itself; a restore sends the entity without them. */
const SYSTEM = new Set(["createdAt", "modifiedAt", "deletedAt"]);

/** The entity as a create takes it again: the broker's own timestamps left out, at every level. */
export function writable(entity: Record<string, unknown>): Record<string, unknown> {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !SYSTEM.has(key))
          .map(([key, inner]) => [key, strip(inner)]),
      );
    }
    return value;
  };
  return strip(entity) as Record<string, unknown>;
}

/**
 * Deletes one row the way §31 orders it (T-3107): the person's copy kept first, then the delete
 * through the gateway with their session; a delete the gateway refuses forgets the copy again and
 * says the gateway's words.
 */
export async function deleteRow(project: string, space: string, source: EntitySource, row: RichRow): Promise<void> {
  if (!source.remove) throw new Error("this view cannot delete");
  const path = { project, space };
  const kept = await api.POST("/api/v1/projects/{project}/spaces/{space}/trash", {
    params: { path },
    // The schema calls `entity` an object of no known members: an NGSI-LD entity is any.
    body: { entity: writable(row.raw) as Record<string, never> },
  });
  if (!kept.data) {
    const detail = (kept.error as { detail?: unknown } | undefined)?.detail;
    throw new Error(typeof detail === "string" ? detail : `HTTP ${kept.response.status}`);
  }
  try {
    await source.remove(row.id);
  } catch (error) {
    await api.DELETE("/api/v1/projects/{project}/spaces/{space}/trash/{id}", {
      params: { path: { ...path, id: kept.data.id } },
    });
    throw error;
  }
}

/** The key the trash list of one space is cached under. */
export const trashKey = (project: string, space: string) => ["projects", project, "spaces", space, "trash"];

/**
 * What the person deleted from this space's views (T-3107, API/01 §31): their own copies for 30
 * days, each restored with their own create through the gateway, refused like any write.
 */
export function TrashPanel({
  project,
  space,
  restore,
}: {
  project: string;
  space: string;
  /** The create through the gateway: the entity back in the space under its URN. */
  restore: (entity: Record<string, unknown>) => Promise<void>;
}): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const items = useQuery({
    queryKey: trashKey(project, space),
    retry: false,
    queryFn: async () => {
      const answer: unknown = await unwrap(
        await api.GET("/api/v1/projects/{project}/spaces/{space}/trash", {
          params: { path: { project, space } },
        }),
      );
      // An answer of another shape is no list: the panel stays away rather than break the page.
      return Array.isArray(answer) ? (answer as components["schemas"]["TrashItem"][]) : [];
    },
  });
  if (!items.data || items.data.length === 0) return null;
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" });
  return (
    <details className="rounded-lg border border-border p-3" data-testid="view-trash">
      <summary className="cursor-pointer text-body font-semibold text-fg">
        {t("spaces.views.trash", { count: items.data.length })}
      </summary>
      <p className="mt-1 text-caption text-fg-muted">{t("spaces.views.trashLead")}</p>
      {refused ? (
        <Alert role="alert" tone="danger" className="mt-2">
          {refused}
        </Alert>
      ) : null}
      <ul className="mt-2 flex flex-col gap-2">
        {items.data.map((item) => {
          const name = cellText(toRichRow(item.entity as Record<string, unknown>, i18n.language).cells.name) || item.urn;
          return (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="font-semibold">{name}</span>{" "}
                <span className="text-caption text-fg-muted">
                  {t("spaces.views.deletedAt", { at: date.format(new Date(item.deletedAt)) })}
                </span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                disabledReason={t("app.loading")}
                aria-label={t("spaces.views.restoreOne", { name })}
                onClick={async () => {
                  setRefused(null);
                  setBusy(item.id);
                  try {
                    await restore(item.entity as Record<string, unknown>);
                    await api.DELETE("/api/v1/projects/{project}/spaces/{space}/trash/{id}", {
                      params: { path: { project, space, id: item.id } },
                    });
                    await queryClient.invalidateQueries({ queryKey: trashKey(project, space) });
                    await queryClient.invalidateQueries({ queryKey: ["space-view-rows", space] });
                  } catch (error) {
                    setRefused(
                      t("spaces.views.restoreRefused", {
                        name,
                        reason: error instanceof Error ? error.message : String(error),
                      }),
                    );
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {t("spaces.views.restore")}
              </Button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
