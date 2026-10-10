import { Fragment, useId, useMemo, useRef, useState } from "react";
import type { JSX, PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "../../components/ui";
import { download, mermaidErDiagram, svgFile } from "./diagramExport";
import { layered } from "./diagramLayout";
import type { LayoutEdge, Point } from "./diagramLayout";
import { graphData, parseModel, withImports } from "./linkml";
import type { GraphEdge, GraphNode, GraphRow, Multiplicity } from "./linkml";

/**
 * One box's size, the gaps around it and the three text sizes, all in the SVG's own units.
 *
 * The text sizes belong here and not in a class: inside a `viewBox` a font size is user units
 * that the browser scales with the drawing, not pixels on the page, and `BOX.row` is the line
 * height the layout above counts with. A step of the page's type scale would be a different
 * drawing, so they are geometry — written once, beside the geometry that depends on them.
 */
const BOX = {
  width: 240,
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
  /** The PK/FK tag before a row's name, and the room it takes. */
  tag: 8,
  tagWidth: 18,
};
/**
 * Characters a row's name and its type may each take before they are cut with "…": half a box
 * at the slot size, so the two never run into each other. The whole row is in its tooltip.
 */
const CHARS = 17;
/** Pixels per drawing unit: natural size, and how far the buttons go each way. */
const ZOOM = { natural: 1, step: 1.25, min: 0.25, max: 4, fitMax: 2 };
/** One object for "no imports", so the drawing is not recomputed on every render. */
const NO_IMPORTS: Record<string, string> = {};

/**
 * The ends a line can have (T-3589), one standard notation: UML's hollow triangle at the parent
 * of `is_a` and of a mixin, ER crow's foot at both ends of a reference and a relationship (the
 * notation of LinkML's `gen-erdiagram`), an open arrow at the enum a field picks from.
 */
const CROW: Record<Multiplicity, string> = { "1": "one", "0..1": "zeroOrOne", "1..*": "oneOrMore", "*": "many" };
type End = "triangle" | "arrow" | (typeof CROW)[Multiplicity];

/** The `<marker>` of every end, drawn tip right at (20, 6); `auto-start-reverse` turns it round at a line's start. */
function Markers({ id }: { id: (end: End) => string }): JSX.Element {
  const marker = (end: End, children: JSX.Element, refX = 20) => (
    <marker
      id={id(end)}
      viewBox="0 0 20 12"
      refX={refX}
      refY="6"
      markerWidth="20"
      markerHeight="12"
      markerUnits="userSpaceOnUse"
      orient="auto-start-reverse"
    >
      {children}
    </marker>
  );
  const ring = (cx: number) => <circle cx={cx} cy={6} r={3.5} className="fill-surface" stroke="currentColor" />;
  return (
    <defs>
      {marker("arrow", <path d="M 11 1 L 20 6 L 11 11 z" fill="currentColor" />)}
      {marker("triangle", <path d="M 6 0 L 20 6 L 6 12 z" className="fill-surface" stroke="currentColor" />)}
      {marker("one", <path d="M 12 0 V 12 M 16 0 V 12" fill="none" stroke="currentColor" />)}
      {marker(
        "zeroOrOne",
        <g fill="none" stroke="currentColor">
          {ring(8)}
          <path d="M 16 0 V 12" />
        </g>,
      )}
      {marker("oneOrMore", <path d="M 8 0 V 12 M 12 6 L 20 0 M 12 6 L 20 12 M 12 6 L 20 6" fill="none" stroke="currentColor" />)}
      {marker(
        "many",
        <g fill="none" stroke="currentColor">
          {ring(6)}
          <path d="M 12 6 L 20 0 M 12 6 L 20 12 M 12 6 L 20 6" />
        </g>,
      )}
    </defs>
  );
}

/** The ends of a line of `edge`'s kind: the start's marker and the end's, as `url(#…)`. */
function ends(edge: GraphEdge, id: (end: End) => string): { start?: string; end?: string } {
  const url = (end: End) => `url(#${id(end)})`;
  if (edge.kind === "is_a" || edge.kind === "mixin") return { end: url("triangle") };
  if (edge.kind === "enum") return { end: url("arrow") };
  return { start: url(CROW[edge.fromMultiplicity ?? "*"]), end: url(CROW[edge.toMultiplicity ?? "*"]) };
}

interface Placed extends GraphNode {
  x: number;
  y: number;
  height: number;
}

/** How many lines a box draws below its title: every row of a class, every value of an enum. */
function lines(node: GraphNode): number {
  return node.rows?.length ?? node.slots.length;
}

/**
 * The edge the layout keeps short: a parent above the class that specialises or mixes it in,
 * a class above what its slots reference, an enum below the classes that pick from it.
 */
export function layoutEdge(edge: GraphEdge): LayoutEdge {
  const parent = edge.kind === "is_a" || edge.kind === "mixin";
  return { from: edge.from, to: edge.to, upper: parent ? edge.to : edge.from, lower: parent ? edge.from : edge.to };
}

/**
 * Where each box sits (T-3589): laid out by its lines, not in a grid. Each connected group of
 * classes is a layered drawing of its own, a class one layer from what it is joined to, and the
 * groups stand side by side. `bends` holds, per edge, where its line turns as it passes a layer.
 */
export function place(nodes: GraphNode[], edges: GraphEdge[]): { placed: Placed[]; bends: Point[][] } {
  const height = (node: GraphNode) => BOX.header + lines(node) * BOX.row + BOX.padding;
  const layout = layered(
    nodes.map((node) => ({ id: node.name, width: BOX.width, height: height(node) })),
    edges.map(layoutEdge),
    { gapX: BOX.gapX, gapY: BOX.gapY, groupGap: BOX.gapX * 2, maxWidth: 6 * (BOX.width + BOX.gapX) },
  );
  // In reading order, top to bottom and left to right: the order Tab walks the boxes in.
  const placed = nodes
    .map((node) => {
      const box = layout.boxes.get(node.name);
      return { ...node, x: box?.x ?? 0, y: box?.y ?? 0, height: height(node) };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
  return { placed, bends: layout.bends };
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

/**
 * The line between two boxes through its bends, cut where it leaves each box: the first and
 * last points are on the borders, aimed at the next bend (or the other box's centre).
 */
function route(from: Placed, to: Placed, bends: Point[] = []): Point[] {
  const centre = (box: Placed) => ({ x: box.x + BOX.width / 2, y: box.y + box.height / 2 });
  const start = border(from, bends[0] ?? centre(to));
  const end = border(to, bends[bends.length - 1] ?? centre(from));
  return [start, ...bends, end];
}

/** An SVG path through `points`. */
function pathOf(points: Point[]): string {
  return points.map((p, index) => `${index === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
}

/** The middle of a route, for its label: the middle of its middle piece. */
function middleOf(points: Point[]): Point {
  const at = Math.max(0, Math.floor((points.length - 1) / 2));
  const a = points[at];
  const b = points[Math.min(points.length - 1, at + 1)];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** A label a little way along the line from `start` towards `end`, and to its side. */
function near(start: Point, end: Point): Point {
  const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  const ux = (end.x - start.x) / length;
  const uy = (end.y - start.y) / length;
  return { x: start.x + ux * 16 - uy * 9, y: start.y + uy * 16 + ux * 9 + 3 };
}

/** `text` cut to `CHARS` characters, with "…" where it was cut. */
function cut(text: string): string {
  return text.length > CHARS ? `${text.slice(0, CHARS - 1)}…` : text;
}

/** What a row says its value is: a reference names its class and how many, a list says `[]`. */
function typeText(row: GraphRow): string {
  if (row.key === "fk") return `→ ${row.type} ${row.multiplicity ?? ""}`.trimEnd();
  return row.multivalued ? `${row.type}[]` : row.type;
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
  const drawing = useRef<SVGSVGElement>(null);
  // Ids of this drawing's markers: two drawings on one page must not share them.
  const prefix = useId();
  const markerId = (end: End) => `${prefix}-${end}`;
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const { name, nodes, edges } = useMemo(() => {
    const model = parseModel(source);
    const parsed = Object.fromEntries(Object.entries(imports).map(([key, text]) => [key, parseModel(text)]));
    return { name: model.name || "model", ...graphData(withImports(model, parsed)) };
  }, [source, imports]);
  const { placed, bends } = useMemo(() => place(nodes, edges), [nodes, edges]);
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
  const exportSvg = () => {
    if (drawing.current) download(svgFile(drawing.current), `${name}.svg`, "image/svg+xml");
  };
  const exportMermaid = () => download(mermaidErDiagram(nodes, edges), `${name}.mmd`, "text/plain");
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
      <Legend id={markerId} />
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
        <Button size="sm" variant="secondary" onClick={exportSvg}>
          {t("models.graph.exportSvg")}
        </Button>
        <Button size="sm" variant="secondary" onClick={exportMermaid}>
          {t("models.graph.exportMermaid")}
        </Button>
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
            ref={drawing}
            role="group"
            aria-label={t("models.graph.title")}
            viewBox={`-4 -4 ${width + 8} ${height + 8}`}
            width={(width + 8) * zoom}
            height={(height + 8) * zoom}
            className="min-h-48"
          >
            <Markers id={markerId} />

            {edges.map((edge, index) => {
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
                    bends={bends[index]}
                    markers={ends(edge, markerId)}
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
              const points = route(from, to, bends[index]);
              const first = points[0];
              const last = points[points.length - 1];
              const label = middleOf(points);
              return (
                <g key={`${edge.kind}-${edge.from}-${edge.to}-${edge.label ?? ""}`} className="text-fg-subtle">
                  <path
                    d={pathOf(points)}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1}
                    strokeDasharray={stroke(edge)}
                    markerStart={ends(edge, markerId).start}
                    markerEnd={ends(edge, markerId).end}
                  />
                  {edge.label ? (
                    <text
                      x={label.x}
                      y={label.y - 2}
                      textAnchor="middle"
                      fontSize={BOX.edge}
                      className="fill-current"
                    >
                      {edge.label}
                    </text>
                  ) : null}
                  {/* A reference says how many at both ends too (T-2881): its own slot's at the
                      target, and at the source `*`, since no inverse limits it. */}
                  {edge.toMultiplicity ? (
                    <>
                      <Multiplicity at={near(first, points[1])} value={edge.fromMultiplicity} />
                      <Multiplicity at={near(last, points[points.length - 2])} value={edge.toMultiplicity} />
                    </>
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
                  {node.rows
                    ? node.rows.map((row, index) => (
                        <SlotRow
                          key={row.name}
                          row={row}
                          x={node.x}
                          y={node.y + BOX.header + index * BOX.row + 4}
                          tip={t(`models.graph.row.${row.key ?? "plain"}`, {
                            name: row.name,
                            type: typeText(row),
                          })}
                        />
                      ))
                    : node.slots.map((slot, index) => (
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

/** How many, at one end of a line: bold, so it is read before the name in the middle. */
function Multiplicity({ at, value }: { at: Point; value?: string }): JSX.Element | null {
  return value ? (
    <text x={at.x} y={at.y} textAnchor="middle" fontSize={BOX.edge} className="fill-current font-semibold">
      {value}
    </text>
  ) : null;
}

/**
 * One row of a class's box (T-2881): a PK or FK tag, told apart by its word and its border (a
 * solid one for the key, a dashed one for a reference) and never by colour, the slot's name, and
 * its type at the right edge. The tooltip says the whole row when either half was cut.
 */
function SlotRow({ row, x, y, tip }: { row: GraphRow; x: number; y: number; tip: string }): JSX.Element {
  const nameAt = x + BOX.padding + BOX.tagWidth + 4;
  return (
    <g className={row.key ? "text-fg" : "text-fg-muted"}>
      <title>{tip}</title>
      {row.key ? (
        <>
          <rect
            x={x + BOX.padding}
            y={y - 9}
            width={BOX.tagWidth}
            height={11}
            rx={2}
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray={row.key === "fk" ? "2 1" : undefined}
          />
          <text
            x={x + BOX.padding + BOX.tagWidth / 2}
            y={y}
            textAnchor="middle"
            fontSize={BOX.tag}
            className="fill-current font-semibold"
          >
            {row.key === "pk" ? "PK" : "FK"}
          </text>
        </>
      ) : null}
      <text
        x={nameAt}
        y={y + 1}
        fontSize={BOX.slot}
        className={row.key === "pk" ? "fill-current font-semibold" : "fill-current"}
        fontStyle={row.implied ? "italic" : undefined}
      >
        {cut(row.name)}
      </text>
      <text x={x + BOX.width - BOX.padding} y={y + 1} textAnchor="end" fontSize={BOX.slot} className="fill-current">
        {cut(typeText(row))}
      </text>
    </g>
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
  bends,
  markers,
  label,
  onOpen,
}: {
  edge: GraphEdge;
  from: Placed;
  to: Placed;
  bends?: Point[];
  markers: { start?: string; end?: string };
  label: string;
  onOpen: () => void;
}): JSX.Element {
  const self = from.name === to.name;
  const top = { x: from.x + BOX.width, y: from.y + from.height * 0.3 };
  const bottom = { x: from.x + BOX.width, y: from.y + from.height * 0.7 };
  const points = self ? [top, bottom] : route(from, to, bends);
  const start = points[0];
  const end = points[points.length - 1];
  const path = self
    ? `M ${top.x} ${top.y} C ${top.x + BOX.loop} ${top.y - 20} ${bottom.x + BOX.loop} ${bottom.y + 20} ${bottom.x} ${bottom.y}`
    : pathOf(points);
  const atFrom = self ? { x: top.x + 10, y: top.y - 4 } : near(start, points[1]);
  const atTo = self ? { x: bottom.x + 10, y: bottom.y + 12 } : near(end, points[points.length - 2]);
  const centre = middleOf(points);
  const middle = self ? { x: top.x + BOX.loop * 0.75, y: (top.y + bottom.y) / 2 + 3 } : { x: centre.x, y: centre.y - 4 };
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
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} markerStart={markers.start} markerEnd={markers.end} />
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

/**
 * What each end of a line means, drawn with the drawing's own markers (T-3589): read before the
 * drawing, so the notation never has to be guessed.
 */
function Legend({ id }: { id: (end: End) => string }): JSX.Element {
  const { t } = useTranslation();
  const caption = useId();
  const sample = (end: End, dash?: string) => (
    <svg aria-hidden="true" width={64} height={14} viewBox="0 0 64 14" className="shrink-0 text-fg">
      <line x1={2} y1={7} x2={42} y2={7} stroke="currentColor" strokeDasharray={dash} markerEnd={`url(#${id(end)})`} />
    </svg>
  );
  const entries: [JSX.Element, string][] = [
    [sample("triangle"), t("models.graph.notation.isA")],
    [sample("triangle", "6 4"), t("models.graph.notation.mixin")],
    [sample("one"), t("models.graph.notation.one")],
    [sample("zeroOrOne"), t("models.graph.notation.zeroOrOne")],
    [sample("oneOrMore"), t("models.graph.notation.oneOrMore")],
    [sample("many"), t("models.graph.notation.many")],
    [sample("arrow", "1 4"), t("models.graph.notation.enum")],
  ];
  return (
    <figure aria-labelledby={caption} className="flex flex-col gap-1">
      <figcaption id={caption} className="text-caption font-semibold text-fg">{t("models.graph.notation.title")}</figcaption>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {entries.map(([drawing, text]) => (
          <li key={text} className="flex items-center gap-2 text-caption text-fg-muted">
            {drawing}
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
