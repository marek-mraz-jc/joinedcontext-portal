import { useId, useState } from "react";
import type { JSX } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap } from "../../api/client";
import { asManifests, isChange, ORG_NAMESPACE, storedMetadata } from "../../api/manifest";
import type { Change, Manifest, ResourceProposal } from "../../api/manifest";
import { useProjects } from "../../api/projects";
import { proposeChecked } from "../../api/proposal";
import { useBranding } from "../../branding";
import { ChangeNotice } from "../../components/ChangeNotice";
import { DeleteResourceAction } from "../../components/DeleteResourceDialog";
import { Alert, Button, Field, Input, PageHeader, Select } from "../../components/ui";
import { PermissionGuard } from "../../components/ui/PermissionGuard";
import { asUser, withMember, withoutMember } from "../apps/RolesAndMembers";
import type { RolesSpec } from "../apps/RolesAndMembers";
import {
  appRolesNaming,
  bindingsNaming,
  bindingWithoutGroup,
  groupBinding,
  refusedPlace,
  withGroupMember,
} from "./groupRoles";
import type { Place, RoleChoice } from "./groupRoles";

interface GroupSpec {
  description?: string;
  members?: { user: string }[];
}

interface Scope {
  organization?: string;
  project?: string;
  contextSpace?: string;
}

/** One proposal: the manifest, where it goes, and whether it is new. */
interface Proposal {
  project: string;
  plural: string;
  manifest: Manifest;
  create: boolean;
}

function useList(project: string, plural: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.list(project, plural),
    enabled,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project, plural } },
        }),
      ),
  });
}

/** What a failed request says, in the server's words when it gave any. */
function reasonOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.problem?.detail ?? error.message) : fallback;
}

/**
 * A group's page (PF-95, ADR-N-031): its members, the platform roles its bindings give it at
 * organization, project or space scope, and the application roles Apps give it. Every edit is a
 * manifest proposed through the one propose function, checked first (PF-57), and lands as a
 * Change in the lane the server gives it; nothing here grants anything by itself. A control the
 * caller's role does not allow stays in place, disabled, with the reason (UI-44).
 */
export function GroupPage({ name }: { name: string }): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [change, setChange] = useState<{ change: Change; project: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const group = useQuery({
    queryKey: queryKeys.resource(ORG_NAMESPACE, "groups", name),
    queryFn: async () =>
      unwrap<unknown>(
        await api.GET("/api/v1/projects/{project}/{plural}/{name}", {
          params: { path: { project: ORG_NAMESPACE, plural: "groups", name } },
        }),
      ),
    retry: false,
  });
  const bindings = useList(ORG_NAMESPACE, "rolebindings");
  const projects = useProjects();
  const apps = useQueries({
    queries: (projects.data ?? []).map((project) => ({
      queryKey: queryKeys.list(project, "apps"),
      queryFn: async () =>
        unwrap(
          await api.GET("/api/v1/projects/{project}/{plural}", {
            params: { path: { project, plural: "apps" } },
          }),
        ),
    })),
  });

  const propose = useMutation({
    mutationFn: ({ project, plural, manifest, create }: Proposal) =>
      proposeChecked(project, plural, manifest as ResourceProposal, create),
    onMutate: () => {
      setError(null);
      setChange(null);
    },
    onSuccess: (result, { project, plural, manifest }) => {
      if (isChange(result)) setChange({ change: result, project });
      void queryClient.invalidateQueries({ queryKey: queryKeys.list(project, plural) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.resource(project, plural, manifest.metadata.name),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.changes(project) });
    },
    onError: (err) => setError(reasonOf(err, t("app.error.generic"))),
  });

  if (group.isPending) {
    return (
      <p role="status" className="text-body text-fg-muted">
        {t("app.loading")}
      </p>
    );
  }
  if (group.error) {
    return (
      <Alert tone="danger" role="alert">
        {group.error instanceof ApiError && group.error.status === 404
          ? t("access.groupPage.notFound", { name })
          : reasonOf(group.error, t("app.error.generic"))}
      </Alert>
    );
  }

  const stored = group.data as { spec?: GroupSpec } | undefined;
  const spec = stored?.spec ?? {};
  const members = spec.members ?? [];
  const naming = bindingsNaming(asManifests(bindings.data?.items ?? []), name);
  const everyApp = apps.flatMap((query, index) =>
    asManifests(query.data?.items ?? []).map((app) => ({
      project: (projects.data ?? [])[index] ?? "",
      app,
    })),
  );
  const appRoles = appRolesNaming(everyApp, name);

  const proposeGroup = (next: { user: string }[]) =>
    propose.mutate({
      project: ORG_NAMESPACE,
      plural: "groups",
      create: false,
      manifest: {
        apiVersion: "joinedcontext.com/v1alpha1",
        kind: "Group",
        metadata: { ...storedMetadata(group.data), name, namespace: ORG_NAMESPACE },
        spec: { ...spec, members: next },
      } as Manifest,
    });

  const proposeApp = (project: string, app: Manifest, next: RolesSpec) =>
    propose.mutate({
      project,
      plural: "apps",
      create: false,
      manifest: {
        apiVersion: "joinedcontext.com/v1alpha1",
        kind: "App",
        metadata: { ...storedMetadata(app), name: app.metadata.name, namespace: project },
        spec: next,
      } as Manifest,
    });

  return (
    <div className="space-y-6">
      <PageHeader
        title={name}
        description={spec.description ?? t("access.groupPage.lead")}
        actions={
          <span className="inline-flex items-center gap-2">
            <Link to="/organization/$tab" params={{ tab: "groups" }} className="text-body underline">
              {t("access.groupPage.back")}
            </Link>
            <DeleteResourceAction
              target={{
                project: ORG_NAMESPACE,
                home: ORG_NAMESPACE,
                kind: "Group",
                plural: "groups",
                name,
                label: name,
              }}
            />
          </span>
        }
      />
      {naming.length + appRoles.length > 0 ? (
        <p className="text-body text-fg-muted">
          {t("access.groupPage.deleteCascade", { bindings: naming.length, apps: appRoles.length })}
        </p>
      ) : null}
      {change ? <ChangeNotice change={change.change} project={change.project} /> : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      ) : null}

      <Members
        members={members}
        busy={propose.isPending}
        onAdd={(email) => {
          const next = withGroupMember(members, email);
          if (next) proposeGroup(next);
        }}
        onRemove={(email) => proposeGroup(members.filter((member) => member.user !== email))}
      />

      <PlatformRoles
        group={name}
        bindings={naming}
        loading={bindings.isPending}
        busy={propose.isPending}
        onAdd={(manifest) => propose.mutate({ project: ORG_NAMESPACE, plural: "rolebindings", manifest, create: true })}
        onEdit={(manifest) => propose.mutate({ project: ORG_NAMESPACE, plural: "rolebindings", manifest, create: false })}
      />

      <ApplicationRoles
        group={name}
        held={appRoles}
        apps={everyApp}
        projects={projects.data ?? []}
        busy={propose.isPending}
        onAdd={(project, app, role) => {
          const next = withMember(app.spec as RolesSpec, role, { group: name });
          if (next) proposeApp(project, app, next);
        }}
        onRemove={(project, app, role) => proposeApp(project, app, withoutMember(app.spec as RolesSpec, role, { group: name }))}
      />
    </div>
  );
}

