import { createContext, useContext } from "react";
import type { ErrorSchema } from "@rjsf/utils";

/**
 * Which fields may show their errors yet (T-2757, UI-16).
 *
 * rjsf validates the whole form on every change, so typing the first letter of a name turned
 * every required field below it red before anybody had reached it. A field shows its errors once
 * a person changed or left it, and every field does once the form was checked or submitted.
 * `null` outside a SchemaForm: a widget rendered on its own shows what it is given.
 */
export interface Touched {
  all: boolean;
  ids: ReadonlySet<string>;
}

export const TouchedContext = createContext<Touched | null>(null);

/** `errors` when the field `id` (or one inside it) was touched, else nothing. */
export function useShownErrors(id: string, errors: string[] | undefined): string[] | undefined {
  const touched = useContext(TouchedContext);
  if (!errors || errors.length === 0 || touched === null || touched.all) {
    return errors;
  }
  for (const seen of touched.ids) {
    if (seen === id || seen.startsWith(`${id}_`)) {
      return errors;
    }
  }
  return undefined;
}

/** Whether an rjsf error schema names any error at all. */
export function hasAnyError(schema: ErrorSchema | undefined): boolean {
  if (!schema || typeof schema !== "object") {
    return false;
  }
  return Object.entries(schema).some(([key, value]) =>
    key === "__errors"
      ? Array.isArray(value) && value.length > 0
      : hasAnyError(value as ErrorSchema | undefined),
  );
}
