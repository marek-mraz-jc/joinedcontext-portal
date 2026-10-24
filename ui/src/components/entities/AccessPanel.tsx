import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../api/client";
import { readsOf, writesOf } from "../../pages/access/EffectivePermissions";
import { Badge, InlineError } from "../ui";
import type { FilterSlot } from "./filters";

/** One entry of the gateway's AuthZEN permissions document (EP-55, EP-56). */
export interface GrantEntry {
  resource?: { type?: string; id?: string; idPatterns?: string[] };
  actions?: string[];
  attributes?: string[] | "*";
  constraints?: { q?: string; scopeQ?: string; geoQ?: string; temporalQ?: string };
}

export interface GrantDocument {
  subject?: { type?: string; id?: string };
  permissions?: GrantEntry[];
  prohibitions?: GrantEntry[];
}

/** The two decisions worth knowing before a query: a read, and the write a pipeline would do. */
export const CHECKED_ACTIONS = ["queryEntity", "updateAttrs"] as const;

const covers = (entry: GrantEntry, type: string) =>
  entry.resource?.type === type || entry.resource?.type === "*";

/** Whether an entry speaks about reads: it names a read, `*`, or no action at all. */
const aboutReads = (entry: GrantEntry) =>
  entry.actions === undefined || entry.actions.includes("*") || readsOf(entry.actions).length > 0;

/** Whether an entry speaks about writes: it names a write, `*`, or no action at all. */
const aboutWrites = (entry: GrantEntry) =>
  entry.actions === undefined || entry.actions.includes("*") || writesOf(entry.actions).length > 0;

/**
 * The attributes of `slots` the caller may not read for `type`, each with the reason: named
 * by a prohibition of a read, or outside every read grant's attribute list. A grant with `*`
 * denies nothing; a grant or prohibition that names only writes says nothing about reading.
 */
export function deniedAttributes(
  doc: GrantDocument | undefined,
  type: string | undefined,
  slots: FilterSlot[],
  t: (key: string) => string,
): Record<string, string> {
  if (!doc || !type) {
    return {};
  }
  const denied: Record<string, string> = {};
  const grants = (doc.permissions ?? []).filter((entry) => covers(entry, type) && aboutReads(entry));
  const unlimited = grants.some((entry) => entry.attributes === "*" || entry.attributes === undefined);
  const granted = new Set(grants.flatMap((entry) => (Array.isArray(entry.attributes) ? entry.attributes : [])));
  if (grants.length > 0 && !unlimited) {
    for (const slot of slots) {
      if (!granted.has(slot.name)) {
        denied[slot.name] = t("access.panel.attrDenied");
      }
    }
  }
  for (const entry of (doc.prohibitions ?? []).filter((e) => covers(e, type) && aboutReads(e))) {
    for (const attribute of Array.isArray(entry.attributes) ? entry.attributes : []) {
      denied[attribute] = t("access.panel.attrProhibited");
    }
  }
  return denied;
}

async function gatewayFetch(slug: string, path: string, init?: RequestInit): Promise<Response> {
  // A `Request` rather than a URL string, as `api/client.ts` sends: same origin, the user's session.
  const response = await globalThis.fetch(
    new Request(new URL(`/api/endpoint/${encodeURIComponent(slug)}${path}`, window.location.origin), {
      credentials: "same-origin",
      ...init,
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    }),
  );
  if (!response.ok) {
    throw new ApiError(response.status, `HTTP ${response.status}`);
  }
  return response;
}

/** The read of one endpoint's grants for the caller, for `useQuery` and `useQueries` alike. */
export function accessQuery(slug: string | undefined) {
  return {
    queryKey: ["access", slug],
    enabled: Boolean(slug),
    retry: false,
    // Nothing of one person's grants outlives their page (R17): no reuse across a sign-in.
    gcTime: 0,
    queryFn: async () => (await (await gatewayFetch(slug!, "/access")).json()) as GrantDocument,
  };
}

/** The caller's grants on one endpoint, read with their session and kept for this page only. */
export function useAccess(slug: string | undefined) {
  return useQuery(accessQuery(slug));
}

/**
 * The attributes of `slots` the caller may correct in place on `type`: the model's own slots,
 * minus what the grant hides, and only where a grant names a write on this type. An edit cell is
 * offered only when the grant says yes: a cell that takes a value the endpoint will refuse loses
 * the person's typing (UI-67). The gateway still decides every write; this only spares the person
 * an editor they cannot use.
 */
/**
 * Whether a grant lets its caller delete entities of `type` (T-4883): a permission covering the
 * type names `deleteEntity` and no prohibition covering it names it. The gateway's Policy still
 * decides each delete; this only keeps a button from offering what will be refused.
 */
export function mayDelete(doc: GrantDocument | undefined, type: string): boolean {
  const names = (entry: GrantEntry) =>
    (entry.resource?.type === undefined || covers(entry, type)) && (entry.actions ?? []).includes("deleteEntity");
  return (doc?.permissions ?? []).some(names) && !(doc?.prohibitions ?? []).some(names);
}

