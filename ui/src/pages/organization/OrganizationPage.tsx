import { useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap } from "../../api/client";
import { asManifests, localized, ORG_NAMESPACE } from "../../api/manifest";
import { mayRead, useAdministers, usePermissions } from "../../api/permissions";
import { useProjects } from "../../api/projects";
import { DeleteProjectAction } from "../../components/DeleteProjectDialog";
import { ExportButton } from "../../components/export/ExportButton";
import { ImportProjectDialog } from "../../components/ImportProjectDialog";
import { NewProjectButton } from "../../components/layout/NewProject";
import {
  Alert,
  Button,
  buttonClass,
  EmptyState,
  Icon,
  PageHeader,
  PageLoading,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableSkeleton,
  Tabs,
  tabPanelProps,
} from "../../components/ui";
import { Groups } from "../access/Groups";
import { RoleBindings } from "../access/RoleBindings";
import { Roles } from "../access/Roles";
import { ServiceAccounts } from "../access/ServiceAccounts";
import { OrganizationSettings } from "./OrganizationSettings";
import { OrganizationSetup, SetupReminder } from "./OrganizationSetup";
import { People } from "./People";
import { ValidationHealth } from "./ValidationHealth";

/** The tabs of `/organization/{tab}`, in the order Architecture/09 §14.1 lists them. */
export const ORGANIZATION_TABS = [
  "settings",
  "people",
  "members",
  "roles",
  "groups",
  "service-accounts",
  "projects",
  "setup",
  "health",
] as const;

export type OrganizationTab = (typeof ORGANIZATION_TABS)[number];

export function isOrganizationTab(value: string): value is OrganizationTab {
  return (ORGANIZATION_TABS as readonly string[]).includes(value);
}

/**
 * Organization → Members (PF-59, T-2605): the bindings at organization scope, shown only to a
 * person who reads `RoleBinding` there. Anybody else is told who can, and no binding is fetched
 * for them at all: the list waits for the permissions document instead of guessing.
 */
function OrganizationMembers(): JSX.Element {
  const { t } = useTranslation();
  const permissions = usePermissions(ORG_NAMESPACE);
  const reads = mayRead(permissions.data, "RoleBinding");
  if (permissions.isLoading) {
    return (
      <p role="status" className="text-body text-fg-muted">
        {t("app.loading")}
      </p>
    );
  }
  if (reads !== true) {
    return (
      <section className="space-y-4" aria-labelledby="organization-members-heading">
        <h2 id="organization-members-heading" className="text-title font-semibold text-fg">
          {t("organization.members.title")}
        </h2>
        <Alert tone="info">{t("organization.members.hidden")}</Alert>
      </section>
    );
  }
  return <RoleBindings project={ORG_NAMESPACE} scope="organization" />;
}

interface ScopedBinding {
  scope?: { project?: string; contextSpace?: string; organization?: string };
  subjects?: unknown[];
}

/**
 * Organization → Projects (PF-65, PF-66, PF-77, T-2605): every project the person may read, its
 * title, how many people and groups are bound in it when the person may read the bindings, and
 * the two actions — open one (the creator's steward binding rides in the same change) and
 * delete one (the cascade listed, the name typed back, a red-lane change).
 */
