import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap } from "../../api/client";
import { asManifests, localized, ORG_NAMESPACE, plainTitle } from "../../api/manifest";
import { usePermissions } from "../../api/permissions";
import type { Rule } from "../../api/permissions";
import { DeleteProjectAction } from "../../components/DeleteProjectDialog";
import { EditResourceAction } from "../../components/EditResourceDialog";
import type { EditableForm } from "../../components/EditResourceDialog";
import { ProjectQuota } from "../../components/ProjectQuota";
import {
  Alert,
  PageHeader,
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
import { projectSchema } from "../../schemas/kinds";
import { EffectivePermissions } from "../access/EffectivePermissions";
import { RoleBindings } from "../access/RoleBindings";
import { Roles } from "../access/Roles";
import { ServiceAccounts } from "../access/ServiceAccounts";

/** The tabs of `/projects/{project}/settings/{tab}`, in the order Architecture/09 §14.2 lists them. */
export const PROJECT_SETTINGS_TABS = [
  "general",
  "members",
  "roles",
  "service-accounts",
  "access",
  "danger",
] as const;

export type ProjectSettingsTab = (typeof PROJECT_SETTINGS_TABS)[number];

export function isProjectSettingsTab(value: string): value is ProjectSettingsTab {
  return (PROJECT_SETTINGS_TABS as readonly string[]).includes(value);
}

interface ProjectManifest {
  metadata?: { name?: string; title?: unknown; description?: unknown };
  spec?: { quotas?: Record<string, number | undefined>; organizationRef?: unknown };
}

/** What General edits of `project.yaml`: its title, its description and its own quotas. */
export function fromProject(manifest: unknown): Record<string, unknown> {
  const project = (manifest ?? {}) as ProjectManifest;
  return {
    title: plainTitle(project.metadata?.title),
    description: plainTitle(project.metadata?.description),
    quotas: project.spec?.quotas ?? {},
  };
}

/**
 * The manifest to propose: the stored one with the title and description in its metadata and the
 * quotas in its spec, so `organizationRef` and every other field stay as they were (T-2470).
 */
export function toProject(form: Record<string, unknown>, stored: unknown): unknown {
  const manifest = { ...((stored ?? {}) as Record<string, unknown>) };
  delete manifest.status;
  const metadata = { ...((manifest.metadata ?? {}) as Record<string, unknown>) };
  const spec = { ...((manifest.spec ?? {}) as Record<string, unknown>) };
  for (const field of ["title", "description"] as const) {
    const value = typeof form[field] === "string" ? (form[field] as string).trim() : "";
    if (value === "") {
      delete metadata[field];
    } else {
      metadata[field] = value;
    }
  }
  const quotas = Object.fromEntries(
    Object.entries((form.quotas ?? {}) as Record<string, unknown>).filter(([, value]) => typeof value === "number"),
  );
  if (Object.keys(quotas).length === 0) {
    delete spec.quotas;
  } else {
    spec.quotas = quotas;
  }
  return { ...manifest, metadata, spec };
}

/**
 * General (PF-17, PF-61): the project's title and description, edited through the kind's form as a
 * proposed change, its quota in use, and — read only — the organization it belongs to and who
 * reads its projects there.
 */
function General({ project }: { project: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";
  const manifest = useQuery({
    queryKey: [...queryKeys.list(ORG_NAMESPACE, "projects"), project],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}/{name}", {
          params: { path: { project: ORG_NAMESPACE, plural: "projects", name: project } },
        }),
      ),
  });
  const organizations = useQuery({
    queryKey: queryKeys.list(ORG_NAMESPACE, "organizations"),
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project: ORG_NAMESPACE, plural: "organizations" } },
        }),
      ),
  });
  const organization = asManifests(organizations.data?.items ?? [])[0];
  const orgSpec = (organization?.spec ?? {}) as { domain?: string; projects?: { visibility?: string } };
  const stored = (manifest.data ?? {}) as ProjectManifest;
  const title = localized(stored.metadata?.title as string | Record<string, string> | undefined, locale, project);
  const description = plainTitle(stored.metadata?.description);
  const form: EditableForm = {
    schema: projectSchema(t),
    fromManifest: fromProject,
    toManifest: toProject,
  };

  return (
    <div className="space-y-8">
      <section className="space-y-4" aria-labelledby="project-general-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="project-general-heading" className="text-title font-semibold text-fg">
              {t("projectSettings.general.title")}
            </h2>
            <p className="text-body text-fg-muted">{t("projectSettings.general.lead")}</p>
          </div>
          {manifest.data ? (
            <EditResourceAction
              target={{
                project,
                home: ORG_NAMESPACE,
                kind: "Project",
                plural: "projects",
                name: project,
                label: title,
              }}
              form={form}
            />
          ) : null}
        </div>
        {manifest.isError ? (
          <Alert tone="danger" role="alert">
            {manifest.error instanceof ApiError
              ? (manifest.error.problem?.detail ?? manifest.error.message)
              : t("app.error.generic")}
          </Alert>
        ) : null}
        <dl className="grid gap-x-6 gap-y-3 text-body sm:grid-cols-[max-content_1fr]">
          <dt className="font-medium text-fg">{t("projectSettings.field.title")}</dt>
          <dd className="text-fg">{manifest.isPending ? t("app.loading") : title}</dd>
          <dt className="font-medium text-fg">{t("projectSettings.field.description")}</dt>
          <dd className="text-fg">
            {manifest.isPending ? t("app.loading") : (description ?? t("projectSettings.general.noDescription"))}
          </dd>
          <dt className="font-medium text-fg">{t("projectSettings.general.organization")}</dt>
          <dd className="text-fg">{orgSpec.domain ?? t("projectSettings.general.unknown")}</dd>
          <dt className="font-medium text-fg">{t("organization.field.visibility")}</dt>
          <dd className="text-fg">
            {t(`organization.visibility.${orgSpec.projects?.visibility === "members" ? "members" : "organization"}`)}
          </dd>
        </dl>
      </section>
      <ProjectQuota project={project} />
    </div>
  );
}

