import { Fragment, useMemo, useRef, useState } from "react";
import type { JSX, PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "../../components/ui";
import { graphData, parseModel, withImports } from "./linkml";
import type { GraphEdge, GraphNode } from "./linkml";

/**
 * One box's size, the gaps around it and the three text sizes, all in the SVG's own units.
 *
 * The text sizes belong here and not in a class: inside a `viewBox` a font size is user units
 * that the browser scales with the drawing, not pixels on the page, and `BOX.row` is the line
 * height the layout above counts with. A step of the page's type scale would be a different
 * drawing, so they are geometry — written once, beside the geometry that depends on them.
 */
const BOX = {
  width: 200,
  header: 26,
  row: 16,
  padding: 8,
  gapX: 110,
  gapY: 70,
  /** Room on the right of a box for a relationship of a class with itself. */
  loop: 60,
  title: 11,
  slot: 10,
  edge: 9,
};
/** Past this many slots a box says "and n more" rather than growing down the page. */
const SLOTS_SHOWN = 6;
/** Pixels per drawing unit: natural size, and how far the buttons go each way. */
const ZOOM = { natural: 1, step: 1.25, min: 0.25, max: 4, fitMax: 2 };
/** One object for "no imports", so the drawing is not recomputed on every render. */
const NO_IMPORTS: Record<string, string> = {};

interface Placed extends GraphNode {
  x: number;
  y: number;
  height: number;
}

/**
 * Where each box sits: a band per `is_a` depth, parents above children, and within a band a
 * grid about as wide as it is tall, in the model's own order.
 *
 * No layout library. A class graph is a forest of short chains joined by a few relationships:
 * a square grid keeps most relationship lines between neighbours instead of across a row of
 * boxes, and a dependency would be one more thing to pin, audit and ship for a dozen rectangles.
 */
export function place(nodes: GraphNode[]): Placed[] {
  const bands = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    bands.set(node.depth, [...(bands.get(node.depth) ?? []), node]);
  }
  const rowHeight = BOX.header + (SLOTS_SHOWN + 1) * BOX.row + BOX.padding + BOX.gapY;
  const placed: Placed[] = [];
  let top = 0;
  for (const [, band] of [...bands.entries()].sort(([a], [b]) => a - b)) {
    const columns = band.length <= 3 ? band.length : Math.ceil(Math.sqrt(band.length));
    band.forEach((node, index) => {
      const shown = Math.min(node.slots.length, SLOTS_SHOWN);
      const extra = node.slots.length > SLOTS_SHOWN ? 1 : 0;
      placed.push({
        ...node,
        x: (index % columns) * (BOX.width + BOX.gapX),
        y: top + Math.floor(index / columns) * rowHeight,
        height: BOX.header + (shown + extra) * BOX.row + BOX.padding,
      });
    });
    top += Math.ceil(band.length / columns) * rowHeight;
  }
  return placed;
}

interface Point {
  x: number;
  y: number;
}

/** Where the line from a box's centre towards `towards` leaves the box. */
function border(box: Placed, towards: Point): Point {
  const centre = { x: box.x + BOX.width / 2, y: box.y + box.height / 2 };
  const dx = towards.x - centre.x;
  const dy = towards.y - centre.y;
  if (dx === 0 && dy === 0) return centre;
  const scale = Math.min(
    dx === 0 ? Infinity : BOX.width / 2 / Math.abs(dx),
    dy === 0 ? Infinity : box.height / 2 / Math.abs(dy),
  );
  return { x: centre.x + dx * scale, y: centre.y + dy * scale };
}

