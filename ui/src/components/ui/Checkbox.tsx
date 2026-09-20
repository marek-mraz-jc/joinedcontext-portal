import { forwardRef } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { clsx } from "clsx";
import { CHECKBOX } from "./Input";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** The checkbox is labelled by it; a click on the text ticks the box. */
  label: ReactNode;
  /** A quiet word after the label, such as "required"; part of the accessible name. */
  hint?: ReactNode;
}

/** A native checkbox with its label, so the name, the focus ring and the tick are one style (UI-16). */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, hint, className, disabled, ...rest },
  ref,
) {
  return (
    <label
      className={clsx(
        "inline-flex items-center gap-2 text-body text-fg",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        className,
      )}
    >
      <input ref={ref} type="checkbox" disabled={disabled} className={CHECKBOX} {...rest} />
      <span>{label}</span>
      {hint ? <span className="text-caption text-fg-muted">{hint}</span> : null}
    </label>
  );
});
