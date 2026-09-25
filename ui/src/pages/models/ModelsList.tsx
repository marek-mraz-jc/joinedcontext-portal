/**
 * The Data models page: every DataModel of the project, one row each (DM-61, DM-62, T-2765).
 *
 * It used to open on the Smart Data Models catalogue, and the project's own models were listed
 * nowhere. A row says which space the model belongs to, its version and lifecycle, its classes,
 * when it last changed and what uses it, and opens the model's own page. Creating one is an
 * action here, never the landing page: blank, from a file, or from Smart Data Models, each of
 * which opens the editor (`?new=…`), which asks for the space first.
 */
import { Fragment, useMemo, useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, queryKeys, unwrap, whilePending } from "../../api/client";
import { asManifests, localized } from "../../api/manifest";
import type { Manifest } from "../../api/manifest";
import { ListFailed, reasonOf } from "../../components/forms/widgets/ListFailed";
import { usePermissions } from "../../api/permissions";
import {
  Badge,
  EmptyState,
  Field,
  Input,
  Button,
  PageHeader,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  buttonClass,
} from "../../components/ui";
import type { ButtonVariant } from "../../components/ui";
import { entityTypesOf } from "../spaces/SpaceInside";
import { spaceOfModel, usageCounts, usesOfModel } from "./modelUsage";
import type { ProjectManifests, UsingKind } from "./modelUsage";

/** A list's manifests; a module function, so `select` keeps its answer while the list stands still. */
function manifestsOf(list: { items?: Parameters<typeof asManifests>[0] }): Manifest[] {
  return asManifests(list.items ?? []);
}

/** One project list, cached under the key every page that lists the kind shares (T-0625). */
export function useProjectList(project: string, plural: string): UseQueryResult<Manifest[]> {
  return useQuery({
    queryKey: queryKeys.list(project, plural),
    // A change on its way polls until it lands (T-1392).
    refetchInterval: whilePending,
    retry: false,
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/projects/{project}/{plural}", { params: { path: { project, plural } } })),
    select: manifestsOf,
  });
}

/** The lists `usesOfModel` reads, loaded side by side; a list that failed is left out. */
export function useProjectManifests(project: string): ProjectManifests {
  const spaces = useProjectList(project, "spaces").data;
  const endpoints = useProjectList(project, "endpoints").data;
  const pipelines = useProjectList(project, "pipelines").data;
  const subscriptions = useProjectList(project, "subscriptions").data;
  const apps = useProjectList(project, "apps").data;
  const dashboards = useProjectList(project, "dashboards").data;
  const layers = useProjectList(project, "layers").data;
  const mappings = useProjectList(project, "mappings").data;
  // One object while the lists stand still, so what is computed from it is computed once.
  return useMemo(
    () => ({ spaces, endpoints, pipelines, subscriptions, apps, dashboards, layers, mappings }),
    [spaces, endpoints, pipelines, subscriptions, apps, dashboards, layers, mappings],
  );
}

/** When the reconciler last saw the model change, from its newest condition. */
export function lastChangeOf(model: Manifest): string | undefined {
  const times = (model.status?.conditions ?? [])
    .map((condition) => condition.lastTransitionTime)
    .filter((time): time is string => typeof time === "string" && !Number.isNaN(Date.parse(time)));
  return times.sort().at(-1);
}

/** The "used by" column's kinds: the ones a person builds on a model. */
const COUNTED: readonly UsingKind[] = ["Endpoint", "Pipeline", "App", "Dashboard"];

/**
 * A link that proposes a change to a DataModel (create or edit): a link for a person whose role
 * may propose one, and a disabled button that says why for anyone else (UI-44), since a link
 * cannot be disabled and a person who follows it would only meet the refusal at Save.
 */
