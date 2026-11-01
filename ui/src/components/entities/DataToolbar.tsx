/**
 * The grid's tools in one row (T-4883, T-6303): Filter, Hide fields, Sort, Group, Colour, Row
 * size, the search and the query box's switch. The space's data tab and an Endpoint's Data section
 * render this one component, so a person meets the same tools over the same grid on both pages.
 * The host holds every value; this row only draws and reports them.
 */
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import type { EnumOption, FilterColumn, FilterGroup } from "@joinedcontext/sdk";
import { Button, Input, RadioGroup } from "../ui";
import { conditionCount, FilterPanel } from "./FilterPanel";
import { GroupPanel, MAX_GROUP_FIELDS, ROW_SIZES, SortPanel, ToolbarPopover } from "./GridToolbar";
import type { PanelField, RowSize, SortKey } from "./GridToolbar";
import { ViewOptions } from "./ViewOptions";
import type { ViewExtras } from "./ViewOptions";

export interface DataToolbarProps {
  /** The columns the grid can filter, as it reports them (`onFilterColumns`). */
  filterColumns: FilterColumn[];
  filterTitle: (column: FilterColumn) => string;
  filters: FilterGroup;
  onFilters: (next: FilterGroup) => void;
  /** Every attribute a person can hide or colour by, in the column order. */
  attributes: string[];
  enums: Record<string, EnumOption[]>;
  /** The hidden fields and the colour rules. */
  extras: ViewExtras;
  onExtras: (next: ViewExtras) => void;
  /** What the Sort and Group panels offer. */
  fields: PanelField[];
  sortKeys: SortKey[];
  onSortKeys: (next: SortKey[]) => void;
  groupBy: string[];
  onGroupBy: (next: string[]) => void;
  rowSize: RowSize;
  onRowSize: (next: RowSize) => void;
  searchText: string;
  onSearchText: (next: string) => void;
  showQuery: boolean;
  onShowQuery: (next: boolean) => void;
}

export function DataToolbar(props: DataToolbarProps): JSX.Element {
  const { t } = useTranslation();
  const { extras, onExtras, attributes, enums } = props;
  const labelOf = (attr: string) => props.fields.find((field) => field.value === attr)?.label ?? attr;
  return (
    <>
      <ToolbarPopover label={t("spaces.toolbar.filter")} count={conditionCount(props.filters)} wide>
        <FilterPanel columns={props.filterColumns} titleOf={props.filterTitle} value={props.filters} onChange={props.onFilters} />
      </ToolbarPopover>
      <ToolbarPopover label={t("spaces.toolbar.hide")} count={extras.hidden?.length}>
        <ViewOptions part="fields" attributes={attributes} enums={enums} value={extras} onChange={onExtras} labelOf={labelOf} />
      </ToolbarPopover>
      <ToolbarPopover label={t("spaces.toolbar.sort")} count={props.sortKeys.length}>
        <SortPanel fields={props.fields} value={props.sortKeys} onChange={props.onSortKeys} />
      </ToolbarPopover>
      <ToolbarPopover label={t("spaces.toolbar.group")} count={props.groupBy.length}>
        <GroupPanel fields={props.fields} value={props.groupBy} onChange={(next) => props.onGroupBy(next.slice(0, MAX_GROUP_FIELDS))} />
      </ToolbarPopover>
      <ToolbarPopover label={t("spaces.toolbar.colour")} count={extras.colour?.length} wide>
        <ViewOptions part="colours" attributes={attributes} enums={enums} value={extras} onChange={onExtras} />
      </ToolbarPopover>
      <ToolbarPopover label={t("spaces.toolbar.rowSize")}>
        <RadioGroup
          name="grid-row-size"
          legend={t("spaces.toolbar.rowSize")}
          value={props.rowSize}
          options={ROW_SIZES.map((size) => ({ value: size, label: t(`spaces.toolbar.rowSizes.${size}`) }))}
          onChange={props.onRowSize}
        />
      </ToolbarPopover>
      <Input
        type="search"
        aria-label={t("spaces.toolbar.search")}
        placeholder={t("spaces.toolbar.searchPlaceholder")}
        className="h-control w-full sm:w-36"
        value={props.searchText}
        onChange={(e) => props.onSearchText(e.target.value)}
      />
      {/* The query the filters ask, folded until asked for (T-5093): the rows and their count stay together. */}
      <Button variant={props.showQuery ? "secondary" : "ghost"} size="sm" aria-pressed={props.showQuery} onClick={() => props.onShowQuery(!props.showQuery)}>
        {t("spaces.toolbar.query")}
      </Button>
    </>
  );
}
