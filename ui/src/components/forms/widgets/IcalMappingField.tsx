import { useContext, useId } from "react";
import type { JSX } from "react";
import type { FieldProps } from "@rjsf/utils";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, queryKeys, unwrap } from "../../../api/client";
import { asManifests, refName } from "../../../api/manifest";
import { filterSlotsOf, useModelSource } from "../../entities/filters";
import { Badge, InlineError, Input, Select, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, TableRowHeaderCell } from "../../ui";
import { LIST_BODY, LIST_FIELDSET, ListLegend, pathOf } from "../theme";
import { FormDataContext } from "./EntitySelectorField";
import { ListFailed, reasonOf } from "./ListFailed";
import { FormProjectContext } from "./ModelWidgets";
import {
  baseOf,
  CORE_ATTRIBUTES,
  ICAL_FIELDS,
  ICAL_PRESETS,
  presetSources,
  unmappedRequired,
  withPreset,
  withSource,
  withType,
} from "./icalMapping";
import type { IcalMapping, IcalSource } from "./icalMapping";

/** A remap written in YAML, shown as it is: the table edits plain attribute names only. */
function remapText(source: IcalSource): string {
  return Object.entries(source)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}

/**
 * `spec.representations`: how the iCalendar feed maps RFC 5545 fields from the attributes of the
 * space's model (EP-125, T-4900). A row per field, its attribute picked from the type's slots, the
 * preset's attribute shown where the person wrote none. The server checks the mapping against the
 * model when the form is checked or proposed, and its sentences show in the form's verdict.
 */
