/**
 * The views of a space's entities beside the grid (ADR-N-042 §3.2; T-3100…T-3102): the same rows,
 * read through the same space surface with the person's session and narrowed by the same filter,
 * drawn as cards, as a board or on a calendar. Nothing is copied out of the space: each view is a
 * renderer over one page of the type, and a click opens the row whole.
 */
import { useMemo, useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { cellText } from "@joinedcontext/sdk";
import type { EntitySource, RichRow } from "@joinedcontext/sdk";
import { Alert, Button, Card, Checkbox, Dialog, ExternalLink, Field, Select } from "../../components/ui";
import { safeHref } from "../../components/ui/safeHref";

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
export function RowDialog({ row, onClose }: { row: RichRow | null; onClose: () => void }): JSX.Element | null {
  const { t } = useTranslation();
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
        {attrs.map((attr) => (
          <div key={attr} className="contents">
            <dt className="text-caption font-semibold text-fg-muted">{attr}</dt>
            <dd className="text-body text-fg [overflow-wrap:anywhere]">{cellText(row.cells[attr]) || "—"}</dd>
          </div>
        ))}
      </dl>
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
export function GalleryView({ rows }: { rows: RichRow[] }): JSX.Element {
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
      <RowDialog row={open} onClose={() => setOpen(null)} />
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
}: {
  rows: RichRow[];
  source: EntitySource;
  enums: Record<string, EnumChoice[]>;
}): JSX.Element {
  const { t } = useTranslation();
  const attrs = Object.keys(enums).sort();
  const [chosen, setChosen] = useState("");
  const attr = attrs.includes(chosen) ? chosen : (attrs[0] ?? "");
  const [moved, setMoved] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState<string | null>(null);
  const [open, setOpen] = useState<RichRow | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  if (attrs.length === 0) {
    return <p className="text-body text-fg-muted">{t("spaces.views.noEnum")}</p>;
  }
  const values = enums[attr];
  const columns = columnsOf(rows, attr, values, moved);
  const titleOf = (value: string) =>
    value === "" ? t("spaces.views.noValue") : (values.find((choice) => choice.value === value)?.title ?? value);

  const move = async (row: RichRow, to: string) => {
    const from = moved[row.id] ?? cellText(row.cells[attr]).trim();
    if (to === from || to === "") return;
    setRefused(null);
    setMoved((now) => ({ ...now, [row.id]: to }));
    try {
      if (!source.patch) throw new Error(t("spaces.views.readOnly"));
      await source.patch(row.id, { [attr]: { type: "Property", value: to } });
    } catch (error) {
      setMoved((now) => {
        const { [row.id]: _gone, ...rest } = now;
        void _gone;
        return rest;
      });
      setRefused(
        t("spaces.views.moveRefused", {
          name: primaryOf(row),
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="view-kanban">
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
      <RowDialog row={open} onClose={() => setOpen(null)} />
    </div>
  );
}
