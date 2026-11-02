import { useMemo } from "react";
import { displayName, endpointSource, parseGridConfig, projectRow, useClient } from "@joinedcontext/sdk";
import type { GridColumn, RichRow } from "@joinedcontext/sdk";
import { EntityGrid } from "@joinedcontext/sdk/grid";
import { Problem } from "./states";

export interface TypeGridProps {
  type: string;
  /** Where the type is read, in an application reading several (SDK-02). */
  endpoint?: string;
  columns?: GridColumn[];
  pageSize?: number;
  /** Opens a row, by its name in the first column. */
  onSelect?: (id: string) => void;
}

/** One type in the SDK's `EntityGrid`, read, paged and filtered at the endpoint. A column: `{ attr }` or `{ attr, formula }`. */
export function TypeGrid({ type, endpoint, columns, pageSize = 50, onSelect }: TypeGridProps) {
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
          <button type="button" className="jc-open" onClick={() => onSelect(row.id)}>
            {displayName(projectRow(row, language))}
          </button>
        ),
      },
    [onSelect, language],
  );
  if (!grid) return <Problem error={new Error(findings.map((each) => `${each.path}: ${each.message}`).join("; "))} />;
  return <EntityGrid config={grid} source={source} renderers={renderers || undefined} />;
}
