import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import type { Manifest } from "../../../api/manifest";
import { TypePicker } from "../../pickers/TypePicker";
import { filterSlotsOf, useModelSource } from "../../entities/filters";
import { Badge, InlineError, Select, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, TableRowHeaderCell } from "../../ui";
import { baseOf, CORE_ATTRIBUTES, ICAL_FIELDS, ICAL_PRESETS, presetSources, unmappedRequired, withPreset, withSource, withType } from "./icalMapping";
import type { IcalMapping, IcalSource } from "./icalMapping";
import { FEED_PRESETS, FEED_ROLES, feedPresetRoles, unmappedRoles, withRole } from "./representationOutputs";
import type { FeedSource } from "./representationOutputs";

/** A remap written in YAML, shown as it is: the table edits plain attribute names only. */
function remapText(source: IcalSource): string {
  return Object.entries(source)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}

/**
 * The attributes a role or field can come from: the type's slots in the space's model, which the
 * server lists only to a person who may read it, and the attributes every entity has. A value
 * written before stays offered, so opening the form never drops it; the save checks it again
 * against the model and names it when it does not fit (EP-125, API/11 EP-159).
 */
export function useAttributeChoices(project: string, model: Manifest | undefined, type: string): string[] {
  const slots = filterSlotsOf(useModelSource(project, model), type);
  return [...new Set([...slots.map((slot) => slot.name), ...CORE_ATTRIBUTES])].sort();
}

export interface SourceEditorProps<S> {
  /** The id prefix of this source's controls. */
  id: string;
  value: S;
  onChange: (next: S) => void;
  project: string;
  space: string;
  model: Manifest | undefined;
  frozen: boolean;
}

/**
 * One model class of a calendar output: the type, the preset it starts from and a row per
 * RFC 5545 field, its attribute picked from the type's slots, the preset's attribute shown where
 * the person picked none (EP-125, T-4900).
 */
