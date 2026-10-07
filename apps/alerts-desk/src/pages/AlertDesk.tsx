import { useState } from "react";
import { displayName, Page, useEntities, useFilters } from "@joinedcontext/sdk";
import type { FilterDef } from "@joinedcontext/sdk";
import { EntityDetail } from "../components/EntityDetail";
import { EntityTable } from "../components/EntityTable";
import type { ColumnDef } from "../components/EntityTable";
import { ExportButton } from "../components/ExportButton";
import { DateRangeFilter, FilterBar, SearchBox, SelectFilter } from "../components/filters";

export const ALERT = "Alert";

/** The table's columns in the order a desk scans them: what, where, and when it holds. */
export const COLUMNS: ColumnDef[] = [
  { attr: "name", label: "Alert" },
  { attr: "category", label: "Category" },
  { attr: "subCategory", label: "Subcategory" },
  { attr: "address", label: "Address" },
  { attr: "validFrom", label: "Valid from" },
  { attr: "validTo", label: "Valid to" },
  { attr: "dateIssued", label: "Issued" },
];

/** The detail panel's words: the table's, and the two attributes only the detail shows. */
const LABELS: Record<string, string> = {
  ...Object.fromEntries(COLUMNS.map((column) => [column.attr, column.label ?? column.attr])),
  description: "Description",
  source: "Published by",
};

const FILTERS: FilterDef[] = [
  { kind: "search", attrs: ["name", "description", "address"], label: "Search" },
  { kind: "select", attr: "category", label: "Category" },
  { kind: "select", attr: "subCategory", label: "Subcategory" },
  { kind: "dateRange", attr: "validTo", label: "Valid to" },
];

/**
 * Every alert the endpoint answers: filters, the table sorted by any column, an export of what is
 * shown, and the chosen alert's every attribute. Nothing here writes (owner decision (a), T-3016).
 */
export function AlertDesk() {
  const { rows, loading, error } = useEntities(ALERT);
  const { shown, bind, reset } = useFilters(rows, FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = shown.find((row) => row.id === selectedId) ?? null;

  return (
    <Page label="Alerts">
      <FilterBar shown={shown.length} total={rows.length} onReset={reset}>
        <SearchBox binding={bind(0)} />
        <SelectFilter binding={bind(1)} />
        <SelectFilter binding={bind(2)} />
        <DateRangeFilter binding={bind(3)} />
      </FilterBar>
      <EntityTable
        rows={shown}
        columns={COLUMNS}
        loading={loading}
        error={error}
        selected={selectedId}
        onSelect={(row) => setSelectedId(row.id)}
        initialSort={{ attr: "validTo", dir: "desc" }}
        caption="Traffic alerts"
        empty={rows.length > 0 ? "No alert matches these filters." : "The endpoint holds no alerts right now."}
      />
      <ExportButton rows={shown} columns={COLUMNS.map((column) => column.attr)} filename="alerts" formats={["csv", "pdf"]} />
      {selected && (
        <div className="app-detail">
          <EntityDetail
            row={selected}
            attrs={Object.keys(LABELS)}
            labels={LABELS}
            title={displayName(selected)}
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}
    </Page>
  );
}