export function editableAttributes(
  doc: GrantDocument | undefined,
  type: string | undefined,
  slots: FilterSlot[],
  denied: Record<string, string>,
): string[] {
  const grants = (doc?.permissions ?? []).filter(
    (entry) =>
      (entry.resource?.type === undefined || entry.resource.type === type || entry.resource.type === "*") &&
      writesOf(entry.actions ?? []).length > 0,
  );
  // The gateway refuses every write an applicable prohibition covers by type, whatever
  // attributes it names (pdp/evaluator.rs covers_request, T-5586): no cell is offered then.
  const prohibited = (doc?.prohibitions ?? []).some(
    (entry) => (entry.resource?.type === undefined || (type !== undefined && covers(entry, type))) && aboutWrites(entry),
  );
  if (!type || grants.length === 0 || prohibited) {
    return [];
  }
  const named = new Set(grants.flatMap((entry) => (Array.isArray(entry.attributes) ? entry.attributes : [])));
  const unlimited = grants.some((entry) => entry.attributes === "*" || entry.attributes === undefined);
  // A formula field is its pipeline's to write (DM-80): shown, never edited in place.
  return slots
    .filter((slot) => !slot.formula)
    .map((slot) => slot.name)
    .filter((attr) => !denied[attr] && (unlimited || named.has(attr)));
}

/**
 * "Your access" (T-0529, UI-33, R51): what the endpoint's own PDP says the caller may do with
 * the chosen type, and the dry-run decisions for the current query, before it runs.
 */
export function AccessPanel({
  slug,
  type,
  access,
}: {
  slug: string | undefined;
  type: string | undefined;
  access: ReturnType<typeof useAccess>;
}): JSX.Element | null {
  const { t } = useTranslation();
  const checks = useQuery({
    queryKey: ["access-check", slug, type],
    enabled: Boolean(slug && type),
    retry: false,
    gcTime: 0,
    queryFn: async () =>
      Promise.all(
        CHECKED_ACTIONS.map(async (action) => {
          const response = await gatewayFetch(slug!, "/access/check", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: { name: action }, resource: { type } }),
          });
          const body = (await response.json()) as { decision?: boolean };
          return { action, decision: body.decision === true };
        }),
      ),
  });

  if (!slug) {
    return null;
  }
  const entries = (access.data?.permissions ?? []).filter((entry) => !type || covers(entry, type));
  const prohibited = (access.data?.prohibitions ?? []).filter((entry) => !type || covers(entry, type));

  return (
    <section aria-labelledby="access-panel" className="rounded-md border border-border bg-surface p-3 text-caption">
      <h2 id="access-panel" className="text-body font-semibold text-fg">
        {t("access.panel.title")}
      </h2>
      {access.isError ? (
        <p role="status" className="text-fg-muted">
          {access.error instanceof ApiError && access.error.status === 403
            ? t("access.matrix.forbidden")
            : t("access.matrix.unavailable")}
        </p>
      ) : null}
      {access.data && !type ? <p className="text-fg-muted">{t("access.panel.chooseType")}</p> : null}
      {access.data && type ? (
        <div className="flex flex-col gap-2">
          {entries.length === 0 ? (
            <p className="text-fg-muted">{t("access.panel.typeNotGranted", { type })}</p>
          ) : null}
          {/* The decisions say it in words; the operation names of the grant are for whoever
              writes the Policy, behind a disclosure (T-4264, T-4160 #18). */}
          {entries.length > 0 || prohibited.length > 0 ? (
            <details className="order-last">
              <summary className="cursor-pointer text-fg-muted">{t("access.panel.technical")}</summary>
              <div className="mt-1 flex flex-col gap-1">
                {entries.length === 0 ? null : (
                  <ul className="flex flex-col gap-1">
                    {entries.map((entry, index) => (
                      <li key={index} className="flex flex-wrap items-center gap-2">
                        <span className="font-mono">{entry.resource?.type}</span>
                        <span>
                          {t("access.matrix.read")}: {readsOf(entry.actions ?? []).join(", ") || t("access.matrix.none")}
                        </span>
                        <span>
                          {t("access.matrix.write")}: {writesOf(entry.actions ?? []).join(", ") || t("access.matrix.none")}
                        </span>
                        <span>
                          {t("access.matrix.attributes")}:{" "}
                          {Array.isArray(entry.attributes) ? entry.attributes.join(", ") : t("access.matrix.allAttributes")}
                        </span>
                        {Object.entries(entry.constraints ?? {})
                          .filter(([, value]) => Boolean(value))
                          .map(([name, value]) => (
                            <span key={name} className="font-mono text-fg-muted">
                              {name}={value}
                            </span>
                          ))}
                      </li>
                    ))}
                  </ul>
                )}
                {prohibited.length > 0 ? (
                  <p className="text-fg-muted">
                    {t("access.matrix.prohibitions")}:{" "}
                    {prohibited
                      .map((entry) => `${entry.resource?.type ?? "*"} ${(entry.actions ?? []).join(", ")}`)
                      .join("; ")}
                  </p>
                ) : null}
              </div>
            </details>
          ) : null}
          {/* A check that could not be made is not a check still running (T-1763): the chips
              used to sit on "checking…" for good when the gateway refused the question, which
              reads as "any moment now" and is the opposite of what happened. */}
          {checks.isError ? (
            <InlineError>
              {t("access.panel.checkFailed", {
                reason:
                  checks.error instanceof Error ? checks.error.message : t("app.error.generic"),
              })}
            </InlineError>
          ) : (
            <ul className="flex flex-wrap gap-2" aria-label={t("access.panel.checks")}>
              {(checks.data ?? CHECKED_ACTIONS.map((action) => ({ action, decision: undefined }))).map(
                (check) => (
                  <li key={check.action}>
                    <Badge
                      tone={check.decision === undefined ? "neutral" : check.decision ? "success" : "danger"}
                    >
                      {check.decision === undefined
                        ? t("access.panel.checking", { action: t(`access.panel.actions.${check.action}`) })
                        : check.decision
                          ? t("access.panel.may", { action: t(`access.panel.actions.${check.action}`), type })
                          : t("access.panel.mayNot", { action: t(`access.panel.actions.${check.action}`), type })}
                    </Badge>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
