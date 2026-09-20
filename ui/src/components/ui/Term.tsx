import { useId, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";

/** The platform words a page uses without a person having read the specification (UI-45). */
export const TERMS = [
  "endpoint",
  "policy",
  "contextSpace",
  "lane",
  "change",
] as const;

export type TermName = (typeof TERMS)[number];

export interface TermProps {
  /** Which word is explained; its definition lives under `glossary.{name}` in the bundles. */
  name: TermName;
  /** The word as this page writes it. Left out, the bundle's own spelling is used. */
  children?: ReactNode;
  className?: string;
}

/**
 * One domain word with its definition, for the person who meets it for the first time (UI-45).
 *
 * The Portal writes `Endpoint`, `Policy`, `Context Space`, `lane` and `Change` in table headers,
 * labels and headings; `docs/Glossary.md` defines every one of them and nobody reading the
 * screen has it open. A tooltip costs a person nothing and a documentation search costs them
 * the task.
 *
 * **The definition is always in the document**, because `aria-describedby` cannot point at an
 * element that is not rendered: a screen reader hears it whenever the word is read, and a
 * sighted person sees it on hover or on keyboard focus. That is also why the word itself is
 * focusable — a definition only a mouse can open is not an explanation for everybody.
 *
 * A `Term` never goes inside a button or a link: a focusable inside a focusable is unreachable
 * by keyboard in one of the two, and clicking to read a definition would fire the action
 * instead. `tests/term.test.tsx` holds the source to that.
 */
export function Term({ name, children, className }: TermProps): React.JSX.Element {
  const { t } = useTranslation();
  const definitionId = useId();
  const [open, setOpen] = useState(false);

  return (
    <span className={clsx("relative inline-block", className)}>
      <span
        tabIndex={0}
        role="term"
        aria-describedby={definitionId}
        className="focus-ring cursor-help rounded-sm border-b border-dotted border-fg-muted"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            // The definition is a hint, not a dialog: Escape closes it without leaving the field
            // a person was reading, and the word keeps the focus it had.
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        {children ?? t(`glossary.${name}.term`)}
      </span>
      <span
        id={definitionId}
        role="tooltip"
        className={clsx(
          open
            ? "absolute left-0 top-full z-50 mt-1 w-72 rounded-md border border-border bg-surface p-2 text-caption font-normal text-fg shadow-2"
            : "sr-only",
        )}
      >
        {t(`glossary.${name}.definition`)}
      </span>
    </span>
  );
}
