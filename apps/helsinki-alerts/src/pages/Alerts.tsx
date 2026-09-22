import { useState } from "react";
import { displayName, useAccess, useEntities, useFilters, useSave } from "@joinedcontext/sdk";
import type { FilterDef } from "@joinedcontext/sdk";
import { EntityDetail } from "../components/EntityDetail";
import { EntityForm } from "../components/EntityForm";
import { EntityMap } from "../components/EntityMap";
import { EntityTable } from "../components/EntityTable";
import { FilterBar, SearchBox, SelectFilter } from "../components/filters";
import { Problem } from "../components/states";
import { ALERT, COLUMNS, READ_ONLY, WRITABLE, isOwn } from "../alerts";

const FILTERS: FilterDef[] = [
  { kind: "search", attrs: ["name", "address"], label: "Search" },
  { kind: "select", attr: "category", label: "Category" },
  { kind: "select", attr: "subCategory", label: "Subcategory" },
];

function ReadOnlyNote() {
  return (
    <details className="app-muted">
      <summary>Fields this form does not write</summary>
      <ul>
        {READ_ONLY.map(([attr, why]) => (
          <li key={attr}>
            {attr}: {why}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Every alert: filters, the map, the table and the detail. A steward also gets the record form
 * (create and correct) and, on an alert a steward added, Delete. The controls follow the
 * endpoint's answer (`can`), and the gateway refuses the same write for anyone else (AP-09, AP-96).
 */
export function Alerts() {
  const { rows, loading, error, reload } = useEntities(ALERT);
  const { shown, bind, reset } = useFilters(rows, FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "edit" | "new">("view");
  const { can } = useAccess();
  const save = useSave();
  const selected = shown.find((row) => row.id === selectedId) ?? null;
  const select = (id: string | null) => {
    setSelectedId(id);
    setMode("view");
  };
  const done = (id: string) => {
    select(id);
    reload();
  };

  const mayCreate = can("createEntity", ALERT).ok;
  const mayEdit = can("updateAttrs", ALERT).ok;
  const mayDelete = can("deleteEntity", ALERT).ok;

  return (
    <section className="app-page" aria-label="Alerts">
      <FilterBar shown={shown.length} total={rows.length} onReset={reset}>
        <SearchBox binding={bind(0)} />
        <SelectFilter binding={bind(1)} />
        <SelectFilter binding={bind(2)} />
      </FilterBar>
      {mayCreate && mode !== "new" && (
        <button type="button" onClick={() => setMode("new")}>
          New alert
        </button>
      )}
      <EntityMap rows={shown} location="location" label="name" selected={selectedId} onSelect={(row) => select(row.id)} />
      <EntityTable
        rows={shown}
        columns={COLUMNS}
        loading={loading}
        error={error}
        selected={selectedId}
        onSelect={(row) => select(row.id)}
        initialSort={{ attr: "validFrom", dir: "desc" }}
        caption="Alerts"
        empty="No alert matches."
      />
      {mode === "new" && (
        <>
          <EntityForm type={ALERT} fields={WRITABLE} rows={rows} title="New alert" onSaved={done} onCancel={() => setMode("view")} />
          <ReadOnlyNote />
        </>
      )}
      {selected && mode === "view" && (
        <div className="app-detail">
          <EntityDetail row={selected} attrs={[...COLUMNS, "source"]} title={displayName(selected)} onClose={() => select(null)} />
          {mayEdit && (
            <button type="button" onClick={() => setMode("edit")}>
              Edit
            </button>
          )}
          {mayDelete && isOwn(selected) && (
            <button
              type="button"
              disabled={save.saving}
              onClick={() => {
                if (!window.confirm(`Delete ${displayName(selected)}? This cannot be undone.`)) return;
                void save.remove(selected.id).then((ok) => {
                  if (ok) {
                    select(null);
                    reload();
                  }
                });
              }}
            >
              Delete
            </button>
          )}
          <Problem error={save.problem} />
        </div>
      )}
      {selected && mode === "edit" && (
        <>
          <EntityForm type={ALERT} row={selected} fields={WRITABLE} rows={rows} onSaved={done} onCancel={() => setMode("view")} />
          <ReadOnlyNote />
        </>
      )}
    </section>
  );
}