/** One rule of a grant in words: `propose, approve on Pipeline, DataSource`. */
function ruleInWords(rule: Rule, on: string): string {
  return `${(rule.verbs ?? []).join(", ")} ${on} ${(rule.kinds ?? []).join(", ")}`;
}

/**
 * Your access (PF-50, PF-60): what the signed-in person's bindings let them do here, each grant
 * with the binding and the scope it came from, so an inherited grant does not look local. Then the
 * endpoint matrix of the old Access page, the gateway's own answer (EP-60).
 */
function YourAccess({ project }: { project: string }): JSX.Element {
  const { t } = useTranslation();
  const permissions = usePermissions(project);
  const grants = permissions.data?.grants ?? [];
  return (
    <div className="space-y-8">
      <section className="space-y-4" aria-labelledby="your-access-heading">
        <div>
          <h2 id="your-access-heading" className="text-title font-semibold text-fg">
            {t("projectSettings.access.title")}
          </h2>
          <p className="text-body text-fg-muted">{t("projectSettings.access.lead")}</p>
        </div>
        {permissions.data?.bootstrap ? <Alert tone="info">{t("projectSettings.access.bootstrap")}</Alert> : null}
        <Table
          caption={t("projectSettings.access.caption", { project })}
          status={permissions.isLoading ? t("app.loading") : undefined}
        >
          <TableHead>
            <TableHeaderCell>{t("projectSettings.access.role")}</TableHeaderCell>
            <TableHeaderCell>{t("projectSettings.access.allows")}</TableHeaderCell>
            <TableHeaderCell>{t("projectSettings.access.from")}</TableHeaderCell>
          </TableHead>
          {permissions.isLoading ? (
            <TableSkeleton columns={3} />
          ) : (
            <TableBody>
              {grants.length === 0 ? (
                <TableEmpty columns={3}>{t("projectSettings.access.none")}</TableEmpty>
              ) : (
                grants.map((grant, index) => (
                  <TableRow key={`${grant.binding}-${grant.role}-${index}`}>
                    <TableCell primary>{grant.role}</TableCell>
                    <TableCell>{ruleInWords(grant.rule as Rule, t("access.projectRoles.on"))}</TableCell>
                    <TableCell>
                      {t("projectSettings.access.binding", { binding: grant.binding, scope: grant.scope })}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          )}
        </Table>
      </section>
      <EffectivePermissions project={project} />
    </div>
  );
}

/** Delete project (PF-77, PF-78): never one click, the cascade listed in the dialog it opens. */
function Danger({ project }: { project: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <section className="space-y-4" aria-labelledby="project-danger-heading">
      <h2 id="project-danger-heading" className="text-title font-semibold text-fg">
        {t("projectSettings.danger.title")}
      </h2>
      <p className="text-body text-fg-muted">{t("projectSettings.danger.lead")}</p>
      <DeleteProjectAction project={project} variant="danger" />
    </section>
  );
}

/**
 * Project settings (T-2606, UI-76, Architecture/09 §14.2): what belongs to one project — its title
 * and quotas, who is bound in it, its own roles, its service accounts, what the signed-in person
 * may do here, and its deletion. Project → Access folded into it; every write is a proposed change.
 */
export function ProjectSettingsPage({ project, tab }: { project: string; tab: ProjectSettingsTab }): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="space-y-6">
      <PageHeader title={t("projectSettings.title")} description={t("projectSettings.lead", { project })} />
      <Tabs
        id="project-settings"
        label={t("projectSettings.tabsLabel")}
        value={tab}
        onChange={(next) =>
          void navigate({ to: "/projects/$project/settings/$tab", params: { project, tab: next } })
        }
        tabs={PROJECT_SETTINGS_TABS.map((value) => ({ value, label: t(`projectSettings.tab.${value}`) }))}
      />
      <div {...tabPanelProps("project-settings", tab)} className="space-y-8">
        {tab === "general" ? <General project={project} /> : null}
        {tab === "members" ? <RoleBindings project={project} scope="project" /> : null}
        {tab === "roles" ? <Roles project={project} scope="project" /> : null}
        {tab === "service-accounts" ? <ServiceAccounts project={project} /> : null}
        {tab === "access" ? <YourAccess project={project} /> : null}
        {tab === "danger" ? <Danger project={project} /> : null}
      </div>
    </div>
  );
}
