import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox, Field, Input, Select } from "../../components/ui";
import type { LinkmlClass, LinkmlModel, LinkmlSlot } from "./linkml";
import type { Operation, PersonalField } from "./operations";
import { INGESTS, LEGAL_BASES, holdsPersonalData } from "./personalData";

type Run = (operation: Operation) => boolean;

/**
 * What a class says about the personal data it holds (DM-120): whether it holds any, the legal
 * basis, the purpose per language, how long it is kept and the slot that names the person. The
 * last four show once the class or one of its slots holds personal data.
 */
export function ClassPersonalFields({
  model,
  klass,
  locales,
  run,
}: {
  model: LinkmlModel;
  klass: LinkmlClass;
  locales: string[];
  run: Run;
}): JSX.Element {
  const { t } = useTranslation();
  const personal = klass.personal ?? {};
  const set = (field: PersonalField, value: string | boolean, locale?: string) =>
    run({ op: "setPersonal", target: "class", name: klass.name, field, value, locale });
  const languages = locales.length > 0 ? locales : ["en"];

  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
      <legend className="px-1 text-sm font-semibold">{t("models.personal.title")}</legend>
      <Checkbox
        label={t("models.personal.classHolds")}
        checked={personal.personalData === true}
        onChange={(event) => set("personalData", event.target.checked)}
      />
      {holdsPersonalData(model, klass) ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="class-legal-basis" label={t("models.personal.legalBasis")} help={t("models.personal.legalBasisHint")}>
            <Select
              id="class-legal-basis"
              value={personal.legalBasis ?? ""}
              onChange={(event) => set("legalBasis", event.target.value)}
            >
              <option value="">—</option>
              {LEGAL_BASES.map((basis) => (
                <option key={basis} value={basis}>
                  {t(`models.personal.basis.${basis}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="class-max-retention" label={t("models.personal.maxRetention")} help={t("models.personal.maxRetentionHint")}>
            <Input
              id="class-max-retention"
              placeholder="P90D"
              value={personal.maxRetention ?? ""}
              onChange={(event) => set("maxRetention", event.target.value)}
            />
          </Field>
          <Field id="class-data-subject" label={t("models.personal.dataSubjectRef")} help={t("models.personal.dataSubjectRefHint")}>
            <Select
              id="class-data-subject"
              value={personal.dataSubjectRef ?? ""}
              onChange={(event) => set("dataSubjectRef", event.target.value)}
            >
              <option value="">—</option>
              {klass.slots.map((slot) => (
                <option key={slot} value={slot}>
                  {slot}
                </option>
              ))}
            </Select>
          </Field>
          {languages.map((locale) => (
            <Field key={locale} id={`class-purpose-${locale}`} label={t("models.personal.purposeIn", { locale })}>
              <Input
                id={`class-purpose-${locale}`}
                value={personal.purpose?.[locale] ?? ""}
                onChange={(event) => set("purpose", event.target.value, locale)}
              />
            </Field>
          ))}
        </div>
      ) : null}
    </fieldset>
  );
}

/** Whether a slot holds personal data, and what of it reaches the broker (DM-120, DM-121). */
export function SlotPersonalFields({ slot, run }: { slot: LinkmlSlot; run: Run }): JSX.Element {
  const { t } = useTranslation();
  const set = (field: PersonalField, value: string | boolean) =>
    run({ op: "setPersonal", target: "slot", name: slot.name, field, value });
  return (
    <div className="flex flex-wrap items-end gap-4 text-sm">
      <Checkbox
        label={t("models.personal.slotHolds")}
        checked={slot.personalData === true}
        onChange={(event) => set("personalData", event.target.checked)}
      />
      {slot.personalData ? (
        <Field id="slot-ingest" label={t("models.personal.ingest")} help={t("models.personal.ingestHint")}>
          <Select id="slot-ingest" value={slot.ingest ?? "keep"} onChange={(event) => set("ingest", event.target.value)}>
            {INGESTS.map((ingest) => (
              <option key={ingest} value={ingest}>
                {t(`models.personal.ingestName.${ingest}`)}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
    </div>
  );
}
