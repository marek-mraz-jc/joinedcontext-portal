import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { clsx } from "clsx";
import { Skeleton } from "./Skeleton";

export interface TableProps extends HTMLAttributes<HTMLTableElement> {
  /** Read by a screen reader as the table's name; visually hidden. */
  caption: string;
  /** Every second row tinted; on by default. */
  zebra?: boolean;
  /** Announced to a screen reader while the rows are a skeleton: "Loading endpoints". */
  status?: string;
  /**
   * A Tailwind max-height class (`max-h-64`) for a table whose length is the caller's data: the
   * frame then scrolls vertically as well, so a long list scrolls in place instead of growing
   * the page. The frame is one focusable, named stop either way (WCAG 2.1.1).
   */
  maxHeight?: string;
}

/**
 * A data table inside a scrolling frame: the frame scrolls on a phone while the page stays
 * put, the header stays legible, and the caption names it for a screen reader (UI-01).
 */
export function Table({
  caption,
  zebra = true,
  status,
  maxHeight,
  className,
  children,
  ...rest
}: TableProps): React.JSX.Element {
  return (
    // The frame scrolls sideways, so it is focusable and a keyboard scrolls it with the arrow
    // keys (WCAG 2.1.1): `overflow-x-auto` alone left the columns past the right edge reachable
    // with a pointer and by nothing else. It is named after the caption, or it would be an
    // unlabelled stop in the tab order.
    //
    // `group`, not `region`: a region is a landmark, and most tables here sit inside a
    // `<section aria-labelledby>` whose name is the caption — two nested landmarks with one
    // name, which is the `landmark-unique` violation and an ambiguous query for every test that
    // asks for that section by name. A group names the tab stop and adds no landmark.
    <div
      role="group"
      aria-label={caption}
      tabIndex={0}
      className={clsx(
        "focus-ring overflow-x-auto rounded-lg border border-border bg-surface shadow-1",
        maxHeight && ["overflow-y-auto", maxHeight],
      )}
    >
      {status ? (
        <p role="status" className="sr-only">
          {status}
        </p>
      ) : null}
      <table
        aria-busy={status ? true : undefined}
        className={clsx(
          "w-full border-collapse text-left text-body",
          // `:not(:hover)` keeps the stripe off the row under the pointer. Without it the zebra
          // rule — two selectors deep, so more specific than the row's own `hover:` — won an
          // even row's background outright and hovering half the table did nothing.
          zebra && "[&>tbody>tr:nth-child(even):not(:hover)]:bg-surface-subtle/70",
          className,
        )}
        {...rest}
      >
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export function TableHead({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element {
  return (
    <thead className={clsx("bg-surface-subtle", className)} {...rest}>
      <tr className="border-b border-border">{children}</tr>
    </thead>
  );
}

export function TableBody({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element {
  return (
    <tbody className={clsx("divide-y divide-border", className)} {...rest}>
      {children}
    </tbody>
  );
}

export function TableRow({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableRowElement>): React.JSX.Element {
  return (
    <tr className={clsx("transition-colors hover:bg-primary-50", className)} {...rest}>
      {children}
    </tr>
  );
}

export interface TableHeaderCellProps extends ThHTMLAttributes<HTMLTableCellElement> {
  align?: "left" | "right" | "center";
  /** A column a phone does without: hidden below `sm`, there from `sm` up (UI-27). */
  secondary?: boolean;
}

export function TableHeaderCell({
  align = "left",
  secondary,
  className,
  children,
  ...rest
}: TableHeaderCellProps): React.JSX.Element {
  return (
    <th
      scope="col"
      className={clsx(
        // No `whitespace-nowrap`: a translated header is the longest text in its column
        // ("Zuletzt geändert von" against "Changed by") and holding it on one line pushed the
        // last column off the screen instead of letting the header wrap to two lines.
        "px-4 py-2.5 text-caption font-semibold uppercase tracking-wide text-fg-muted",
        align === "right" && "text-right",
        align === "center" && "text-center",
        secondary && "hidden sm:table-cell",
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  align?: "left" | "right" | "center";
  /** The cell's content is the row's name: bolder, and first to be read. */
  primary?: boolean;
  /**
   * A cell of a column a phone does without (UI-27). Hidden below `sm` — with the same
   * `secondary` on its header cell — so a row at 400 px is the name, the state and what one
   * can do with it, instead of five columns of which two are cut off the screen.
   */
  secondary?: boolean;
}

export function TableCell({
  align = "left",
  primary,
  secondary,
  className,
  children,
  ...rest
}: TableCellProps): React.JSX.Element {
  return (
    <td
      className={clsx(
        "px-4 py-3 align-top text-fg",
        primary && "font-medium",
        align === "right" && "text-right",
        align === "center" && "text-center",
        secondary && "hidden sm:table-cell",
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

/**
 * The cell that names its own row (`<th scope="row">`), for a table whose first column is the
 * subject and not a value: a permissions matrix, a sample of entities, a field-by-field diff.
 * Without it a page that needed one styled a `<th>` by hand and drifted from every other cell
 * — the padding, the alignment and the `secondary` behaviour are the `TableCell` ones, because
 * it is a cell that happens to be a header, not a column header in the wrong place.
 */
export function TableRowHeaderCell({
  align = "left",
  secondary,
  className,
  children,
  ...rest
}: TableCellProps & ThHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  return (
    <th
      scope="row"
      className={clsx(
        "px-4 py-3 text-left align-top font-medium text-fg",
        align === "right" && "text-right",
        align === "center" && "text-center",
        secondary && "hidden sm:table-cell",
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

/** The one row of an empty table: the message, and whatever action fills it. */
export function TableEmpty({
  columns,
  children,
}: {
  columns: number;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <tr>
      <td colSpan={columns} className="px-4 py-12 text-center text-body text-fg-muted">
        {children}
      </td>
    </tr>
  );
}

/** Rows of grey bars while the list is on its way; the Table's `status` announces the wait. */
export function TableSkeleton({
  columns,
  rows = 4,
}: {
  columns: number;
  rows?: number;
}): React.JSX.Element {
  return (
    <tbody aria-hidden="true" className="divide-y divide-border">
      {Array.from({ length: rows }, (_, row) => (
        <tr key={row}>
          {Array.from({ length: columns }, (_, col) => (
            <td key={col} className="px-4 py-3.5">
              <Skeleton className={col === 0 ? "h-4 w-40" : "h-4 w-24"} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}
