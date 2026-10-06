import React, { useEffect, useId, useRef } from "react";
import type { RichRow } from "./model";
import type { VisibleColumn } from "./useEntityGrid";

export interface RowDetailLabels {
  /** The panel's own name, before the row's: "Details". */
  rowDetail: string;
  close: string;
}

export interface RowDetailProps {
  row: RichRow;
  /** What the row is called: its primary field, else its name, else its id. */
  name: string;
  /** The grid's columns: their attributes come first, in the grid's order and with its labels. */
  columns: VisibleColumn[];
  /** How one attribute's value is drawn, the grid's own cell renderer, editors included. */
  renderValue: (row: RichRow, column: VisibleColumn) => React.ReactNode;
  labels: RowDetailLabels;
  onClose: () => void;
  /** What the host adds under the attributes, such as the row's comments. */
  children?: React.ReactNode;
}

/**
 * One row whole (T-3097): every attribute the entity carries, the grid's columns first and then the
 * rest, each drawn by the grid's own cell renderer, so an editable attribute is edited here exactly
 * as in its cell and joins the same pending list. Named by the row's name, never only its id; the
 * heading takes focus when it opens and Escape closes it.
 */
export function RowDetail({ row, name, columns, renderValue, labels, onClose, children }: RowDetailProps): React.JSX.Element {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [row.id]);

  // Unpinned copies: in the panel the primary attribute is a value or an editor like the rest, not
  // the button that opened the panel.
  const shown = columns
    .filter((column) => column.attr !== null && column.meta === null)
    .map((column) => ({ ...column, pinned: false }));
  const named = new Set(shown.map((column) => column.attr));
  const rest: VisibleColumn[] = Object.keys(row.cells)
    .filter((attr) => !named.has(attr))
    .sort()
    .map((attr) => ({ key: attr, attr, meta: null, label: attr, pinned: false }));

  return (
    <aside
      className="jc-grid-detail"
      aria-labelledby={headingId}
      onKeyDown={(e) => {
        const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((e.target as HTMLElement).tagName);
        if (e.key === "Escape" && !typing) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="jc-grid-detail-head">
        <h3 id={headingId} ref={heading} tabIndex={-1}>
          {`${labels.rowDetail}: ${name}`}
        </h3>
        <button type="button" onClick={onClose}>
          {labels.close}
        </button>
      </div>
      {name !== row.id ? <p className="jc-grid-detail-id">{row.id}</p> : null}
      <dl className="jc-grid-detail-list">
        {[...shown, ...rest].map((column) => (
          <div key={column.key} className="jc-grid-detail-item">
            <dt>{column.label}</dt>
            <dd>{renderValue(row, column)}</dd>
          </div>
        ))}
      </dl>
      {children}
    </aside>
  );
}
