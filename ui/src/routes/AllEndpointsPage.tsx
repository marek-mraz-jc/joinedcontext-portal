import { useState } from "react";
import type { JSX } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap } from "../api/client";
import { asManifests, localized } from "../api/manifest";
import {
  ENDPOINT_LINKS,
  EndpointLink,
  endpointUrl,
  REPRESENTATION_PATHS,
  representationUrl,
  servedRepresentations,
  useCatalogueLinks,
} from "../components/endpoints/links";
import { useProjects } from "../api/projects";
import { useBranding } from "../branding";
import { DeleteResourceAction } from "../components/DeleteResourceDialog";
import { PermissionGuard } from "../components/ui/PermissionGuard";
import { CkanAccessPanel } from "../pages/ckan/CkanAccessPanel";
import { SharedWithBadge, spaceOf } from "../components/endpoints/sharing";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Icon,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableSkeleton,
  Term,
} from "../components/ui";

const COLUMNS = 6;

/**
 * Every Endpoint of every project in one table (EP-08, EP-44, PF-61): the project and space it
 * publishes, its audience, and one direct link per representation. It is the Organization page's
 * Endpoints tab, for administrators of the organization only (T-2877); the organization-level
 * route answers it in one request and refuses everyone else with `404`.
 */
export function AllEndpointsPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const { domain } = useBranding();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "sk";
  const endpoints = useQuery({
    queryKey: queryKeys.allEndpoints(),
    queryFn: async () => unwrap(await api.GET("/api/v1/endpoints")),
  });
  // Only the projects that publish an Endpoint are asked for their catalogues.
  const catalogueLink = useCatalogueLinks(
    asManifests(endpoints.data?.items ?? [])
      .filter((endpoint) => (endpoint.spec as { publish?: { ckan?: unknown } }).publish?.ckan)
      .map((endpoint) => endpoint.metadata.namespace ?? ""),
  );

  const head = (
    <TableHead>
      <TableHeaderCell>{t("allEndpoints.field.project")}</TableHeaderCell>
      <TableHeaderCell>
        <Term name="contextSpace">{t("allEndpoints.field.space")}</Term>
      </TableHeaderCell>
      <TableHeaderCell>{t("endpoints.field.name")}</TableHeaderCell>
      <TableHeaderCell>{t("endpoints.field.audience")}</TableHeaderCell>
      <TableHeaderCell>{t("endpoints.field.representations")}</TableHeaderCell>
      <TableHeaderCell align="right">
        <span className="sr-only">{t("approvals.actions")}</span>
      </TableHeaderCell>
    </TableHead>
  );
  const header = (
    <div>
      <h2 id="all-endpoints-heading" className="text-title font-semibold text-fg">
        {t("allEndpoints.title")}
      </h2>
      <p className="text-body text-fg-muted">{t("allEndpoints.lead")}</p>
    </div>
  );

  if (endpoints.isPending) {
    return (
      <div className="flex flex-col gap-section">
        {header}
        <Table caption={t("allEndpoints.title")} status={t("app.loading")}>
          {head}
          <TableSkeleton columns={COLUMNS} />
        </Table>
      </div>
    );
  }

  const failed = endpoints.isError ? endpoints : null;
  if (failed) {
    const message =
      failed.error instanceof ApiError
        ? (failed.error.problem?.detail ?? failed.error.message)
        : t("app.error.generic");
    return (
      <div className="flex flex-col gap-section">
        {header}
        <Alert
          role="alert"
          tone="danger"
          actions={
            <Button
              size="sm"
              icon={<Icon name="refresh" className="size-4" />}
              onClick={() => {
                void failed.refetch();
              }}
            >
              {t("app.error.retry")}
            </Button>
          }
        >
          {message}
        </Alert>
      </div>
    );
  }

  const rows = asManifests(endpoints.data?.items ?? []).map((endpoint) => ({
    // The project is the manifest's own namespace, which is what the route answers with.
    project: endpoint.metadata.namespace ?? "",
    endpoint,
  }));

  return (
    <div className="flex flex-col gap-section">
      {header}
      <Table caption={t("allEndpoints.title")}>
        {head}
        <TableBody>
          {rows.length === 0 ? (
            <TableEmpty columns={COLUMNS}>
              <EmptyState bare
            icon="endpoints"
            title={t("allEndpoints.empty")}
            description={t("allEndpoints.emptyHint")} />
            </TableEmpty>
          ) : (
            rows.map(({ project, endpoint }) => {
              const spec = endpoint.spec as {
                slug?: string;
                audience?: string;
                enabledRepresentations?: string[];
              };
              const space = spaceOf(endpoint);
              const slug = spec.slug ?? "";
              const key = `${project}/${endpoint.metadata.name}`;
              const catalogue = catalogueLink(project, endpoint);
              return (
                <TableRow key={key}>
                  <TableCell>
                    <Link
                      to="/projects/$project/$plural"
                      params={{ project, plural: "endpoints" }}
                      className="focus-ring rounded-sm font-medium text-fg hover:underline"
                    >
                      {project}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {space ? (
                      <div className="flex flex-col gap-0.5">
                        <span className="font-mono text-body text-fg">{space}</span>
                        <Link
                          to="/projects/$project/$plural/$name"
                          params={{ plural: "spaces", project, name: space }}
                          aria-label={`${t("spaces.inside.open")}: ${project}/${space}`}
                          className="focus-ring inline-flex items-center gap-1 rounded-sm text-caption text-primary-soft-fg hover:underline"
                        >
                          {t("spaces.inside.open")}
                          <Icon name="chevronRight" className="size-3.5" />
                        </Link>
                      </div>
                    ) : (
                      <span className="text-fg-subtle">—</span>
                    )}
                  </TableCell>
                  <TableCell primary>
                    <div>{localized(endpoint.metadata.title, locale, endpoint.metadata.name)}</div>
                    {endpoint.metadata.title ? (
                      <div className="mt-0.5 font-mono text-caption text-fg-subtle">
                        {endpoint.metadata.name}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <SharedWithBadge endpoint={endpoint} />
                  </TableCell>
                  <TableCell>
                    <ul className="flex flex-wrap gap-1">
                      {servedRepresentations(spec).map((rep) => (
                        <li key={rep}>
                          {slug && REPRESENTATION_PATHS[rep] ? (
                            <EndpointLink href={representationUrl(slug, rep, domain)}>
                              {rep}
                            </EndpointLink>
                          ) : (
                            <Badge mono>{rep}</Badge>
                          )}
                        </li>
                      ))}
                    </ul>
                    {slug ? (
                      <ul className="mt-1.5 flex flex-wrap gap-1">
                        {ENDPOINT_LINKS.map((link) => (
                          <li key={link.key}>
                            <EndpointLink muted href={endpointUrl(slug, link.path)}>
                              {t(`endpoints.link.${link.key}`)}
                            </EndpointLink>
                          </li>
                        ))}
                        {catalogue ? (
                          <li>
                            <EndpointLink muted href={catalogue}>
                              {t("endpoints.link.catalogue")}
                            </EndpointLink>
                          </li>
                        ) : null}
                      </ul>
                    ) : null}
                  </TableCell>
                  <TableCell align="right">
                    {spec.audience === "public" ? (
                      <PublicEndpointActions project={project} name={endpoint.metadata.name} />
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
      <CkanInstancesAccess />
    </div>
  );
}

/**
 * What the project's own Endpoint page offers on a public Endpoint, here for every project
 * (PF-61): edit it (its audience and publication are fields of the form) and delete it. Each is
 * a Change in that project's repository through the project's own doors, in its normal lane.
 */
function PublicEndpointActions({ project, name }: { project: string; name: string }): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <span className="inline-flex items-center gap-1.5">
      <PermissionGuard project={project} kind="Endpoint" verb="propose">
        <Button
          size="sm"
          variant="secondary"
          aria-label={t("allEndpoints.edit", { project, name })}
          onClick={() =>
            void navigate({
              to: "/projects/$project/$plural/$name/edit",
              params: { project, plural: "endpoints", name },
            })
          }
        >
          {t("allEndpoints.editShort")}
        </Button>
      </PermissionGuard>
      <DeleteResourceAction target={{ project, kind: "Endpoint", plural: "endpoints", name, label: `${project}/${name}` }} />
    </span>
  );
}

/**
 * Every CKAN instance of every project, each with its Access panel (PF-107): who may manage it,
 * and the one step that hands it to a group or a person. Nothing is fetched until the
 * administrator asks for the list, and a panel loads when it is opened.
 */
function CkanInstancesAccess(): JSX.Element {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  return (
    <section aria-labelledby="all-ckan-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="all-ckan-heading" className="text-title font-semibold text-fg">
          {t("allEndpoints.ckan.title")}
        </h2>
        <p className="text-body text-fg-muted">{t("allEndpoints.ckan.lead")}</p>
      </div>
      <div>
        <Button
          size="sm"
          variant="secondary"
          aria-expanded={shown}
          aria-controls="all-ckan-list"
          onClick={() => setShown((current) => !current)}
        >
          {shown ? t("allEndpoints.ckan.hide") : t("allEndpoints.ckan.show")}
        </Button>
      </div>
      <div id="all-ckan-list">{shown ? <CkanInstancesList /> : null}</div>
    </section>
  );
}

function CkanInstancesList(): JSX.Element {
  const { t } = useTranslation();
  const projects = useProjects();
  const lists = useQueries({
    queries: (projects.data ?? []).map((project) => ({
      queryKey: queryKeys.list(project, "ckaninstances"),
      queryFn: async () =>
        unwrap(
          await api.GET("/api/v1/projects/{project}/{plural}", {
            params: { path: { project, plural: "ckaninstances" } },
          }),
        ),
    })),
  });
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const byProject = new Map(
    lists.map((query, index) => [
      (projects.data ?? [])[index] ?? "",
      asManifests(query.data?.items ?? []).map((instance) => instance.metadata.name),
    ]),
  );
  const instances = [...byProject].flatMap(([project, names]) => names.map((name) => ({ project, name })));
  const failed = projects.isError ? projects : lists.find((query) => query.isError);
  if (failed) {
    return (
      <Alert role="alert" tone="danger">
        {failed.error instanceof ApiError
          ? (failed.error.problem?.detail ?? failed.error.message)
          : t("app.error.generic")}
      </Alert>
    );
  }
  if (projects.isPending || lists.some((query) => query.isPending)) {
    return (
      <p role="status" className="text-body text-fg-muted">
        {t("app.loading")}
      </p>
    );
  }
  if (instances.length === 0) {
    return <p className="text-body text-fg-muted">{t("allEndpoints.ckan.empty")}</p>;
  }
  return (
    <ul className="flex flex-col gap-2" aria-label={t("allEndpoints.ckan.title")}>
      {instances.map(({ project, name }) => {
        const key = `${project}/${name}`;
        return (
          <li key={key}>
            <details
              onToggle={(event) => {
                const opened = event.currentTarget.open;
                setOpen((current) => {
                  const next = new Set(current);
                  if (opened) next.add(key);
                  else next.delete(key);
                  return next;
                });
              }}
            >
              <summary className="focus-ring cursor-pointer rounded-sm font-medium text-fg">
                {t("allEndpoints.ckan.instance", { project, name })}
              </summary>
              {open.has(key) ? (
                <div className="mt-2">
                  <CkanAccessPanel project={project} instance={name} known={byProject.get(project) ?? []} />
                </div>
              ) : null}
            </details>
          </li>
        );
      })}
    </ul>
  );
}