export function ProposeLink({
  project,
  search,
  variant = "secondary",
  children,
}: {
  project: string;
  search: { new?: "blank" | "file" | "sdm"; edit?: string; space?: string };
  variant?: ButtonVariant;
  children: string;
}): JSX.Element {
  const { t } = useTranslation();
  const { can } = usePermissions(project);
  if (!can("DataModel", "propose")) {
    return (
      <Button size="sm" variant={variant} disabled disabledReason={t("permissions.denied", { verb: "propose", kind: "DataModel" })}>
        {children}
      </Button>
    );
  }
  return (
    <Link to="/projects/$project/models" params={{ project }} search={search} className={buttonClass(variant, "sm")}>
      {children}
    </Link>
  );
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function ModelsList({ project }: { project: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const models = useProjectList(project, "datamodels");
  const all = useProjectManifests(project);
  const [search, setSearch] = useState("");
  const [space, setSpace] = useState("");

  const rows = useMemo(
    () =>
      (models.data ?? []).map((model) => {
        const title = localized(model.metadata.title, locale, model.metadata.name);
        return {
          model,
          title,
          space: spaceOfModel(model, all.spaces),
          classes: entityTypesOf(model),
          counts: usageCounts(usesOfModel(model, all)),
          changed: lastChangeOf(model),
        };
      }),
    [models.data, all, locale],
  );
  const spaces = useMemo(
    () => [...new Set(rows.map((row) => row.space).filter((one): one is string => one !== undefined))].sort(),
    [rows],
  );
  const needle = search.trim().toLowerCase();
  const shown = rows.filter(
    (row) =>
      (space === "" || row.space === space) &&
      (needle === "" ||
        [row.title, row.model.metadata.name, ...row.classes].some((one) => one.toLowerCase().includes(needle))),
  );
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  const create = (
    <div className="flex flex-wrap gap-2">
      {(["blank", "file", "sdm"] as const).map((way, index) => (
        <ProposeLink key={way} project={project} search={{ new: way }} variant={index === 0 ? "primary" : "secondary"}>
          {t(`models.page.new.${way}`)}
        </ProposeLink>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("models.title")} description={t("models.page.listLead")} actions={create} />

      {models.isError ? (
        <ListFailed
          what={t("nav.models")}
          reason={reasonOf(models.error, t("app.error.generic"))}
          onRetry={() => void models.refetch()}
        />
      ) : models.isPending ? (
        <p role="status" className="text-body text-fg-muted">
          {t("app.loading")}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon="models"
          title={t("models.page.emptyTitle")}
          description={t("models.page.emptyLead")}
          action={create}
        />
      ) : (
        <>
          <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
            <Field id="models-search" label={t("models.page.search")}>
              <Input
                id="models-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </Field>
            <Field id="models-space" label={t("models.field.space")}>
              <Select id="models-space" value={space} onChange={(event) => setSpace(event.target.value)}>
                <option value="">{t("models.page.everySpace")}</option>
                {spaces.map((one) => (
                  <option key={one} value={one}>
                    {one}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Table caption={t("models.page.listCaption")}>
            <TableHead>
              <TableHeaderCell>{t("models.field.name")}</TableHeaderCell>
              <TableHeaderCell>{t("models.field.space")}</TableHeaderCell>
              <TableHeaderCell>{t("models.field.version")}</TableHeaderCell>
              <TableHeaderCell>{t("models.classes")}</TableHeaderCell>
              <TableHeaderCell>{t("models.page.lastChange")}</TableHeaderCell>
              <TableHeaderCell>{t("models.page.usedBy")}</TableHeaderCell>
            </TableHead>
            <TableBody>
              {shown.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6}>{t("models.page.noMatch")}</TableCell>
                </TableRow>
              ) : null}
              {shown.map((row) => {
                const version = text(row.model.spec.version);
                const lifecycle = text(row.model.spec.lifecycle);
                return (
                  <TableRow key={row.model.metadata.name}>
                    <TableCell primary>
                      <Link
                        data-row-link=""
                        to="/projects/$project/models/$name"
                        params={{ project, name: row.model.metadata.name }}
                        className="focus-ring text-primary-soft-fg underline-offset-2 hover:underline"
                      >
                        {row.title}
                      </Link>
                      {row.title !== row.model.metadata.name ? (
                        <span className="block font-mono text-caption text-fg-muted">{row.model.metadata.name}</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {row.space ? (
                        <Link
                          to="/projects/$project/$plural/$name"
                          params={{ project, plural: "spaces", name: row.space }}
                          className="focus-ring text-primary-soft-fg underline-offset-2 hover:underline"
                        >
                          {row.space}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="font-mono">{version ?? "—"}</span>
                      {lifecycle ? (
                        <Badge className="ml-2">{t(`models.lifecycleOption.${lifecycle}`, { defaultValue: lifecycle })}</Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <span className="font-medium">{row.classes.length}</span>
                      {row.classes.length > 0 ? (
                        <span className="block text-caption text-fg-muted">
                          {row.classes.map((klass, index) => (
                            <Fragment key={klass}>
                              {index === 0 ? null : ", "}
                              <Link
                                to="/projects/$project/models/$name"
                                params={{ project, name: row.model.metadata.name }}
                                search={{ class: klass }}
                                className="focus-ring underline-offset-2 hover:underline"
                              >
                                {klass}
                              </Link>
                            </Fragment>
                          ))}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>{row.changed ? date.format(new Date(row.changed)) : "—"}</TableCell>
                    <TableCell>
                      {COUNTED.every((kind) => (row.counts[kind] ?? 0) === 0)
                        ? t("models.page.unused")
                        : COUNTED.filter((kind) => (row.counts[kind] ?? 0) > 0)
                            .map((kind) => t(`models.page.uses.${kind}`, { count: row.counts[kind] }))
                            .join(", ")}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}
