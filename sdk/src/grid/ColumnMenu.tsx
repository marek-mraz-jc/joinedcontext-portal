/**
 * A column's header menu (T-4827): sort, filter, hide, a label of this view's own, width and
 * place, with the attribute's metadata under "Details". Every action is a button or a field, so a
 * keyboard reaches each one; dragging a header or its edge does the same as Move and Width.
 */
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { GridLabels } from "./useEntityGrid";

export interface ColumnMenuProps {
  /** What the column is called now, without its unit: what Rename starts from. */
  label: string;
  labels: GridLabels;
  /** The direction this column orders the rows in, if it does. */
  sorted: "asc" | "desc" | null;
  onSort: (dir: "asc" | "desc") => void;
  /** Absent where the column has no filter (the endpoint cannot be asked about it). */
  onFilter?: () => void;
  /** Absent for the primary column: it names the row and is never hidden. */
  onHide?: () => void;
  /** A label of this view's own; `undefined` goes back to the model's. */
  onRename: (label: string | undefined) => void;
  renamed: boolean;
  onWiden: (delta: number) => void;
  onMove?: (delta: -1 | 1) => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  /** History and the metadata columns, as the grid offered them before. */
  details?: React.ReactNode;
  onClose: () => void;
}

/** Pixels one Narrower or Wider press moves the edge. */
export const WIDTH_STEP = 40;

export const ColumnMenu = React.forwardRef<HTMLDivElement, ColumnMenuProps>(function ColumnMenu(
  { label, labels, sorted, onSort, onFilter, onHide, onRename, renamed, onWiden, onMove, canMoveLeft, canMoveRight, details, onClose },
  ref,
) {
  const id = useId();
  const [draft, setDraft] = useState(label);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);
  // The grid clips what overflows it, so under a short grid the menu lost everything below its
  // first items (T-4924): it sits fixed at its header cell, inside the window, and follows it.
  const box = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const menu = box.current;
    const cell = menu?.parentElement;
    if (!menu || !cell) return;
    const place = () => {
      const at = cell.getBoundingClientRect();
      const width = menu.offsetWidth;
      const below = window.innerHeight - at.bottom;
      // Above the cell when it does not fit below and there is more room above; it scrolls inside.
      const up = menu.scrollHeight > below && at.top > below;
      const room = up ? at.top : below;
      menu.style.maxHeight = `${room}px`;
      menu.style.top = `${up ? at.top - Math.min(menu.scrollHeight, room) : at.bottom}px`;
      menu.style.left = `${Math.max(0, Math.min(at.right - width, window.innerWidth - width))}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    // Opening Details makes it taller: placed again, it may go above the cell.
    menu.addEventListener("toggle", place, true);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      menu.removeEventListener("toggle", place, true);
    };
  }, []);
  const setBox = (el: HTMLDivElement | null) => {
    box.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  };
  const commit = () => {
    const text = draft.trim();
    if (text !== "" && text !== label) onRename(text);
  };
  return (
    <div
      className="jc-grid-meta-menu jc-grid-col-menu"
      ref={setBox}
      role="dialog"
      aria-label={`${labels.columnMenu}: ${label}`}
      onKeyDown={(e) => {
        // Inside the menu the grid's own arrow and Enter keys do not apply.
        e.stopPropagation();
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="jc-grid-col-menu-row">
        <button ref={first} type="button" className="jc-grid-meta-item" aria-pressed={sorted === "asc"} onClick={() => onSort("asc")}>
          {labels.sortAsc}
        </button>
        <button type="button" className="jc-grid-meta-item" aria-pressed={sorted === "desc"} onClick={() => onSort("desc")}>
          {labels.sortDesc}
        </button>
      </div>
      {onFilter && (
        <button type="button" className="jc-grid-meta-item" onClick={onFilter}>
          {labels.filterColumn}
        </button>
      )}
      {onHide && (
        <button type="button" className="jc-grid-meta-item" onClick={onHide}>
          {labels.hideColumn}
        </button>
      )}
      <label className="jc-grid-col-menu-field" htmlFor={`${id}-label`}>
        {labels.renameColumn}
      </label>
      <input
        id={`${id}-label`}
        className="jc-grid-col-menu-input"
        value={draft}
        maxLength={80}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      {renamed && (
        <button type="button" className="jc-grid-meta-item" onClick={() => onRename(undefined)}>
          {labels.renameReset}
        </button>
      )}
      <div className="jc-grid-col-menu-row" role="group" aria-label={labels.columnWidth}>
        <button type="button" className="jc-grid-meta-item" onClick={() => onWiden(-WIDTH_STEP)}>
          {labels.narrower}
        </button>
        <button type="button" className="jc-grid-meta-item" onClick={() => onWiden(WIDTH_STEP)}>
          {labels.wider}
        </button>
      </div>
      {onMove && (
        <div className="jc-grid-col-menu-row">
          <button type="button" className="jc-grid-meta-item" disabled={!canMoveLeft} onClick={() => onMove(-1)}>
            {labels.moveLeft}
          </button>
          <button type="button" className="jc-grid-meta-item" disabled={!canMoveRight} onClick={() => onMove(1)}>
            {labels.moveRight}
          </button>
        </div>
      )}
      {details && (
        <details className="jc-grid-col-menu-details">
          <summary>{labels.details}</summary>
          {details}
        </details>
      )}
      <button type="button" className="jc-grid-meta-item" onClick={onClose}>
        {labels.close}
      </button>
    </div>
  );
});