function Members({
  members,
  busy,
  onAdd,
  onRemove,
}: {
  members: { user: string }[];
  busy: boolean;
  onAdd: (email: string) => void;
  onRemove: (email: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const heading = useId();
  const field = useId();
  const [typed, setTyped] = useState("");
  const email = asUser(typed);
  const held = email !== null && members.some((member) => member.user.toLowerCase() === email);
  const reason = email === null ? t("access.groupPage.needEmail") : held ? t("access.groupPage.already") : undefined;
  return (
    <section aria-labelledby={heading} className="space-y-3 rounded border border-border p-4">
      <h2 id={heading} className="text-title font-semibold text-fg">
        {t("access.groupPage.members")}
      </h2>
      {members.length === 0 ? (
        <p className="text-body text-fg-muted">{t("access.groups.nobody")}</p>
      ) : (
        <ul className="space-y-1">
          {members.map((member) => (
            <li key={member.user} className="flex items-center gap-2">
              <span className="font-mono text-caption">{member.user}</span>
              <PermissionGuard project={ORG_NAMESPACE} kind="Group" verb="propose">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  aria-label={t("access.groupPage.removeMember", { member: member.user })}
                  onClick={() => onRemove(member.user)}
                >
                  {t("access.groupPage.remove")}
                </Button>
              </PermissionGuard>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (email && !held) {
            onAdd(email);
            setTyped("");
          }
        }}
      >
        <Field id={field} label={t("access.groupPage.email")}>
          <Input
            id={field}
            type="email"
            autoComplete="off"
            value={typed}
            placeholder="firstname.lastname@example.org"
            onChange={(event) => setTyped(event.target.value)}
          />
        </Field>
        <PermissionGuard project={ORG_NAMESPACE} kind="Group" verb="propose">
          <Button type="submit" size="sm" disabled={busy || reason !== undefined} disabledReason={reason}>
            {t("access.groupPage.addMember")}
          </Button>
        </PermissionGuard>
      </form>
    </section>
  );
}

function where(scope: Scope | undefined, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (scope?.contextSpace) return t("access.roles.space", { name: scope.contextSpace });
  if (scope?.project) return t("access.roles.project", { name: scope.project });
  return t("access.groupPage.organization");
}

function PlatformRoles({
  group,
  bindings,
  loading,
  busy,
  onAdd,
  onEdit,
}: {
  group: string;
  bindings: Manifest[];
  loading: boolean;
  busy: boolean;
  onAdd: (manifest: Manifest) => void;
  onEdit: (manifest: Manifest) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const heading = useId();
  const ids = useId();
  const branding = useBranding();
  const projects = useProjects();
  const orgRoles = useList(ORG_NAMESPACE, "roles");
  const [target, setTarget] = useState(""); // "" = organization, else a project name
  const [space, setSpace] = useState("");
  const [role, setRole] = useState("");
  const spaces = useList(target, "spaces", target !== "");
  // Every project's own roles are offered, so a project role picked for the wrong place is
  // refused with the reason (PF-69) instead of vanishing from the list.
  const projectRoles = useQueries({
    queries: (projects.data ?? []).map((project) => ({
      queryKey: queryKeys.list(project, "roles"),
      queryFn: async () =>
        unwrap(
          await api.GET("/api/v1/projects/{project}/{plural}", {
            params: { path: { project, plural: "roles" } },
          }),
        ),
    })),
  });

  const choices: RoleChoice[] = [
    ...asManifests(orgRoles.data?.items ?? []).map((r) => ({ name: r.metadata.name, home: ORG_NAMESPACE })),
    ...projectRoles.flatMap((query, index) => {
      const home = (projects.data ?? [])[index] ?? "";
      return asManifests(query.data?.items ?? [])
        .filter((r) => (r.metadata.namespace ?? home) === home && home !== ORG_NAMESPACE)
        .map((r) => ({ name: r.metadata.name, home }));
    }),
  ];
  const place: Place =
    target === ""
      ? { kind: "organization" }
      : space
        ? { kind: "space", project: target, space }
        : { kind: "project", project: target };
  const chosen = choices.find((choice) => `${choice.home}/${choice.name}` === role);
  const refusal = chosen ? refusedPlace(chosen, place) : null;
  const reason = !chosen
    ? t("access.groupPage.needRole")
    : refusal
      ? t(`access.groupPage.refused.${refusal}`, { role: chosen.name })
      : undefined;

  return (
    <section aria-labelledby={heading} className="space-y-3 rounded border border-border p-4">
      <h2 id={heading} className="text-title font-semibold text-fg">
        {t("access.groupPage.platformRoles")}
      </h2>
      <p className="text-body text-fg-muted">{t("access.groupPage.platformLead")}</p>
      {loading ? (
        <p role="status" className="text-body text-fg-muted">
          {t("app.loading")}
        </p>
      ) : bindings.length === 0 ? (
        <p className="text-body text-fg-muted">{t("access.groupPage.noPlatformRole")}</p>
      ) : (
        <ul className="space-y-1">
          {bindings.map((binding) => {
            const spec = binding.spec as { role?: string; scope?: Scope };
            const label = t("access.groupPage.roleAt", { role: spec.role ?? "", where: where(spec.scope, t) });
            const without = bindingWithoutGroup(binding, group);
            return (
              <li key={binding.metadata.name} className="flex flex-wrap items-center gap-2">
                <span>{label}</span>
                {without ? (
                  <PermissionGuard project={ORG_NAMESPACE} kind="RoleBinding" verb="propose">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      aria-label={t("access.groupPage.removeRole", { role: label })}
                      onClick={() => onEdit(without)}
                    >
                      {t("access.groupPage.remove")}
                    </Button>
                  </PermissionGuard>
                ) : (
                  <>
                    <span className="text-caption text-fg-muted">{t("access.groupPage.onlySubject")}</span>
                    <DeleteResourceAction
                      target={{
                        project: ORG_NAMESPACE,
                        home: ORG_NAMESPACE,
                        kind: "RoleBinding",
                        plural: "rolebindings",
                        name: binding.metadata.name,
                        label,
                      }}
                    />
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (chosen && !refusal) {
            onAdd(groupBinding(group, chosen.name, place, branding.orgDomain));
            setRole("");
          }
        }}
      >
        <Field id={`${ids}-where`} label={t("access.groupPage.where")}>
          <Select
            id={`${ids}-where`}
            value={target}
            onChange={(event) => {
              setTarget(event.target.value);
              setSpace("");
            }}
          >
            <option value="">{t("access.groupPage.organization")}</option>
            {(projects.data ?? []).map((project) => (
              <option key={project} value={project}>
                {t("access.roles.project", { name: project })}
              </option>
            ))}
          </Select>
        </Field>
        {target ? (
          <Field id={`${ids}-space`} label={t("access.groupPage.space")}>
            <Select id={`${ids}-space`} value={space} onChange={(event) => setSpace(event.target.value)}>
              <option value="">{t("access.groupPage.wholeProject")}</option>
              {asManifests(spaces.data?.items ?? []).map((s) => (
                <option key={s.metadata.name} value={s.metadata.name}>
                  {s.metadata.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field id={`${ids}-role`} label={t("access.groupPage.role")}>
          <Select id={`${ids}-role`} value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="">{t("access.groupPage.pickRole")}</option>
            {choices.map((choice) => (
              <option key={`${choice.home}/${choice.name}`} value={`${choice.home}/${choice.name}`}>
                {choice.home === ORG_NAMESPACE
                  ? choice.name
                  : t("access.groupPage.projectRole", { role: choice.name, project: choice.home })}
              </option>
            ))}
          </Select>
        </Field>
        <PermissionGuard project={ORG_NAMESPACE} kind="RoleBinding" verb="propose">
          <Button type="submit" size="sm" disabled={busy || reason !== undefined} disabledReason={reason}>
            {t("access.groupPage.addRole")}
          </Button>
        </PermissionGuard>
      </form>
    </section>
  );
}

function ApplicationRoles({
  group,
  held,
  apps,
  projects,
  busy,
  onAdd,
  onRemove,
}: {
  group: string;
  held: { project: string; app: string; role: string }[];
  apps: { project: string; app: Manifest }[];
  projects: string[];
  busy: boolean;
  onAdd: (project: string, app: Manifest, role: string) => void;
  onRemove: (project: string, app: Manifest, role: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const heading = useId();
  const ids = useId();
  const [project, setProject] = useState("");
  const [appName, setAppName] = useState("");
  const [role, setRole] = useState("");
  const find = (p: string, a: string) => apps.find((entry) => entry.project === p && entry.app.metadata.name === a)?.app;
  const inProject = apps.filter((entry) => entry.project === project);
  const app = find(project, appName);
  const roles = ((app?.spec as RolesSpec | undefined)?.roles ?? []).map((r) => r.name);
  const already = held.some((h) => h.project === project && h.app === appName && h.role === role);
  const reason = !app || !role ? t("access.groupPage.needAppRole") : already ? t("access.groupPage.already") : undefined;

  return (
    <section aria-labelledby={heading} className="space-y-3 rounded border border-border p-4">
      <h2 id={heading} className="text-title font-semibold text-fg">
        {t("access.groupPage.appRoles")}
      </h2>
      <p className="text-body text-fg-muted">{t("access.groupPage.appLead", { group })}</p>
      {held.length === 0 ? (
        <p className="text-body text-fg-muted">{t("access.groupPage.noAppRole")}</p>
      ) : (
        <ul className="space-y-1">
          {held.map((entry) => {
            const label = t("access.groupPage.appRole", entry);
            const manifest = find(entry.project, entry.app);
            return (
              <li key={`${entry.project}/${entry.app}/${entry.role}`} className="flex items-center gap-2">
                <Link
                  to="/projects/$project/$plural/$name"
                  params={{ project: entry.project, plural: "apps", name: entry.app }}
                  className="underline"
                >
                  {label}
                </Link>
                <PermissionGuard project={entry.project} kind="App" verb="propose">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || !manifest}
                    aria-label={t("access.groupPage.removeAppRole", { role: label })}
                    onClick={() => manifest && onRemove(entry.project, manifest, entry.role)}
                  >
                    {t("access.groupPage.remove")}
                  </Button>
                </PermissionGuard>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (app && role && !already) {
            onAdd(project, app, role);
            setRole("");
          }
        }}
      >
        <Field id={`${ids}-project`} label={t("access.groupPage.project")}>
          <Select
            id={`${ids}-project`}
            value={project}
            onChange={(event) => {
              setProject(event.target.value);
              setAppName("");
              setRole("");
            }}
          >
            <option value="">{t("access.groupPage.pickProject")}</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={`${ids}-app`} label={t("access.groupPage.app")}>
          <Select
            id={`${ids}-app`}
            value={appName}
            onChange={(event) => {
              setAppName(event.target.value);
              setRole("");
            }}
          >
            <option value="">{t("access.groupPage.pickApp")}</option>
            {inProject.map((entry) => (
              <option key={entry.app.metadata.name} value={entry.app.metadata.name}>
                {entry.app.metadata.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={`${ids}-role`} label={t("access.groupPage.role")}>
          <Select id={`${ids}-role`} value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="">{t("access.groupPage.pickRole")}</option>
            {roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
        <PermissionGuard project={project || ORG_NAMESPACE} kind="App" verb="propose">
          <Button type="submit" size="sm" disabled={busy || reason !== undefined} disabledReason={reason}>
            {t("access.groupPage.addAppRole")}
          </Button>
        </PermissionGuard>
      </form>
    </section>
  );
}
