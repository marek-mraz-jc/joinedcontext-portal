import React, { useEffect, useId, useRef, useState } from "react";
import type { RichRow } from "./model";
import type { VisibleColumn } from "./useEntityGrid";

export interface RowDetailLabels {
  /** The dialog's own name, before the row's: "Details". */
  rowDetail: string;
  close: string;
  /** The tab with the row's values: "Fields". */
  rowFields: string;
  /** The tab with one attribute's history at a time: "History", and its attribute picker. */
  rowHistory: string;
  historyAttr: string;
}

/** A tab the host adds after Fields and History, such as the row's comments (T-4828). */
export interface RowDetailTab {
  id: string;
  label: string;
  content: React.ReactNode;
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
  /** One attribute's history, where the source reads history and the config allows it. */
  history?: (attr: string, label: string) => React.ReactNode;
  /** The host's own tabs after Fields and History. */
  tabs?: RowDetailTab[];
  /** What the host adds under the attributes, in the Fields tab. */
  children?: React.ReactNode;
}

/**
 * One row whole, as a modal dialog (T-3097, T-4828): every attribute the entity carries in the
 * Fields tab, the grid's columns first and then the rest, each drawn by the grid's own cell
 * renderer, so an editable attribute is edited here exactly as in its cell and joins the same
 * pending list; History reads one attribute's temporal values; the host adds its own tabs. The
 * browser's modal dialog keeps focus inside and the page behind inert; the heading takes focus when
 * it opens and Escape outside a text box closes it.
 */
export function RowDetail({ row, name, columns, renderValue, labels, onClose, history, tabs = [], children }: RowDetailProps): React.JSX.Element {
  const headingId = useId();
  const tabsId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState("fields");
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [row.id]);

  // Unpinned copies: in the dialog the primary attribute is a value or an editor like the rest, not
  // the button that opened it.
  // The id is the line under the heading; a model's `id` slot is not a field to read twice.
  const shown = columns
    .filter((column) => column.attr !== null && column.attr !== "id" && column.meta === null)
    .map((column) => ({ ...column, pinned: false }));
  const named = new Set(shown.map((column) => column.attr));
  const rest: VisibleColumn[] = Object.keys(row.cells)
    .filter((attr) => !named.has(attr))
    .sort()
    .map((attr) => ({ key: attr, attr, meta: null, label: attr, pinned: false }));
  const all = [...shown, ...rest];

  const [attr, setAttr] = useState<string>(all[0]?.attr ?? "");
  const historyTab = history && all.length > 0 ? [{ id: "history", label: labels.rowHistory }] : [];
  const list = [{ id: "fields", label: labels.rowFields }, ...historyTab, ...tabs.map(({ id, label }) => ({ id, label }))];
  const current = list.some((one) => one.id === tab) ? tab : "fields";
  const tabId = (id: string) => `${tabsId}-tab-${id}`;
  const panelId = (id: string) => `${tabsId}-panel-${id}`;
  // Arrow keys move between tabs, Home and End to the ends (WAI-ARIA tabs, automatic activation).
  const onTabKey = (e: React.KeyboardEvent, index: number) => {
    const to = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: list.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = list[(to + list.length) % list.length];
    setTab(next.id);
    document.getElementById(tabId(next.id))?.focus();
  };
  const label = all.find((column) => column.attr === attr)?.label ?? attr;

  return (
    <dialog
      ref={dialog}
      className="jc-grid-detail"
      aria-labelledby={headingId}
      // The browser's Escape would close the dialog from inside a cell editor too, where Escape
      // puts the value back: the dialog closes on Escape only outside a text box.
      onCancel={(e) => e.preventDefault()}
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
      <div role="tablist" aria-labelledby={headingId} className="jc-grid-detail-tabs">
        {list.map((one, index) => (
          <button
            key={one.id}
            id={tabId(one.id)}
            type="button"
            role="tab"
            aria-selected={current === one.id}
            aria-controls={panelId(one.id)}
            tabIndex={current === one.id ? 0 : -1}
            onClick={() => setTab(one.id)}
            onKeyDown={(e) => onTabKey(e, index)}
          >
            {one.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={panelId(current)} aria-labelledby={tabId(current)} className="jc-grid-detail-panel">
        {current === "fields" ? (
          <>
            <dl className="jc-grid-detail-list">
              {all.map((column) => (
                <div key={column.key} className="jc-grid-detail-item">
                  <dt>{column.label}</dt>
                  <dd>{renderValue(row, column)}</dd>
                </div>
              ))}
            </dl>
            {children}
          </>
        ) : null}
        {current === "history" && history ? (
          <>
            <label className="jc-grid-detail-attr">
              {labels.historyAttr}
              <select value={attr} onChange={(e) => setAttr(e.target.value)}>
                {all.map((column) => (
                  <option key={column.key} value={column.attr ?? ""}>
                    {column.label}
                  </option>
                ))}
              </select>
            </label>
            {/* A new attribute is a new read: nothing of the last one's window or answer carries over. */}
            <React.Fragment key={attr}>{history(attr, label)}</React.Fragment>
          </>
        ) : null}
        {tabs.find((one) => one.id === current)?.content}
      </div>
    </dialog>
  );
}
