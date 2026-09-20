import type { JSX, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import { ApiError } from "../../api/client";
import { Alert } from "./Alert";
import { Button } from "./Button";
import { Icon } from "./icons";
import { Skeleton } from "./Skeleton";

/**
 * What a page shows while it waits, and what it shows when it could not be read (UI-15, UI-16).
 *
 * Every page used to write these two states by hand, and wrote them smaller each time: a bare
 * `<p role="status">Loading…</p>` on blank white, then a red line carrying `app.error.generic` —
 * so "you may not read this project" and "the store is away" read identically and neither
 * offered anything to press. The page keeps its own `PageHeader` in all three states; this is
 * only the body under it, so a page does not jump when the answer arrives.
 */

/** The shape of what is coming. The bars are decorative; the wait is announced once, in words. */
export function PageLoading({
  label,
  lines = 2,
  className,
}: {
  /** What is being read, in the page's own words. */
  label: string;
  /** How many bars stand for the content; a page with a large panel says 1 and sizes it itself. */
  lines?: number;
  className?: string;
}): JSX.Element {
  return (
    <div role="status" aria-busy="true" className={clsx("space-y-3", className)}>
      <span className="sr-only">{label}</span>
      <Skeleton className="h-6 w-64" />
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={index === lines - 1 ? "h-40 w-full" : "h-4 w-96"} />
      ))}
    </div>
  );
}

/**
 * Why the page could not be read, in the API's own sentence, and the one thing to do about it.
 *
 * `onRetry` is left out where asking again cannot help — a 404, a refusal that will not change —
 * so the page never offers a button that does nothing.
 */
export function PageFailed({
  error,
  onRetry,
  children,
}: {
  error: unknown;
  onRetry?: () => void;
  /** A sentence to show instead of the API's, where the page knows better (a run that is gone). */
  children?: ReactNode;
}): JSX.Element {
  const { t } = useTranslation();
  const reason =
    children ??
    (error instanceof ApiError
      ? (error.problem?.detail ?? error.message)
      : t("app.error.generic"));
  return (
    <Alert
      tone="danger"
      actions={
        onRetry ? (
          <Button size="sm" icon={<Icon name="refresh" className="size-4" />} onClick={onRetry}>
            {t("app.error.retry")}
          </Button>
        ) : undefined
      }
    >
      {reason}
    </Alert>
  );
}