function OrganizationProjects({ anchor }: { anchor: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";
  const projects = useProjects();
  const permissions = usePermissions(ORG_NAMESPACE);
  const readsBindings = mayRead(permissions.data, "RoleBinding") === true;
  const manifests = useQuery({
    queryKey: queryKeys.list(ORG_NAMESPACE, "projects"),
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project: ORG_NAMESPACE, plural: "projects" } },
        }),
      ),
  });
  const bindings = useQuery({
    queryKey: queryKeys.list(ORG_NAMESPACE, "rolebindings"),
    enabled: readsBindings,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project: ORG_NAMESPACE, plural: "rolebindings" } },
        }),
      ),
  });

  const titles = new Map(
    asManifests(manifests.data?.items ?? []).map((project) => [
      project.metadata.name,
      localized(project.metadata.title, locale, ""),
    ]),
  );
  /** Subjects bound at the project's own scope; a space's bindings name its space, not the project. */
  const bound = (project: string) =>
    asManifests(bindings.data?.items ?? [])
      .map((binding) => binding.spec as ScopedBinding)
      .filter((spec) => spec.scope?.project === project)
      .reduce((sum, spec) => sum + (spec.subjects?.length ?? 0), 0);
  // Every row read "0" (T-2759) while the organization's own members act in every project: they
  // are counted beside the project's own.
  const organizationWide = asManifests(bindings.data?.items ?? [])
    .map((binding) => binding.spec as ScopedBinding)
    .filter((spec) => spec.scope?.organization !== undefined)
    .reduce((sum, spec) => sum + (spec.subjects?.length ?? 0), 0);
  const people = (project: string) =>
    [
      t("organization.projects.own", { count: bound(project) }),
      ...(organizationWide > 0
        ? [t("organization.projects.throughOrganization", { count: organizationWide })]
        : []),
    ].join(" · ");
  const names = projects.data ?? [];
  const [importing, setImporting] = useState(false);

  return (
    <section className="space-y-4" aria-labelledby="organization-projects-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="organization-projects-heading" className="text-title font-semibold text-fg">
            {t("organization.projects.title")}
          </h2>
          <p className="text-body text-fg-muted">{t("organization.projects.lead")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Importing a whole project is here and nowhere else (UI-87). */}
          <Button
            variant="secondary"
            size="sm"
            icon={<Icon name="import" className="size-4" />}
            onClick={() => setImporting(true)}
          >
            {t("projectImport.button")}
          </Button>
          <div className="w-44">
            <NewProjectButton project={anchor} />
          </div>
        </div>
        <ImportProjectDialog open={importing} onOpenChange={setImporting} />
      </div>
      {projects.isError ? (
        <Alert tone="danger" role="alert">
          {projects.error instanceof ApiError
            ? (projects.error.problem?.detail ?? projects.error.message)
            : t("app.error.generic")}
        </Alert>
      ) : (
        <Table
          data-records=""
          caption={t("organization.projects.caption")}
          status={projects.isPending ? t("app.loading") : undefined}
        >
          <TableHead>
            <TableHeaderCell>{t("organization.projects.name")}</TableHeaderCell>
            <TableHeaderCell>{t("organization.projects.people")}</TableHeaderCell>
            <TableHeaderCell align="right">{t("approvals.actions")}</TableHeaderCell>
          </TableHead>
          {projects.isPending ? (
            <TableSkeleton columns={3} />
          ) : (
            <TableBody>
              {names.length === 0 ? (
                <TableEmpty columns={3}>
                  <EmptyState
                    bare
                    title={t("organization.projects.empty")}
                    description={t("organization.projects.emptyHint")}
                  />
                </TableEmpty>
              ) : (
                names.map((name) => (
                  <TableRow key={name}>
                    <TableCell primary>
                      {/* Underlined like every other link of a list: plain text read as a name
                          one could not open (T-2759). */}
                      <Link
                        data-row-link=""
                        to="/projects/$project/$plural"
                        params={{ project: name, plural: "spaces" }}
                        className="focus-ring rounded-sm font-medium text-primary-soft-fg underline underline-offset-2 hover:no-underline"
                      >
                        {titles.get(name) || name}
                      </Link>
                      {titles.get(name) ? <span className="ml-2 text-caption text-fg-muted">{name}</span> : null}
                    </TableCell>
                    <TableCell>
                      {readsBindings
                        ? bindings.isPending
                          ? t("app.loading")
                          : people(name)
                        : t("organization.projects.peopleHidden")}
                    </TableCell>
                    <TableCell align="right">
                      <span className="inline-flex items-center gap-2">
                        <Link
                          to="/projects/$project/settings"
                          params={{ project: name }}
                          className={buttonClass("secondary", "sm")}
                        >
                          {t("organization.projects.settings")}
                        </Link>
                        {/* The whole project leaves here and nowhere else (UI-87, CC-49). */}
                        <ExportButton
                          project={name}
                          target={{}}
                          label={t("organization.projects.export")}
                          size="sm"
                        />
                        <DeleteProjectAction project={name} />
                      </span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          )}
        </Table>
      )}
    </section>
  );
}

/**
 * The Administration page (T-2605, T-2879, UI-75, Architecture/09 §14.1): what is the same in
 * every project — the Organization manifest, its people, members, roles, groups and service
 * accounts, and the projects with their export and import — one tab per concern at its own
 * address, for organization administrators only. Every write is a proposed `Change`. Anybody
 * else is told whose page it is, and no tab mounts, so none of its data is fetched.
 *
 * `anchor` is the project the shell around the page shows in its menu; nothing on the page
 * belongs to it.
 */
export function OrganizationPage({ tab, anchor }: { tab: OrganizationTab; anchor: string }): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { known, administers } = useAdministers();
  if (!known || !administers) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("organization.title")} />
        {known ? (
          <Alert tone="info">{t("organization.adminOnly")}</Alert>
        ) : (
          <PageLoading label={t("app.loading")} />
        )}
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <PageHeader title={t("organization.title")} description={t("organization.lead")} />
      {tab === "setup" ? null : <SetupReminder />}
      <Tabs
        id="organization"
        label={t("organization.tabsLabel")}
        value={tab}
        onChange={(next) => void navigate({ to: "/organization/$tab", params: { tab: next } })}
        tabs={ORGANIZATION_TABS.map((value) => ({ value, label: t(`organization.tab.${value}`) }))}
      />
      <div {...tabPanelProps("organization", tab)} className="space-y-8">
        {tab === "settings" ? <OrganizationSettings /> : null}
        {tab === "people" ? <People /> : null}
        {tab === "members" ? <OrganizationMembers /> : null}
        {tab === "roles" ? <Roles project={ORG_NAMESPACE} scope="organization" /> : null}
        {tab === "groups" ? <Groups project={ORG_NAMESPACE} /> : null}
        {tab === "service-accounts" ? <ServiceAccounts project={ORG_NAMESPACE} /> : null}
        {tab === "projects" ? <OrganizationProjects anchor={anchor} /> : null}
        {tab === "setup" ? <OrganizationSetup anchor={anchor} /> : null}
        {tab === "health" ? <ValidationHealth /> : null}
      </div>
    </div>
  );
}
