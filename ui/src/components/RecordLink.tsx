import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { clsx } from "clsx";

/** Kinds with a page of their own (the router's DETAIL_PAGES); every other kind opens on its edit form. */
const DETAIL = new Set(["spaces", "endpoints", "apps"]);

/**
 * The link to one record: its own page where it has one, else its edit form (T-2875). It is also
 * the row's link — `TableRow` opens it on a click anywhere in the row — so each row renders one.
 */
export function RecordLink({
  project,
  plural,
  name,
  className,
  children,
}: {
  project: string;
  plural: string;
  name: string;
  className?: string;
  children?: ReactNode;
}): React.JSX.Element {
  const style = clsx("focus-ring text-primary-soft-fg underline-offset-2 hover:underline", className);
  return DETAIL.has(plural) ? (
    <Link data-row-link="" to="/projects/$project/$plural/$name" params={{ project, plural, name }} className={style}>
      {children ?? name}
    </Link>
  ) : (
    <Link data-row-link="" to="/projects/$project/$plural/$name/edit" params={{ project, plural, name }} className={style}>
      {children ?? name}
    </Link>
  );
}