export function IcalMappingField(props: FieldProps): JSX.Element {
  const { formData, onChange, disabled, readonly, schema, fieldPathId } = props;
  const { t } = useTranslation();
  const id = fieldPathId.$id;
  const listId = useId();
  const project = useContext(FormProjectContext) ?? "";
  const root = useContext(FormDataContext) as { contextSpaceRef?: unknown; enabledRepresentations?: unknown } | undefined;
  const served = Array.isArray(root?.enabledRepresentations) && root.enabledRepresentations.includes("ical");
  const space = typeof root?.contextSpaceRef === "string" ? root.contextSpaceRef : "";
  const stored = (formData as { ical?: IcalMapping } | undefined)?.ical ?? {};
  const type = stored.type ?? "Event";
  const base = baseOf(stored);
  const fromPreset = presetSources(base);
  const frozen = Boolean(disabled || readonly);

  const models = useQuery({
    queryKey: queryKeys.list(project, "datamodels"),
    queryFn: async () => unwrap(await api.GET("/api/v1/projects/{project}/{plural}", { params: { path: { project, plural: "datamodels" } } })),
    enabled: served && Boolean(project),
  });
  const model = asManifests(models.data?.items ?? []).find(
    (m) => refName((m.spec as { contextSpaceRef?: unknown } | undefined)?.contextSpaceRef as string | undefined) === space,
  );
  // A committed model holds a path to its file: the source is read the way the model editor reads it.
  const slots = filterSlotsOf(useModelSource(project, model), type);
  const choices = [...new Set([...slots.map((slot) => slot.name), ...CORE_ATTRIBUTES])].sort();
  const missing = unmappedRequired(stored);
  const write = (next: IcalMapping | undefined): void => onChange(next ? { ical: next } : undefined, fieldPathId.path);

  return (
    <fieldset id={id} data-testid="ical-mapping" className={LIST_FIELDSET}>
      <ListLegend heading={schema.title ?? ""} path={pathOf(fieldPathId)} />
      <div className={`${LIST_BODY} flex flex-col gap-3`}>
        {!served ? (
          <p className="text-caption text-fg-muted">{t("endpoints.ical.off")}</p>
        ) : (
          <>
            <p id={`${id}__help`} className="text-caption text-fg-muted">
              {t("endpoints.ical.help")}
            </p>
            <div className="flex flex-wrap gap-4">
              <label className="flex min-w-48 flex-1 flex-col gap-1 text-caption font-semibold">
                {t("endpoints.ical.start")}
                {frozen ? (
                  <span className="text-body font-normal">{base ? t(`endpoints.ical.preset.${base}`) : t("endpoints.ical.presetOwn")}</span>
                ) : (
                <Select
                    id={`${id}-preset`}
                    value={stored.preset ?? (base === undefined ? "" : "default")}
                    onChange={(event) => {
                      // "The default" is offered only while nothing is written: picking it changes nothing.
                      if (event.currentTarget.value !== "default") write(withPreset(stored, event.currentTarget.value));
                    }}
                  >
                    {stored.preset === undefined && base !== undefined ? <option value="default">{t("endpoints.ical.presetDefault")}</option> : null}
                    {ICAL_PRESETS.map((preset) => (
                      <option key={preset} value={preset}>
                        {t(`endpoints.ical.preset.${preset}`)}
                      </option>
                    ))}
                    <option value="">{t("endpoints.ical.presetOwn")}</option>
                  </Select>
                )}
              </label>
              <label className="flex min-w-48 flex-1 flex-col gap-1 text-caption font-semibold">
                {t("endpoints.ical.type")}
                {frozen ? (
                  <span className="font-mono text-body font-normal">{type}</span>
                ) : (
                <Input
                    id={`${id}-type`}
                    value={type}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => write(withType(stored, event.currentTarget.value))}
                  />
                )}
              </label>
            </div>
            {models.isError ? (
              <ListFailed what={t("nav.models")} reason={reasonOf(models.error, t("app.error"))} onRetry={() => void models.refetch()} />
            ) : null}
            {!models.isLoading && !models.isError && !model ? <p className="text-caption text-warning">{t("endpoints.ical.noModel", { space })}</p> : null}
            {missing.length > 0 ? (
              <InlineError>{t("endpoints.ical.missing", { fields: missing.join(", ") })}</InlineError>
            ) : null}
            <Table caption={t("endpoints.ical.caption")} zebra={false}>
              <TableHead>
                <TableHeaderCell>{t("endpoints.ical.field")}</TableHeaderCell>
                <TableHeaderCell>{t("endpoints.ical.attribute")}</TableHeaderCell>
              </TableHead>
              <TableBody>
                {ICAL_FIELDS.map(({ field, required, fixed }) => {
                  const written = stored.mapping?.[field];
                  const inputId = `${id}-${field}`;
                  return (
                    <TableRow key={field}>
                      <TableRowHeaderCell className="font-mono">
                        <span className="flex flex-col items-start gap-1">
                          <label htmlFor={fixed ? undefined : inputId}>{field}</label>
                          {required ? <Badge tone="neutral">{t("endpoints.ical.requiredBadge")}</Badge> : null}
                        </span>
                      </TableRowHeaderCell>
                      <TableCell className="w-full min-w-40">
                        {fixed ? (
                          <span className="text-fg-muted">{t("endpoints.ical.fixed", { attribute: fixed })}</span>
                        ) : written !== undefined && typeof written !== "string" ? (
                          <span className="font-mono text-caption" title={t("endpoints.ical.remap")}>
                            {remapText(written)}
                          </span>
                        ) : frozen ? (
                          <span className="font-mono text-caption">{written ?? fromPreset[field] ?? t("endpoints.ical.unmapped")}</span>
                        ) : (
                          <Input
                            id={inputId}
                            list={listId}
                            value={written ?? ""}
                            placeholder={fromPreset[field] ?? t("endpoints.ical.unmapped")}
                            autoComplete="off"
                            spellCheck={false}
                            aria-invalid={missing.includes(field) ? "true" : undefined}
                            onChange={(event) => write(withSource(stored, field, event.currentTarget.value))}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <datalist id={listId}>
              {choices.map((choice) => (
                <option key={choice} value={choice} />
              ))}
            </datalist>
          </>
        )}
      </div>
    </fieldset>
  );
}
