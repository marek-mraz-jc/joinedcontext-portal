import { useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap } from "../../api/client";
import { asManifests, localized } from "../../api/manifest";
import { operationAreas } from "../../components/AccessWords";
import { DATA_WRITE_OPERATIONS } from "../../components/endpoints/operationGroups";
import { constraintText } from "../../api/access";
import type { GrantDocument, GrantEntry } from "../../api/access";
import {
  Badge,
  Field,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Term,
} from "../../components/ui";

/** The actions that change context data, by the Portal's one list of them (R8, T-5592). */
export function writesOf(actions: string[]): string[] {
  return actions.filter((action) => DATA_WRITE_OPERATIONS.has(action));
}

export function readsOf(actions: string[]): string[] {
  return actions.filter((action) => !DATA_WRITE_OPERATIONS.has(action));
}

function ConstraintList({ entry }: { entry: GrantEntry }): JSX.Element {
  const { t } = useTranslation();
  const residual = Object.entries(entry.constraints ?? {}).filter(([, value]) => Boolean(value));
  if (residual.length === 0) {
    return <span className="text-body text-fg-muted">{t("access.matrix.unconstrained")}</span>;
  }
  return (
    <ul className="space-y-1">
      {residual.map(([name, value]) => (
        <li key={name} className="font-mono text-caption">
          <span className="text-fg-muted">{name}=</span>
          {constraintText(value)}
        </li>
      ))}
    </ul>
  );
}

