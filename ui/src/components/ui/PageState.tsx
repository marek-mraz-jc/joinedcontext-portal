import type { JSX, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import { ApiError } from "../../api/client";
import { Alert } from "./Alert";
import { Button } from "./Button";
import { Icon } from "./icons";
import { PageHeader } from "./PageHeader";
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
        <Skeleton
            key={index}
            // `max-w-96`, not `w-96`: a fixed 384 px line is wider than a 400 px screen once the
            // page's own padding is taken off, so the wait itself scrolled sideways (UI-27,
            // T-2413).
            className={index === lines - 1 ? "h-40 w-full" : "h-4 w-full max-w-96"}
          />
      ))}
    </div>
  );
}

/** Which failure it was, for the words and the one action that fits (T-2747). */
export type FailureKind = "session" | "forbidden" | "notFound" | "server" | "network" | "refused";

export function failureKind(error: unknown): FailureKind {
  if (!(error instanceof ApiError)) return "network";
  if (error.status === 401) return "session";
  if (error.status === 403) return "forbidden";
  if (error.status === 404) return "notFound";
  if (error.status >= 500) return "server";
  return "refused";
}

/**
 * Why the page could not be read, in the API's own sentence, and the one thing to do about it
 * (UI-16, T-2747):
 * - an ended session says so; the Portal's sign-in dialog is already open over the page;
 * - a refusal says who can give access;
 * - a missing object offers the way back the page passes as `back`;
 * - a server failure also names its reference, the edge's request id, to quote when reporting.
 *
 * Retry is offered only where asking again can help, a server failure or a lost connection:
 * a 404, a refusal or a refused request answers the same the second time, so `onRetry` is
 * dropped for them here, once, rather than left to every page to remember (T-2834).
 */
export function PageFailed({
  error,
  onRetry,
  back,
  children,
}: {
  error: unknown;
  onRetry?: () => void;
  /** The way back to where the missing object was listed, as the page's own link. */
  back?: ReactNode;
  /** A sentence to show instead of the API's, where the page knows better (a run that is gone). */
  children?: ReactNode;
}): JSX.Element {
  const { t } = useTranslation();
  const kind = failureKind(error);
  const said = error instanceof ApiError ? (error.problem?.detail ?? error.message) : undefined;
  const reason =
    children ??
    (kind === "network" ? t("app.error.generic") : kind === "session" ? t("app.error.session") : said);
  // After an ended session the sign-in dialog asks every read again itself.
  const retry = kind === "server" || kind === "network" ? onRetry : undefined;
  const reference = kind === "server" && error instanceof ApiError ? error.requestId : undefined;
  return (
    <Alert
      tone="danger"
      actions={
        retry || (kind === "notFound" && back) ? (
          <>
            {kind === "notFound" ? back : null}
            {retry ? (
              <Button size="sm" icon={<Icon name="refresh" className="size-4" />} onClick={retry}>
                {t("app.error.retry")}
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      {reason}
      {kind === "forbidden" ? <span className="mt-1 block">{t("app.error.forbiddenHint")}</span> : null}
      {reference ? (
        <span className="mt-1 block">
          {t("app.error.reference")} <code className="font-mono">{reference}</code>
        </span>
      ) : null}
    </Alert>
  );
}

/**
 * A resource page that could not read its resource (UI-01, UI-15, UI-16, T-2834): the page's own
 * heading and purpose line stay, the API's sentence says why, and the way back to the list is
 * always there, whatever the failure. The heading is the name from the address, which the person
 * typed or followed, so a refusal tells them nothing about whether it exists.
 */
export function ResourcePageFailed({
  title,
  description,
  back,
  error,
  onRetry,
  children,
}: {
  title: ReactNode;
  /** The page's purpose line, the same one it shows when the resource is there. */
  description: ReactNode;
  /** The link to the list the resource belongs to. */
  back: ReactNode;
  error: unknown;
  onRetry?: () => void;
  /** A sentence to show instead of the API's, where the page knows better. */
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      {/* The way back is the header's action, so it is the first stop of the keyboard too. */}
      <PageHeader title={title} description={description} actions={back} />
      <PageFailed error={error} onRetry={onRetry}>
        {children}
      </PageFailed>
    </div>
  );
}
