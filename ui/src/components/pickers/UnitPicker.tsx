import { useMemo, useState } from "react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { searchUnits, unitGroup, unitLabel, unitOf } from "../../units";
import type { Unit } from "../../units";
import { Combobox } from "./Combobox";
import type { PickerOption } from "./Combobox";

export interface UnitPickerProps {
  id?: string;
  label: string;
  /** Named by the form's `<label for={id}>` (see `Combobox`). */
  labelled?: boolean;
  /** The chosen Rec 20 code, or empty for none. */
  value: string;
  onChange: (code: string) => void;
  /** Offers "no unit" as the first choice. */
  clearable?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

/**
 * A UN/CEFACT unit from the whole of Recommendation 20 (DM-06): typed as a code (`GQ`), a symbol
 * (`µg/m³`, `ug/m3`), a UCUM code, a name or a quantity kind, the frequent municipal units first
 * and the rest grouped by quantity kind. The list is the platform's one code list.
 */
export function UnitPicker({
  id,
  label,
  labelled,
  value,
  onChange,
  clearable = false,
  disabled,
  invalid,
  describedBy,
}: UnitPickerProps): JSX.Element {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const found = useMemo(() => searchUnits(typed), [typed]);

  const options = useMemo(() => {
    const option = (unit: Unit): PickerOption => ({
      value: unit.code,
      label: unitLabel(unit),
      detail: [unit.ucum ? `UCUM ${unit.ucum}` : "", unit.quantityKinds.join(", ")].filter(Boolean).join(" · "),
      group: unitGroup(unit) ?? t("units.frequent"),
      badge: unit.code,
    });
    const shown = found.units.map(option);
    const chosen = unitOf(value);
    // The chosen unit is always an option, so the box reads its name and not its bare code.
    if (chosen && !found.units.includes(chosen)) shown.push(option(chosen));
    if (clearable && typed.trim() === "") shown.unshift({ value: "", label: t("units.none"), group: t("units.frequent") });
    return shown;
  }, [found, value, clearable, typed, t]);

  return (
    <Combobox
      id={id}
      label={label}
      labelled={labelled}
      // No unit shows as the empty box and its placeholder, so what a person types is the search.
      value={value === "" ? [] : [value]}
      onChange={(values) => {
        setTyped("");
        onChange(values[0] ?? "");
      }}
      options={options}
      searched
      onSearch={setTyped}
      disabled={disabled}
      invalid={invalid}
      describedBy={describedBy}
      placeholder={t("units.search")}
      empty={t("units.noMatch")}
      note={found.total > found.units.length ? t("units.more", { shown: found.units.length, total: found.total }) : undefined}
    />
  );
}