export function IcalSourceEditor({ id, value, onChange, project, space, model, frozen }: SourceEditorProps<IcalMapping>): JSX.Element {
  const { t } = useTranslation();
  const type = value.type ?? "Event";
  const base = baseOf(value);
  const fromPreset = presetSources(base);
  const choices = useAttributeChoices(project, model, type);
  const missing = unmappedRequired(value);
  // `tidy` leaves the default out; a source in a list always names its type.
  const write = (next: IcalMapping | undefined): void => onChange({ type, ...(next ?? {}) });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-4">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-caption font-semibold">
          {t("endpoints.ical.type")}
          {frozen ? (
            <span className="font-mono text-body font-normal">{type}</span>
          ) : (
            // The classes of the space's model and what it imports, from the models the server
            // lists to this caller (T-4947); the save checks the type against the model again.
            <TypePicker
              id={`${id}-type`}
              label={t("endpoints.ical.type")}
              labelled
              project={project}
              space={space || undefined}
              value={[type]}
              onChange={(types) => write(withType(value, types[0] ?? "Event"))}
            />
          )}
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-caption font-semibold">
          {t("endpoints.ical.start")}
          {frozen ? (
            <span className="text-body font-normal">{base ? t(`endpoints.ical.preset.${base}`) : t("endpoints.ical.presetOwn")}</span>
          ) : (
            <Select
              id={`${id}-preset`}
              aria-describedby={`${id}-hint`}
              value={value.preset ?? (base === undefined ? "" : "default")}
              onChange={(event) => {
                // "The default" is offered only while nothing is written: picking it changes nothing.
                if (event.currentTarget.value !== "default") write(withPreset(value, event.currentTarget.value));
              }}
            >
              {value.preset === undefined && base !== undefined ? <option value="default">{t("endpoints.ical.presetDefault")}</option> : null}
              {ICAL_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {t(`endpoints.ical.preset.${preset}`)}
                </option>
              ))}
              <option value="">{t("endpoints.ical.presetOwn")}</option>
            </Select>
          )}
        </label>
      </div>
      <p id={`${id}-hint`} className="text-caption text-fg-muted">
        {t("endpoints.outputs.type.hint")} {t("endpoints.outputs.presetHint")}
      </p>
      {missing.length > 0 ? <InlineError>{t("endpoints.ical.missing", { fields: missing.join(", ") })}</InlineError> : null}
      <Table caption={t("endpoints.ical.caption")} zebra={false}>
        <TableHead>
          <TableHeaderCell>{t("endpoints.ical.field")}</TableHeaderCell>
          <TableHeaderCell>{t("endpoints.ical.attribute")}</TableHeaderCell>
        </TableHead>
        <TableBody>
          {ICAL_FIELDS.map(({ field, required, fixed }) => {
            const picked = value.mapping?.[field];
            const inputId = `${id}-${field}`;
            return (
              <TableRow key={field}>
                <TableRowHeaderCell className="font-mono">
                  <span className="flex flex-col items-start gap-1">
                    <label htmlFor={fixed ? undefined : inputId}>{field}</label>
                    {required ? <Badge tone="neutral">{t("endpoints.ical.requiredBadge")}</Badge> : null}
                  </span>
                </TableRowHeaderCell>
                <TableCell className="w-full">
                  {fixed ? (
                    <span className="text-fg-muted">{t("endpoints.ical.fixed", { attribute: fixed })}</span>
                  ) : picked !== undefined && typeof picked !== "string" ? (
                    <span className="font-mono text-caption" title={t("endpoints.ical.remap")}>
                      {remapText(picked)}
                    </span>
                  ) : frozen ? (
                    <span className="font-mono text-caption">{picked ?? fromPreset[field] ?? t("endpoints.ical.unmapped")}</span>
                  ) : (
                    <AttributeSelect
                      id={inputId}
                      value={picked ?? ""}
                      choices={choices}
                      empty={fromPreset[field] ? t("endpoints.outputs.fromPreset", { attribute: fromPreset[field] }) : t("endpoints.ical.unmapped")}
                      invalid={missing.includes(field)}
                      onChange={(attribute) => write(withSource(value, field, attribute))}
                    />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** A dropdown of the attributes a field may come from; the empty option leaves it to the preset. */
export function AttributeSelect({
  id,
  value,
  choices,
  empty,
  invalid,
  onChange,
}: {
  id: string;
  value: string;
  choices: string[];
  empty: string;
  invalid?: boolean;
  onChange: (attribute: string) => void;
}): JSX.Element {
  const options = value && !choices.includes(value) ? [value, ...choices] : choices;
  return (
    <Select id={id} value={value} aria-invalid={invalid ? "true" : undefined} onChange={(event) => onChange(event.currentTarget.value)}>
      <option value="">{empty}</option>
      {options.map((choice) => (
        <option key={choice} value={choice}>
          {choice}
        </option>
      ))}
    </Select>
  );
}

/**
 * One model class of a feed output: the type, the preset it starts from and a row per entry role,
 * its attribute picked from the type's slots, the preset's shown where the person picked none
 * (EP-150, API/11 EP-159).
 */
export function FeedSourceEditor({ id, value, onChange, project, space, model, frozen }: SourceEditorProps<FeedSource>): JSX.Element {
  const { t } = useTranslation();
  const preset = feedPresetRoles(value.preset);
  const choices = useAttributeChoices(project, model, value.type);
  const missing = unmappedRoles(value);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-4">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-caption font-semibold">
          {t("endpoints.ical.type")}
          {frozen ? (
            <span className="font-mono text-body font-normal">{value.type}</span>
          ) : (
            <TypePicker
              id={`${id}-type`}
              label={t("endpoints.ical.type")}
              labelled
              project={project}
              space={space || undefined}
              value={value.type ? [value.type] : []}
              onChange={(types) => onChange({ ...value, type: types[0] ?? value.type })}
            />
          )}
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-caption font-semibold">
          {t("endpoints.ical.start")}
          {frozen ? (
            <span className="text-body font-normal">{value.preset ? t(`endpoints.outputs.feedPreset.${value.preset}`) : t("endpoints.ical.presetOwn")}</span>
          ) : (
            <Select
              id={`${id}-preset`}
              aria-describedby={`${id}-hint`}
              value={value.preset ?? ""}
              onChange={(event) => {
                const next: FeedSource = { ...value, preset: event.currentTarget.value || undefined };
                if (!next.preset) delete next.preset;
                onChange(next);
              }}
            >
              {FEED_PRESETS.map((name) => (
                <option key={name} value={name}>
                  {t(`endpoints.outputs.feedPreset.${name}`)}
                </option>
              ))}
              <option value="">{t("endpoints.ical.presetOwn")}</option>
            </Select>
          )}
        </label>
      </div>
      <p id={`${id}-hint`} className="text-caption text-fg-muted">
        {t("endpoints.outputs.type.hint")} {t("endpoints.outputs.feedPresetHint")}
      </p>
      {missing.length > 0 ? <InlineError>{t("endpoints.ical.missing", { fields: missing.join(", ") })}</InlineError> : null}
      <Table caption={t("endpoints.outputs.rolesCaption")} zebra={false}>
        <TableHead>
          <TableHeaderCell>{t("endpoints.outputs.role")}</TableHeaderCell>
          <TableHeaderCell>{t("endpoints.ical.attribute")}</TableHeaderCell>
        </TableHead>
        <TableBody>
          {FEED_ROLES.map(({ role, required }) => {
            const picked = value.mapping?.[role];
            const inputId = `${id}-${role}`;
            const fromPreset = preset[role]?.join(" | ");
            return (
              <TableRow key={role}>
                <TableRowHeaderCell>
                  <span className="flex flex-col items-start gap-1">
                    <label htmlFor={inputId}>{t(`endpoints.outputs.roles.${role}`)}</label>
                    {required ? <Badge tone="neutral">{t("endpoints.ical.requiredBadge")}</Badge> : null}
                  </span>
                </TableRowHeaderCell>
                <TableCell className="w-full">
                  {Array.isArray(picked) ? (
                    <span className="font-mono text-caption" title={t("endpoints.ical.remap")}>
                      {picked.join(" | ")}
                    </span>
                  ) : frozen ? (
                    <span className="font-mono text-caption">{picked ?? fromPreset ?? t("endpoints.ical.unmapped")}</span>
                  ) : (
                    <AttributeSelect
                      id={inputId}
                      value={picked ?? ""}
                      choices={choices}
                      empty={fromPreset ? t("endpoints.outputs.fromPreset", { attribute: fromPreset }) : t("endpoints.ical.unmapped")}
                      invalid={missing.includes(role)}
                      onChange={(attribute) => onChange(withRole(value, role, attribute))}
                    />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
