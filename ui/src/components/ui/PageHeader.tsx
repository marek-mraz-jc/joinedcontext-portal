import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { clsx } from "clsx";
import { setPageTitle } from "../../documentTitle";

/** The address the last header mounted on; a header mounting on another one is a route change. */
let lastPath: string | null = null;

/** The project of the address, when the segment is a name and nothing else (UI-16). */
function projectOf(pathname: string): string | undefined {
  return /^\/projects\/([a-z0-9][a-z0-9-]*)(?:\/|$)/.exec(pathname)?.[1];
}

export interface PageHeaderProps {
  title: ReactNode;
  /** One line under the title on what the page manages. */
  description?: ReactNode;
  /** The breadcrumb trail, rendered above the title; the shell provides it. */
  breadcrumb?: ReactNode;
  /** The page's actions; the first is the only primary on the page. */
  actions?: ReactNode;
  /** Anything that sits beside the actions: a quota bar, a filter. */
  aside?: ReactNode;
  className?: string;
}

/** The top of every page: what it is, where it is, and what one can do on it (UI-01). */
export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
  aside,
  className,
}: PageHeaderProps): React.JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null);

  // The tab, the history and the task switcher name the page and the project (UI-15). A title
  // that is not a string is a node this component cannot read, and the installation's name —
  // which `documentTitle` already holds — stays the whole title rather than a wrong page name.
  useEffect(() => {
    if (typeof title === "string") {
      setPageTitle([title, projectOf(window.location.pathname)]);
    }
  }, [title]);

  // A route change moves focus to the heading, so a screen reader says where one has arrived
  // (UI-16). The first page of a visit and a header that mounts again on the same address
  // (loading, then loaded) take nothing from whoever holds the focus.
  useEffect(() => {
    const path = window.location.pathname;
    if (lastPath !== null && lastPath !== path) {
      heading.current?.focus();
    }
    lastPath = path;
  }, []);

  // A div, not a <header>: the shell's top bar is the one banner landmark of the page.
  return (
    <div className={clsx("flex flex-col gap-3", className)}>
      {breadcrumb}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 ref={heading} tabIndex={-1} className="focus-ring rounded-sm text-display font-semibold tracking-tight text-fg">{title}</h1>
          {description ? <p className="mt-1 max-w-prose text-body text-fg-muted">{description}</p> : null}
        </div>
        {actions || aside ? (
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            {aside}
            {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