function GrantTable({ entries, caption }: { entries: GrantEntry[]; caption: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <Table caption={caption}>
      <TableHead>
        <TableHeaderCell>
          <Term name="entityType">{t("access.matrix.type")}</Term>
        </TableHeaderCell>
        <TableHeaderCell>{t("access.matrix.read")}</TableHeaderCell>
        <TableHeaderCell>{t("access.matrix.write")}</TableHeaderCell>
        <TableHeaderCell>{t("access.matrix.attributes")}</TableHeaderCell>
        <TableHeaderCell>{t("access.matrix.residual")}</TableHeaderCell>
      </TableHead>
      <TableBody>
        {entries.map((entry, index) => {
          const actions = entry.actions ?? [];
          const reads = readsOf(actions);
          const writes = writesOf(actions);
          const attributes = entry.attributes;
          return (
            <TableRow key={`${entry.resource?.type ?? "?"}-${index}`}>
              <th scope="row" className="px-4 py-3 text-left font-medium text-fg">
                {entry.resource?.type ?? "?"}
                {entry.resource?.idPatterns?.length ? (
                  <div className="font-mono text-caption font-normal text-fg-muted">
                    {entry.resource.idPatterns.join(", ")}
                  </div>
                ) : null}
              </th>
              <TableCell>
                {reads.length === 0 ? (
                  <span className="text-fg-subtle">{t("access.matrix.none")}</span>
                ) : (
                  <ul className="flex flex-wrap gap-1">
                    {/* By area, the CIM 009 names on hover and to a screen reader (T-4990). */}
                    {operationAreas(reads).areas.map(({ area, operations }) => (
                      <li key={area} title={operations.join(", ")}>
                        <Badge>{t(`access.words.area.${area}`)}</Badge>
                        <span className="sr-only"> ({operations.join(", ")})</span>
                      </li>
                    ))}
                    {operationAreas(reads).other.map((action) => (
                      <li key={action}>
                        <Badge mono>{action}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </TableCell>
              <TableCell>
                {writes.length === 0 ? (
                  <span className="text-fg-subtle">{t("access.matrix.none")}</span>
                ) : (
                  <ul className="flex flex-wrap gap-1">
                    {/* By area, the CIM 009 names on hover and to a screen reader (T-4990). */}
                    {operationAreas(writes).areas.map(({ area, operations }) => (
                      <li key={area} title={operations.join(", ")}>
                        <Badge tone="warning">{t(`access.words.area.${area}`)}</Badge>
                        <span className="sr-only"> ({operations.join(", ")})</span>
                      </li>
                    ))}
                    {operationAreas(writes).other.map((action) => (
                      <li key={action}>
                        <Badge mono tone="warning">{action}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </TableCell>
              <TableCell>
                {attributes === "*" || attributes === undefined ? (
                  <span>{t("access.matrix.allAttributes")}</span>
                ) : (
                  <ul className="flex flex-wrap gap-1">
                    {attributes.map((attribute) => (
                      <li key={attribute} className="font-mono text-caption">
                        {attribute}
                      </li>
                    ))}
                  </ul>
                )}
              </TableCell>
              <TableCell>
                <ConstraintList entry={entry} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * What the signed-in person may do through one endpoint, read from that endpoint's own `/access`
 * surface. The Portal never computes this a second time: the document comes from the PDP that
 * enforces the requests, so the table and the gateway can never disagree (EP-60).
 */
export function EffectivePermissions({ project }: { project: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "sk";
  const [slug, setSlug] = useState<string | null>(null);

  const endpoints = useQuery({
    queryKey: queryKeys.list(project, "endpoints"),
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project, plural: "endpoints" } },
        }),
      ),
  });

  const published = asManifests(endpoints.data?.items ?? []).filter(
    (endpoint) => typeof (endpoint.spec as { slug?: string }).slug === "string",
  );
  const selected = slug ?? (published[0]?.spec as { slug?: string } | undefined)?.slug ?? null;

  const grants = useQuery({
    queryKey: ["access", project, selected],
    enabled: selected !== null,
    retry: false,
    queryFn: async (): Promise<GrantDocument> => {
      // The gateway's own surface, not a Portal route: one document, one implementation (EP-60).
      const response = await fetch(`/api/endpoint/${encodeURIComponent(selected ?? "")}/access`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new ApiError(response.status, `HTTP ${response.status}`);
      }
      return (await response.json()) as GrantDocument;
    },
  });

  return (
    <section className="space-y-4" aria-labelledby="effective-permissions-heading">
      <h2 id="effective-permissions-heading" className="text-title font-semibold text-fg">
        {t("access.matrix.title")}
      </h2>
      <p className="text-body text-fg-muted">{t("access.matrix.hint")}</p>

      {published.length === 0 ? (
        <p className="text-body text-fg-muted">{t("access.matrix.noEndpoint")}</p>
      ) : (
        <Field id="effective-permissions-endpoint" label={t("access.matrix.endpoint")} className="max-w-md">
          <Select
            id="effective-permissions-endpoint"
            value={selected ?? ""}
            onChange={(event) => setSlug(event.target.value)}
          >
            {published.map((endpoint) => (
              <option
                key={endpoint.metadata.name}
                value={(endpoint.spec as { slug?: string }).slug}
              >
                {localized(endpoint.metadata.title, locale, endpoint.metadata.name)}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {grants.isError ? (
        <p role="status" className="text-body text-fg-muted">
          {grants.error instanceof ApiError && grants.error.status === 403
            ? t("access.matrix.forbidden")
            : t("access.matrix.unavailable")}
        </p>
      ) : null}

      {grants.isPending && selected !== null ? <p role="status">{t("app.loading")}</p> : null}

      {grants.data ? (
        <>
          <p className="text-body">
            {t("access.matrix.subject", {
              subject: grants.data.subject?.id ?? t("access.matrix.anonymous"),
              space: grants.data.resource?.space ?? "",
            })}
          </p>
          {(grants.data.permissions ?? []).length === 0 ? (
            <p className="text-body text-fg-muted">{t("access.matrix.empty")}</p>
          ) : (
            <GrantTable
              entries={grants.data.permissions ?? []}
              caption={t("access.matrix.title")}
            />
          )}
          {(grants.data.prohibitions ?? []).length > 0 ? (
            <>
              <h3 className="text-title font-medium text-fg">{t("access.matrix.prohibitions")}</h3>
              <GrantTable
                entries={grants.data.prohibitions ?? []}
                caption={t("access.matrix.prohibitions")}
              />
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
