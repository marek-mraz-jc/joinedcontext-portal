import { useMemo } from "react";
import { displayName, endpointSource, parseGridConfig, projectRow, useClient } from "@joinedcontext/sdk";
import type { GridColumn, RichRow } from "@joinedcontext/sdk";
import { EntityGrid } from "@joinedcontext/sdk/grid";
import { Problem } from "./states";

/**
 * The rows of one type in the SDK's `EntityGrid`: read, paged, sorted and filtered at the endpoint.
 * `columns` picks and orders the attributes; `{ attr: "occupancy", formula: "a / b * 100" }` adds a
 * column worked out of a row's attributes. `onSelect` opens a row by its name in the first column.
 * `endpoint` names where the type is read, in an application reading several (SDK-02).
 */
export function TypeGrid({
  type,
  endpoint,
  columns,
  pageSize = 50,
  onSelect,
}: {
  type: string;
  endpoint?: string;
  columns?: GridColumn[];
  pageSize?: number;
  onSelect?: (id: string) => void;
}) {
  const { config, transport } = useClient();
  const slug = config.endpoints?.find((each) => each.name === endpoint)?.slug ?? config.slug;
  const { language } = config;
  const source = useMemo(
    () => endpointSource(slug, transport, language),
    [slug, transport, language],
  );
  const { config: grid, findings } = useMemo(
    () => parseGridConfig({ source: { kind: "endpoint", slug }, type, pageSize, ...(columns ? { columns } : {}) }),
    [slug, type, pageSize, columns],
  );
  const renderers = useMemo(
    () =>
      onSelect && {
        id: (_cell: unknown, row: RichRow) => (
          <button type="button" className="jc-grid-open" onClick={() => onSelect(row.id)}>
            {displayName(projectRow(row, language))}
          </button>
        ),
      },
    [onSelect, language],
  );
  if (!grid) return <Problem error={new Error(findings.map((each) => `${each.path}: ${each.message}`).join("; "))} />;
  return <EntityGrid config={grid} source={source} renderers={renderers || undefined} />;
}
