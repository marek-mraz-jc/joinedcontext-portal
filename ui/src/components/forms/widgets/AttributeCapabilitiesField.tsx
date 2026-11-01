import { useContext, useId } from "react";
import type { JSX } from "react";
import type { FieldProps } from "@rjsf/utils";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, queryKeys, unwrap } from "../../../api/client";
import { asManifests } from "../../../api/manifest";
import { filterSlotsOf } from "../../entities/filters";
import {
  Button,
  Checkbox,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableRowHeaderCell,
} from "../../ui";
import { FormDataContext } from "./EntitySelectorField";
import { FormProjectContext } from "./ModelWidgets";
import {
  columnBlocked,
  grantLimits,
  matrixRows,
  METADATA_MEMBERS,
  toggled,
  valueBlocked,
  VERSIONS_CAPABILITIES,
  withCapability,
  WRITE_CAPABILITIES,
} from "./attributeCapabilities";
import type { AttributeCapabilities, Capabilities, CapabilityField, GrantLimits } from "./attributeCapabilities";

const COLUMNS: CapabilityField[] = ["read", "history", "versions", "metadata", "write"];

interface Entry {
  entities?: { type?: unknown }[];
  propertyNames?: unknown;
  relationshipNames?: unknown;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v !== "") : [];

/**
 * A Policy entry's `attributes` block as a table (ADR-N-066 2.6, DM-153): a row per attribute the
 * model declares for the entry's types, plus `*`; columns read, history, versions, metadata and
 * edit. A cell the grant's operations cannot give is disabled and says why. The server checks
 * every key and value again at the dry run (DM-148, DM-151).
 */
