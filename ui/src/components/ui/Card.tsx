import type { HTMLAttributes, ReactNode } from "react";
import { clsx } from "clsx";
import { openRowLink } from "./Table";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** No inner padding: for a table or a map that fills the card edge to edge. */
  flush?: boolean;
}

/** A raised surface with the Portal's border and radius; every panel on a page is one. */
export function Card({ flush, className, children, onClick, onAuxClick, ...rest }: CardProps): React.JSX.Element {
  return (
    <div
      className={clsx(
        "rounded-lg border border-border bg-surface shadow-1 has-[a[data-row-link]]:cursor-pointer",
        !flush && "p-5",
        className,
      )}
      // A card of one record opens it on a click anywhere, as a table row does (T-2875).
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          openRowLink(event);
        }
      }}
      onAuxClick={(event) => {
        onAuxClick?.(event);
        if (!event.defaultPrevented && event.button === 1) {
          openRowLink(event);
        }
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
  as: Heading = "h2",
  titleId,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /**
   * The heading level this card's title sits at. `h2` is right for a card directly under the
   * page's `h1`; a card nested inside a section that already has an `h2` passes `h3`, and a card
   * inside a Dialog — whose Radix title is the heading there — passes `h3` too. Hardcoding `h2`
   * made every nested card skip or repeat a level, which is what `heading-order` reports.
   */
  as?: "h2" | "h3" | "h4";
  /** Set when the surrounding region points `aria-labelledby` at this title. */
  titleId?: string;
}): React.JSX.Element {
  return (
    <div className={clsx("flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <Heading id={titleId} className="text-title font-semibold text-fg">
          {title}
        </Heading>
        {description ? <p className="mt-0.5 text-body text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
