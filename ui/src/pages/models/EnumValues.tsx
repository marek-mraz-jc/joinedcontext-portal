import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Field,
  Icon,
  Input,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../components/ui";
import type { LinkmlEnum, LinkmlModel } from "./linkml";
import type { Operation } from "./operations";

/** Where an enumeration is used: each field whose range it is, with the types that carry the field. */
export function enumUses(model: LinkmlModel, name: string): { field: string; types: string[] }[] {
  return model.slots
    .filter((slot) => slot.range === name)
    .map((slot) => ({
      field: slot.name,
      types: model.classes.filter((klass) => klass.slots.includes(slot.name)).map((klass) => klass.name),
    }));
}

/**
 * One enumeration as a table (T-6162, owner review of T-6101): the stored value is what entities
 * hold, so it is fixed once added; the label is what people read and is edited in place. Other
 * languages and the description sit under Translations, folded.
 */
export function EnumValues({
  model,
  entry,
  locales,
  run,
  readOnly,
}: {
  model: LinkmlModel;
  entry: LinkmlEnum;
  locales: string[];
  run: (operation: Operation) => boolean;
  readOnly?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const newId = useId();
  const [newValue, setNewValue] = useState("");
  const uses = enumUses(model, entry.name);
  const others = locales.filter((locale) => locale !== "en");

  const add = () => {
    const value = newValue.trim();
    if (value !== "" && run({ op: "addEnumValue", enum: entry.name, value })) {
      setNewValue("");
    }
  };

  return (
    <section aria-labelledby="models-enum-detail" className="flex flex-col gap-3">
      <h2 id="models-enum-detail" className="text-title font-semibold">
        {entry.name}
      </h2>
      <p className="text-body text-fg-muted">
        {uses.length === 0
          ? t("models.enumValues.unused")
          : t("models.enumValues.usedBy", {
              fields: uses.map((use) => `${use.field} (${use.types.join(", ") || "—"})`).join(", "),
            })}
      </p>
      <Table caption={t("models.enumValues.caption", { name: entry.name })}>
        <TableHead>
          <TableHeaderCell>{t("models.enumValues.stored")}</TableHeaderCell>
          <TableHeaderCell>{t("models.enumValues.label")}</TableHeaderCell>
          {readOnly ? null : (
            <TableHeaderCell>
              <span className="sr-only">{t("models.enumValues.actions")}</span>
            </TableHeaderCell>
          )}
        </TableHead>
        <TableBody>
          {entry.permissible_values.length === 0 ? (
            <TableEmpty columns={readOnly ? 2 : 3}>{t("models.enumValues.empty")}</TableEmpty>
          ) : (
            entry.permissible_values.map((value) => (
              <TableRow key={value.name}>
                <TableCell primary>
                  <span className="font-mono">{value.name}</span>
                </TableCell>
                <TableCell>
                  {readOnly ? (
                    (value.title?.en ?? "—")
                  ) : (
                    <div className="flex flex-col gap-1">
                      <Input
                        aria-label={t("models.enumValues.labelOf", { value: value.name })}
                        value={value.title?.en ?? ""}
                        // Without a label people read the stored value.
                        placeholder={value.name}
                        onChange={(event) =>
                          run({ op: "setEnumValue", enum: entry.name, value: value.name, field: "title", locale: "en", text: event.target.value })
                        }
                      />
                      <details>
                        <summary className="cursor-pointer text-caption text-fg-muted">{t("models.enumValues.translations")}</summary>
                        <div className="mt-1 flex flex-col gap-2">
                          {others.map((locale) => (
                            <Field key={locale} id={`enum-${entry.name}-${value.name}-title-${locale}`} label={t("models.titleIn", { locale })}>
                              <Input
                                id={`enum-${entry.name}-${value.name}-title-${locale}`}
                                value={value.title?.[locale] ?? ""}
                                onChange={(event) =>
                                  run({ op: "setEnumValue", enum: entry.name, value: value.name, field: "title", locale, text: event.target.value })
                                }
                              />
                            </Field>
                          ))}
                          <Field id={`enum-${entry.name}-${value.name}-description`} label={t("models.description")}>
                            <Input
                              id={`enum-${entry.name}-${value.name}-description`}
                              value={value.description ?? ""}
                              onChange={(event) =>
                                run({ op: "setEnumValue", enum: entry.name, value: value.name, field: "description", text: event.target.value })
                              }
                            />
                          </Field>
                        </div>
                      </details>
                    </div>
                  )}
                </TableCell>
                {readOnly ? null : (
                  <TableCell className="w-px">
                    {/* An icon with its full name: a phone keeps this column, and the row says which value. */}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      aria-label={t("models.removeEnumValue", { value: value.name })}
                      title={t("models.removeEnumValue", { value: value.name })}
                      onClick={() => run({ op: "removeEnumValue", enum: entry.name, value: value.name })}
                    >
                      <Icon name="trash" className="size-4" />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {readOnly ? null : (
        <div className="flex flex-wrap items-start gap-2">
          <Field id={newId} label={t("models.enumValues.new")} help={t("models.enumValues.newHint")}>
            <Input
              id={newId}
              className="w-64 max-w-full"
              value={newValue}
              onChange={(event) => setNewValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") add();
              }}
            />
          </Field>
          <Button size="sm" className="sm:mt-6" onClick={add}>
            {t("models.addValue", { name: entry.name })}
          </Button>
        </div>
      )}
    </section>
  );
}