export function AttributeCapabilitiesField(props: FieldProps): JSX.Element {
  const { t } = useTranslation();
  const id = useId();
  const root = useContext(FormDataContext) as ({ information?: Entry[] } & Parameters<typeof grantLimits>[0]) | undefined;
  const project = useContext(FormProjectContext) ?? "";
  const path = props.fieldPathId.path;
  const at = path.findIndex((step) => step === "information");
  const index = typeof path[at + 1] === "number" ? (path[at + 1] as number) : 0;
  const entry = root?.information?.[index];
  const types = [...new Set(strings((entry?.entities ?? []).map((selector) => selector?.type)))];
  const listed = [...strings(entry?.propertyNames), ...strings(entry?.relationshipNames)];
  const models = useQuery({
    queryKey: queryKeys.list(project, "datamodels"),
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/projects/{project}/{plural}", { params: { path: { project, plural: "datamodels" } } })),
    enabled: Boolean(project) && types.length > 0 && listed.length === 0,
  });
  const declared = [
    ...new Set(
      asManifests(models.data?.items ?? []).flatMap((model) =>
        types.flatMap((type) => filterSlotsOf(model, type).map((slot) => slot.name)),
      ),
    ),
  ].sort();
  const caps = (props.formData ?? undefined) as Capabilities | undefined;
  const rows = matrixRows(listed, declared, Object.keys(caps ?? {}));
  const limits = grantLimits(root);
  const frozen = Boolean(props.disabled || props.readonly);
  const write = <F extends CapabilityField>(attribute: string, field: F, value: AttributeCapabilities[F] | undefined): void =>
    props.onChange(withCapability(caps, attribute, field, value), props.fieldPathId.path);
  const hints = `${id}-hints`;

  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="text-body font-medium text-fg">{t("policies.capabilities.title")}</legend>
      <p className="text-caption text-fg-muted">{t("policies.capabilities.about")}</p>
      <dl id={hints} className="grid gap-1 text-caption sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-3">
        {COLUMNS.map((column) => (
          <div key={column} className="contents">
            <dt className="font-medium text-fg">{t(`policies.capabilities.column.${column}`)}</dt>
            <dd className="text-fg-muted">
              {t(`policies.capabilities.hint.${column}`)}
              {columnReasons(column, limits).map((reason) => (
                <span key={reason} className="block text-fg">
                  {t(reason)}
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      {types.length === 0 ? (
        <p className="text-caption text-fg-muted">{t("policies.capabilities.noType")}</p>
      ) : null}
      <Table stack caption={t("policies.capabilities.caption", { types: types.join(", ") || "—" })} zebra={false}>
        <TableHead>
          <TableHeaderCell>{t("policies.capabilities.column.attribute")}</TableHeaderCell>
          {COLUMNS.map((column) => (
            <TableHeaderCell key={column}>{t(`policies.capabilities.column.${column}`)}</TableHeaderCell>
          ))}
        </TableHead>
        <TableBody>
          {rows.map((attribute) => (
            <TableRow key={attribute}>
              <TableRowHeaderCell className="font-mono">
                {attribute === "*" ? t("policies.capabilities.every") : attribute}
              </TableRowHeaderCell>
              {COLUMNS.map((column) => (
                <TableCell key={column} data-label={t(`policies.capabilities.column.${column}`)}>
                  <CapabilityCell
                    attribute={attribute}
                    column={column}
                    row={caps?.[attribute]}
                    limits={limits}
                    frozen={frozen}
                    describedBy={hints}
                    onChange={(value) => write(attribute, column, value)}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </fieldset>
  );
}

/** Every reason a value of `column` cannot be set under `limits`, once each, as locale keys. */
export function columnReasons(column: CapabilityField, limits: GrantLimits): string[] {
  const values: readonly string[] =
    column === "versions" ? VERSIONS_CAPABILITIES : column === "write" ? WRITE_CAPABILITIES : column === "metadata" ? METADATA_MEMBERS : [""];
  return [
    ...new Set(
      values.map((value) => valueBlocked(column, value, limits)).filter((reason): reason is string => reason !== undefined),
    ),
  ];
}

interface CellProps {
  attribute: string;
  column: CapabilityField;
  row: AttributeCapabilities | undefined;
  limits: GrantLimits;
  frozen: boolean;
  describedBy: string;
  onChange: (value: AttributeCapabilities[CapabilityField] | undefined) => void;
}

/** One cell: a yes/no/inherit choice for read and history, ticks for the list columns. */
export function CapabilityCell({ attribute, column, row, limits, frozen, describedBy, onChange }: CellProps): JSX.Element {
  const { t } = useTranslation();
  const value = row?.[column];
  const blocked = columnBlocked(column, limits);
  // The reasons stand once above the table (columnReasons); a disabled box carries its own too.
  const name = `${attribute === "*" ? t("policies.capabilities.every") : attribute}: ${t(`policies.capabilities.column.${column}`)}`;
  const inherit = t(attribute === "*" ? "policies.capabilities.asGrant" : "policies.capabilities.asEvery");
  // A column the grant cannot give shows its reason; a value the manifest holds there anyway stays
  // visible, so the dry run's refusal names something the person can see.
  if (blocked && value === undefined) {
    return <span className="text-caption text-fg-muted">{t(blocked)}</span>;
  }
  if (column === "read" || column === "history") {
    return (
      <Select
        aria-label={name}
        aria-describedby={describedBy}
        className="min-w-28"
        disabled={frozen || (blocked !== undefined && value !== true)}
        value={value === undefined ? "" : String(value)}
        onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value === "true")}
      >
        <option value="">{inherit}</option>
        <option value="true">{t("policies.capabilities.yes")}</option>
        <option value="false">{t("policies.capabilities.no")}</option>
      </Select>
    );
  }
  const vocabulary: readonly string[] =
    column === "versions" ? VERSIONS_CAPABILITIES : column === "write" ? WRITE_CAPABILITIES : METADATA_MEMBERS;
  const list = value as string[] | undefined;
  const boxes = vocabulary.map((item) => {
    const reason = valueBlocked(column, item, limits);
    const ticked = list?.includes(item) ?? false;
    return (
      <div key={item} className="flex flex-col">
        <Checkbox
          label={<span className="font-mono text-caption">{item}</span>}
          aria-label={`${name} ${item}`}
          checked={ticked}
          disabled={frozen || (reason !== undefined && !ticked)}
          disabledReason={reason ? t(reason) : undefined}
          onChange={(event) => onChange(toggled(vocabulary, list, item, event.target.checked) as AttributeCapabilities[CapabilityField])}
        />
      </div>
    );
  });
  const reset =
    list !== undefined && !frozen ? (
      <Button size="sm" variant="ghost" aria-label={`${name}: ${inherit}`} onClick={() => onChange(undefined)}>
        {inherit}
      </Button>
    ) : (
      <span className="text-caption text-fg-muted">{list === undefined ? inherit : null}</span>
    );
  if (column !== "metadata") {
    return (
      <div className="flex flex-col gap-1">
        {boxes}
        {reset}
      </div>
    );
  }
  // Nine members: folded behind a summary so a row stays one line until it is opened.
  return (
    <details className="min-w-40">
      <summary className="focus-ring cursor-pointer rounded-sm text-caption text-fg">
        {list === undefined ? inherit : t("policies.capabilities.members", { count: list.length })}
      </summary>
      <div className="mt-2 flex flex-col gap-1">
        {boxes}
        {reset}
      </div>
    </details>
  );
}