/** The line between two boxes, centre to centre, cut where it leaves each box. */
function line(from: Placed, to: Placed): { x1: number; y1: number; x2: number; y2: number } {
  const a = border(from, { x: to.x + BOX.width / 2, y: to.y + to.height / 2 });
  const b = border(to, { x: from.x + BOX.width / 2, y: from.y + from.height / 2 });
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

/** A label a little way along the line from `start` towards `end`, and to its side. */
function near(start: Point, end: Point): Point {
  const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  const ux = (end.x - start.x) / length;
  const uy = (end.y - start.y) / length;
  return { x: start.x + ux * 16 - uy * 9, y: start.y + uy * 16 + ux * 9 + 3 };
}

/**
 * The model as a picture (DM-13, T-1111): every class a box with its own slots, and a line for
 * every way one class names another.
 *
 * Read-only, and deliberately so: a graph that also edited would be a third writer of the same
 * document beside the tree and the YAML, and the two that exist already share one string.
 * Clicking a class hands it to the caller, which opens it in the structure view.
 */
export function LinkmlGraphView({
  source,
  imports = NO_IMPORTS,
  onOpenClass,
  onOpenRelationship,
  onAddRelationship,
}: {
  source: string;
  /** The sources of the models this one imports, by import name: their classes are drawn too. */
  imports?: Record<string, string>;
  onOpenClass?: (name: string) => void;
  /** A relationship's line was pressed: the class it starts from, whose table lists it. */
  onOpenRelationship?: (from: string) => void;
  /** The one edit the drawing offers: the Add relationship form, on a class of this model. */
  onAddRelationship?: (from: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [zoom, setZoom] = useState(ZOOM.natural);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const { nodes, edges } = useMemo(
    () =>
      graphData(
        withImports(
          parseModel(source),
          Object.fromEntries(Object.entries(imports).map(([name, text]) => [name, parseModel(text)])),
        ),
      ),
    [source, imports],
  );
  const placed = useMemo(() => place(nodes), [nodes]);
  const at = useMemo(() => new Map(placed.map((node) => [node.name, node])), [placed]);

  if (!placed.some((node) => node.kind === "class")) {
    return (
      <p role="status" className="text-body text-fg-muted">
        {t("models.graph.empty")}
      </p>
    );
  }

  const width = Math.max(...placed.map((node) => node.x + BOX.width)) + BOX.loop;
  const height = Math.max(...placed.map((node) => node.y + node.height)) + BOX.padding;
  const stroke = (edge: GraphEdge) =>
    edge.kind === "mixin" ? "6 4" : edge.kind === "range" ? "2 3" : edge.kind === "enum" ? "1 4" : undefined;
  const pairs = edges.filter((edge) => edge.kind === "relationship");
  const local = new Set(placed.filter((node) => node.kind === "class" && !node.from).map((node) => node.name));

  const zoomTo = (next: number) => setZoom(Math.min(ZOOM.max, Math.max(ZOOM.min, next)));
  // Fit: the whole drawing in the frame's width, never blown up past twice its size.
  const fit = () => {
    const available = (frame.current?.clientWidth ?? 0) - 16;
    setZoom(available > 0 ? Math.min(ZOOM.fitMax, available / (width + 8)) : ZOOM.natural);
    frame.current?.scrollTo?.({ left: 0, top: 0 });
  };
  // Pan by dragging the background; a press on a box or a line is still a click.
  const grab = (event: PointerEvent<HTMLDivElement>) => {
    const at = frame.current;
    if (at) drag.current = { x: event.clientX, y: event.clientY, left: at.scrollLeft, top: at.scrollTop };
  };
  const pan = (event: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    const at = frame.current;
    if (!from || !at || event.buttons === 0) return;
    at.scrollLeft = from.left - (event.clientX - from.x);
    at.scrollTop = from.top - (event.clientY - from.y);
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-caption text-fg-muted">{t("models.graph.legend")}</p>
      {pairs.length > 0 ? <p className="text-caption text-fg-muted">{t("models.graph.legendRelationship")}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => zoomTo(zoom / ZOOM.step)} disabled={zoom <= ZOOM.min}>
          {t("models.graph.zoomOut")}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => zoomTo(zoom * ZOOM.step)} disabled={zoom >= ZOOM.max}>
          {t("models.graph.zoomIn")}
        </Button>
        <Button size="sm" variant="secondary" onClick={fit}>
          {t("models.graph.fit")}
        </Button>
        <span className="text-caption text-fg-muted" aria-live="polite">
          {t("models.graph.zoomLevel", { percent: Math.round(zoom * 100) })}
        </span>
      </div>
      <div className="grid gap-3 2xl:grid-cols-[minmax(0,1fr)_28rem]">
        <div
          ref={frame}
          className="cursor-grab overflow-auto rounded border border-border bg-surface p-2 active:cursor-grabbing"
          onPointerDown={grab}
          onPointerMove={pan}
          onPointerUp={() => (drag.current = null)}
          onPointerLeave={() => (drag.current = null)}
        >
          {/* `group`, not `img`: an image's contents are presentational, so the class boxes —
              which are focusable buttons — were reachable by Tab and invisible to the screen
              reader that had just been told this was one picture. */}
          <svg
            role="group"
            aria-label={t("models.graph.title")}
            viewBox={`-4 -4 ${width + 8} ${height + 8}`}
            width={(width + 8) * zoom}
            height={(height + 8) * zoom}
            className="min-h-48"
          >
            <defs>
              <marker
                id="linkml-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 9 5 L 0 9 z" fill="currentColor" />
              </marker>
            </defs>

            {edges.map((edge) => {
              const from = at.get(edge.from);
              const to = at.get(edge.to);
              if (!from || !to) {
                return null;
              }
              if (edge.kind === "relationship") {
                return (
                  <RelationshipLine
                    key={`relationship-${edge.from}-${edge.label ?? ""}`}
                    edge={edge}
                    from={from}
                    to={to}
                    label={t("models.graph.openRelationship", {
                      name: edge.label ?? "",
                      inverse: edge.inverse ?? "",
                      source: edge.from,
                      target: edge.to,
                    })}
                    onOpen={() => onOpenRelationship?.(edge.from)}
                  />
                );
              }
              const { x1, y1, x2, y2 } = line(from, to);
              return (
                <g key={`${edge.kind}-${edge.from}-${edge.to}-${edge.label ?? ""}`} className="text-fg-subtle">
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke="currentColor"
                    strokeWidth={1}
                    strokeDasharray={stroke(edge)}
                    markerEnd="url(#linkml-arrow)"
                  />
                  {edge.label ? (
                    <text
                      x={(x1 + x2) / 2}
                      y={(y1 + y2) / 2 - 2}
                      textAnchor="middle"
                      fontSize={BOX.edge}
                      className="fill-current"
                    >
                      {edge.label}
                    </text>
                  ) : null}
                </g>
              );
            })}

            {placed.map((node) => {
              const box = (
                <>
                  <rect
                    x={node.x}
                    y={node.y}
                    width={BOX.width}
                    height={node.height}
                    rx={node.kind === "enum" ? 2 : 6}
                    className={node.kind === "enum" ? "fill-surface stroke-border" : "fill-surface-subtle stroke-border"}
                    strokeWidth={1}
                    strokeDasharray={node.from || node.kind === "enum" ? "4 3" : undefined}
                  />
                  <text
                    x={node.x + BOX.padding}
                    y={node.y + 17}
                    fontSize={BOX.title}
                    className="fill-current font-semibold"
                  >
                    {node.kind === "enum" ? `«enum» ${node.name}` : node.name}
                  </text>
                  {node.from ? (
                    <text
                      x={node.x + BOX.width - BOX.padding}
                      y={node.y + 17}
                      fontSize={BOX.edge}
                      textAnchor="end"
                      className="fill-current text-fg-muted"
                    >
                      {t("models.graph.from", { name: node.from })}
                    </text>
                  ) : null}
                  {node.slots.slice(0, SLOTS_SHOWN).map((slot, index) => (
                    <text
                      key={slot}
                      x={node.x + BOX.padding}
                      y={node.y + BOX.header + index * BOX.row + 4}
                      fontSize={BOX.slot}
                      className="fill-current text-fg-muted"
                    >
                      {slot}
                    </text>
                  ))}
                  {node.slots.length > SLOTS_SHOWN ? (
                    <text
                      x={node.x + BOX.padding}
                      y={node.y + BOX.header + SLOTS_SHOWN * BOX.row + 4}
                      fontSize={BOX.slot}
                      className="fill-current text-fg-muted"
                    >
                      {t("models.graph.more", { count: node.slots.length - SLOTS_SHOWN })}
                    </text>
                  ) : null}
                </>
              );
              // The drawing's one edit, on a class of this model: its inverse is written here too.
              const add =
                onAddRelationship && node.kind === "class" && local.has(node.name) ? (
                  <g
                    key={`add-${node.name}`}
                    role="button"
                    tabIndex={0}
                    aria-label={t("models.graph.addRelationship", { name: node.name })}
                    className="focus-ring cursor-pointer"
                    onClick={() => onAddRelationship(node.name)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onAddRelationship(node.name);
                      }
                    }}
                  >
                    <rect
                      x={node.x + BOX.width - 22}
                      y={node.y + node.height - 20}
                      width={16}
                      height={16}
                      rx={3}
                      className="fill-surface stroke-border"
                      strokeWidth={1}
                    />
                    <text
                      x={node.x + BOX.width - 14}
                      y={node.y + node.height - 8}
                      fontSize={BOX.title}
                      textAnchor="middle"
                      className="fill-current"
                    >
                      +
                    </text>
                  </g>
                ) : null;
              // An enum opens nothing, so it is not a button: a stop in the tab order that does
              // nothing when pressed is worse than none. It says what it is to a screen reader.
              return node.kind === "enum" ? (
                <g
                  key={`enum-${node.name}`}
                  role="img"
                  aria-label={t("models.graph.enumBox", { name: node.name, values: node.slots.join(", ") })}
                >
                  {box}
                </g>
              ) : (
                <Fragment key={node.name}>
                  <g
                    role="button"
                    tabIndex={0}
                    aria-label={t("models.graph.openClass", { name: node.name })}
                    // `focus-ring`, never a bare `outline-none`: the box is in the tab order, so
                    // taking its outline away left a keyboard with nothing to follow (UI-15).
                    className="focus-ring cursor-pointer"
                    onClick={() => onOpenClass?.(node.name)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpenClass?.(node.name);
                      }
                    }}
                  >
                    {box}
                  </g>
                  {add}
                </Fragment>
              );
            })}
          </svg>
        </div>
        {pairs.length > 0 ? (
          <Table caption={t("models.graph.table")}>
            <TableHead>
              <TableHeaderCell>{t("models.graph.tableRelationship")}</TableHeaderCell>
              <TableHeaderCell>{t("models.graph.tableField")}</TableHeaderCell>
              <TableHeaderCell>{t("models.graph.tableInverse")}</TableHeaderCell>
              <TableHeaderCell>{t("models.graph.tableMultiplicity")}</TableHeaderCell>
            </TableHead>
            <TableBody>
              {pairs.map((edge) => (
                <TableRow key={`${edge.from}.${edge.label ?? ""}`}>
                  <TableCell primary>
                    {t(`models.relationships.sentence.${edge.cardinality ?? "one-to-one"}`, { source: edge.from, target: edge.to })}
                  </TableCell>
                  <TableCell>{`${edge.from}.${edge.label ?? ""}`}</TableCell>
                  <TableCell>{`${edge.to}.${edge.inverse ?? ""}`}</TableCell>
                  <TableCell>{`${edge.from} ${edge.fromMultiplicity ?? ""} — ${edge.toMultiplicity ?? ""} ${edge.to}`}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A relationship as one line (DM-64): the slot and its inverse in the middle, and at each end how
 * many entities of that class one entity at the other end is joined to. A class related to
 * itself is a loop on its right side.
 */
function RelationshipLine({
  edge,
  from,
  to,
  label,
  onOpen,
}: {
  edge: GraphEdge;
  from: Placed;
  to: Placed;
  label: string;
  onOpen: () => void;
}): JSX.Element {
  const self = from.name === to.name;
  const top = { x: from.x + BOX.width, y: from.y + from.height * 0.3 };
  const bottom = { x: from.x + BOX.width, y: from.y + from.height * 0.7 };
  const { x1, y1, x2, y2 } = self ? { x1: top.x, y1: top.y, x2: bottom.x, y2: bottom.y } : line(from, to);
  const path = self
    ? `M ${x1} ${y1} C ${x1 + BOX.loop} ${y1 - 20} ${x2 + BOX.loop} ${y2 + 20} ${x2} ${y2}`
    : `M ${x1} ${y1} L ${x2} ${y2}`;
  const start = { x: x1, y: y1 };
  const end = { x: x2, y: y2 };
  const atFrom = self ? { x: x1 + 10, y: y1 - 4 } : near(start, end);
  const atTo = self ? { x: x2 + 10, y: y2 + 12 } : near(end, start);
  const middle = self ? { x: x1 + BOX.loop * 0.75, y: (y1 + y2) / 2 + 3 } : { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 4 };
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={label}
      className="focus-ring cursor-pointer text-fg"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      {/* A wide transparent stroke under the line, so it can be hit with a pointer. */}
      <path d={path} fill="none" stroke="transparent" strokeWidth={12} />
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} />
      <text x={middle.x} y={middle.y} textAnchor="middle" fontSize={BOX.edge} className="fill-current">
        {`${edge.label ?? ""} / ${edge.inverse ?? ""}`}
      </text>
      <text x={atFrom.x} y={atFrom.y} textAnchor="middle" fontSize={BOX.edge} className="fill-current font-semibold">
        {edge.fromMultiplicity}
      </text>
      <text x={atTo.x} y={atTo.y} textAnchor="middle" fontSize={BOX.edge} className="fill-current font-semibold">
        {edge.toMultiplicity}
      </text>
    </g>
  );
}
