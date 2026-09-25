import { useState } from "react";
import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap } from "../../api/client";
import { proposeChecked } from "../../api/proposal";
import { asManifests, isChange, ORG_NAMESPACE, storedMetadata } from "../../api/manifest";
import type { Change, Manifest, ResourceProposal } from "../../api/manifest";
import { beyondOwnRights, ownRights, usePermissions } from "../../api/permissions";
import { ChangeNotice } from "../../components/ChangeNotice";
import { DeleteResourceAction } from "../../components/DeleteResourceDialog";
import { FormRecordLink } from "../../components/RecordLink";
import { EditResourceAction } from "../../components/EditResourceDialog";
import { ResourceFormDialog } from "../../components/ResourceFormDialog";
import { FormFrame, useCreateForm, useFormRoute } from "../../components/forms/FormRoute";
import { ROLE_VERBS, roleSchema } from "../../schemas/kinds";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableSkeleton,
} from "../../components/ui";
import { PermissionGuard } from "../../components/ui/PermissionGuard";

interface Rule {
  kinds?: string[];
  verbs?: string[];
  constraints?: { field?: string }[];
}

/** One role of the list, with the namespace it came from so its row can be edited where it lives. */
interface Row {
  name: string;
  home: string;
  rules: Rule[];
}

/** What the role form holds: the name it is filed under, and the rules it grants. */
export interface RoleForm {
  name: string;
  rules: Rule[];
}

/** The form as the manifest the API stores. A rule keeps the constraints it came with (PF-49). */
export function toRoleEnvelope(namespace: string, form: RoleForm, stored?: unknown): unknown {
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "Role",
    // What the form has no field for travels on from the manifest the edit started from (T-2470).
    metadata: { ...storedMetadata(stored), name: form.name, namespace },
    spec: {
      rules: (form.rules ?? []).map((rule) => ({
        kinds: rule.kinds ?? [],
        verbs: rule.verbs ?? [],
        ...(rule.constraints && rule.constraints.length > 0
          ? { constraints: rule.constraints }
          : {}),
      })),
    },
  };
}

/** The stored manifest back as the form, so the fields and the YAML view hold the same role. */
export function fromRoleEnvelope(manifest: unknown): RoleForm {
  const envelope = (manifest ?? {}) as {
    metadata?: { name?: string };
    spec?: { rules?: Rule[] };
  };
  return {
    name: envelope.metadata?.name ?? "",
    rules: envelope.spec?.rules ?? [],
  };
}

/**
 * The role taxonomy every organization starts from (PF-56). Read only to mark a row *seeded*:
 * the taxonomy is a seed the organization extends, so nothing is decided by these names.
 */
export const SEEDED_ROLES = [
  "viewer",
  "model-editor",
  "pipeline-editor",
  "endpoint-editor",
  "app-editor",
  "steward",
  "publisher",
  "org-admin",
] as const;

/**
 * The kinds a role inside a project may never name (PF-68): they belong to the organization's own
 * roles. jc-core refuses them at validation; the form leaves them out of its list and says so
 * before the door does. The door stays the authority for any other organization kind.
 */
export const NOT_IN_A_PROJECT = ["Role", "RoleBinding", "Group", "Organization", "Project"] as const;

/** The kinds of `rules` a project role may not name, each once (PF-68). */
export function organizationKindsIn(rules: { kinds?: string[] }[] | undefined): string[] {
  const named = new Set((rules ?? []).flatMap((rule) => rule.kinds ?? []));
  return NOT_IN_A_PROJECT.filter((kind) => named.has(kind));
}

/**
 * Which roles a page lists (Architecture/09 §14.4): the organization's own on the Organization
 * page, this project's own in Project settings, both where both meet.
 */
export type RoleScope = "organization" | "project" | "all";

function useRoles(project: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.list(project, "roles"),
    enabled,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project, plural: "roles" } },
        }),
      ),
  });
}

/**
 * A role of this project, proposed as a change (PF-68, PF-52): a role written here names the
 * project's kinds and only the verbs its author already holds.
 *
 * The rules used to be typed as YAML into one textarea, which asked a steward for the right
 * indentation and the right key before it asked them what the role should grant (T-2400). The
 * fields are the same `ResourceFormDialog` every other kind uses, so the YAML view is still there
 * for somebody who prefers it, and the lists offer what the author holds: proposing a verb the
 * API would refuse is said here, in the same words, before it is sent (PF-52, PF-51).
 */
export function NewRoleDialog({
  project,
  open,
  onOpenChange,
}: {
  project: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const formRoute = useFormRoute();
  const queryClient = useQueryClient();
  const permissions = usePermissions(project);
  const [form, setForm] = useState<RoleForm | undefined>(undefined);
  const [change, setChange] = useState<Change | null>(null);

  const propose = useMutation({
    mutationFn: async (role: RoleForm) =>
      proposeChecked(
        project,
        "roles",
        toRoleEnvelope(project, role) as ResourceProposal,
        true,
      ),
    onSuccess: (result) => {
      if (isChange(result)) {
        // Routed, the save goes back to the list and the change is shown there (T-2474).
        if (formRoute) {
          formRoute.leave(<ChangeNotice change={result} project={project} />);
          close(false);
        } else {
          setChange(result);
        }
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.list(project, "roles") });
      void queryClient.invalidateQueries({ queryKey: queryKeys.changes(project) });
    },
  });

  const rights = ownRights(permissions.data);
  const inProject = project !== ORG_NAMESPACE;
  const schema = roleSchema(
    t,
    inProject
      ? rights.kinds.filter((kind) => !(NOT_IN_A_PROJECT as readonly string[]).includes(kind))
      : rights.kinds,
    rights.verbs.length > 0 ? rights.verbs : ROLE_VERBS,
  );
  // PF-52 as the form reads it: the rules of the role in hand against the grants the caller holds.
  // The server runs the same comparison; this one only says it before the proposal is sent.
  const missing = beyondOwnRights(permissions.data, form?.rules);
  const outOfPlace = inProject ? organizationKindsIn(form?.rules) : [];

  const failure =
    propose.error instanceof ApiError
      ? (propose.error.problem?.detail ?? propose.error.message)
      : propose.error
        ? t("app.error.generic")
        : null;

  const close = (next: boolean) => {
    if (!next) {
      setForm(undefined);
      setChange(null);
      propose.reset();
    }
    onOpenChange(next);
  };

  if (change) {
    return (
      <FormFrame
        open={open}
        onOpenChange={close}
        size="lg"
        title={t("access.projectRoles.newTitle")}
        description={t("access.projectRoles.newLead", { project })}
        closeLabel={t("resourceDelete.close")}
        footer={<Button onClick={() => close(false)}>{t("resourceDelete.close")}</Button>}
      >
        <ChangeNotice change={change} project={project} />
      </FormFrame>
    );
  }

  return (
    <ResourceFormDialog<RoleForm>
      kind="Role"
      open={open}
      onOpenChange={close}
      title={t("access.projectRoles.newTitle")}
      description={t("access.projectRoles.newLead", { project })}
      schema={schema}
      formData={form}
      onChange={setForm}
      project={project}
      draftKind="Role"
      plural="roles"
      source={{
        toManifest: (role) => toRoleEnvelope(project, role),
        fromManifest: (manifest) => fromRoleEnvelope(manifest),
      }}
      submitLabel={t("access.projectRoles.propose")}
      submitting={propose.isPending}
      submitDisabledReason={
        outOfPlace.length > 0
          ? t("projectSettings.roles.organizationKinds", { kinds: outOfPlace.join(", ") })
          : missing.length > 0
            ? t("access.projectRoles.beyondRights", { missing: missing.join(", ") })
            : undefined
      }
      error={failure}
      onSubmit={(role) => propose.mutate(role)}
    />
  );
}

/**
 * Project → Access → the roles in force here: the organization's, which every project shares, and
 * this project's own, which its steward writes and nobody outside it can be given (PF-68, PF-69).
 */
export function Roles({
  project,
  scope = "all",
}: {
  project: string;
  scope?: RoleScope;
}): JSX.Element {
  const { t } = useTranslation();
  const organization = useRoles(ORG_NAMESPACE, scope !== "project");
  // The organization's own namespace has no project roles: the same list twice would be the
  // same rows twice (one query key, one cache entry).
  const ownRoles = scope !== "organization" && project !== ORG_NAMESPACE;
  const here = useRoles(project, ownRoles);
  // The routed `…/roles/new` opens the same form the button does (T-2750, T-2474).
  const [writing, setWriting] = useCreateForm();
  // A role already written may name a kind the editor does not hold; the lists offer what they
  // hold and the schema keeps the rest, so editing one rule never silently drops another (PF-52).
  const editSchema = roleSchema(t, [], ROLE_VERBS);

  const rows: Row[] = [
    ...asManifests((ownRoles ? here.data?.items : undefined) ?? []).map((role: Manifest) => ({
      name: role.metadata.name,
      home: project,
      rules: ((role.spec ?? {}) as { rules?: Rule[] }).rules ?? [],
    })),
    ...asManifests(organization.data?.items ?? []).map((role: Manifest) => ({
      name: role.metadata.name,
      home: ORG_NAMESPACE,
      rules: ((role.spec ?? {}) as { rules?: Rule[] }).rules ?? [],
    })),
  ];

  /** What a role grants, in one line: `propose, approve on Pipeline, DataSource`. */
  const grants = (rules: Rule[]) =>
    rules
      .map((rule) => `${(rule.verbs ?? []).join(", ")} ${t("access.projectRoles.on")} ${(rule.kinds ?? []).join(", ")}`)
      .join("; ");

  const error = organization.error ?? here.error;
  // A list this page does not ask for is not pending: an idle query stays `isPending` forever.
  const waiting = (query: { isPending: boolean; fetchStatus: string }) =>
    query.isPending && query.fetchStatus !== "idle";
  const pending = waiting(organization) || waiting(here);

  return (
    <section className="space-y-4" aria-labelledby="project-roles-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="project-roles-heading" className="text-title font-semibold text-fg">
            {t("access.projectRoles.title")}
          </h2>
          <p className="text-body text-fg-muted">{t("access.projectRoles.lead")}</p>
        </div>
        <PermissionGuard project={project} kind="Role" verb="propose">
          {/* One primary per view: the Access page's own action is "Grant a role" (T-1731). */}
          <Button variant="secondary" onClick={() => setWriting(true)}>
            {t("access.projectRoles.new")}
          </Button>
        </PermissionGuard>
      </div>

      {error ? (
        <Alert tone="danger" role="alert">
          {error instanceof ApiError ? (error.problem?.detail ?? error.message) : t("app.error.generic")}
        </Alert>
      ) : (
        <Table data-records="" caption={t("access.projectRoles.caption", { project })} status={pending ? t("app.loading") : undefined}>
          <TableHead>
            <TableHeaderCell>{t("access.projectRoles.role")}</TableHeaderCell>
            <TableHeaderCell>{t("access.projectRoles.where")}</TableHeaderCell>
            <TableHeaderCell>{t("access.projectRoles.grants")}</TableHeaderCell>
            <TableHeaderCell align="right">{t("approvals.actions")}</TableHeaderCell>
          </TableHead>
          {pending ? (
            <TableSkeleton columns={4} />
          ) : (
            <TableBody>
              {rows.length === 0 ? (
                <TableEmpty columns={4}>
                  <EmptyState bare
                    title={t("access.projectRoles.empty")}
                    description={t("access.projectRoles.emptyHint")} />
                </TableEmpty>
              ) : (
                rows.map((row) => (
                  <TableRow key={`${row.home}/${row.name}`}>
                    <TableCell primary>
                      <span className="inline-flex items-center gap-2">
                        <FormRecordLink name={row.name} />
                        {row.home === ORG_NAMESPACE &&
                        (SEEDED_ROLES as readonly string[]).includes(row.name) ? (
                          <Badge tone="neutral">{t("organization.roles.seeded")}</Badge>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell>
                      {row.home === ORG_NAMESPACE
                        ? t("access.roles.organization")
                        : t("access.roles.project", { name: row.home })}
                    </TableCell>
                    <TableCell>{grants(row.rules)}</TableCell>
                    <TableCell align="right">
                      <span className="inline-flex items-center gap-1.5">
                        <EditResourceAction
                          target={{
                            project,
                            home: row.home,
                            kind: "Role",
                            plural: "roles",
                            name: row.name,
                            label: row.name,
                          }}
                          // A role of this project wins its name's address over the organization's.
                          addressed={
                            row.home === project ||
                            !rows.some((other) => other.home === project && other.name === row.name)
                          }
                          form={{
                            schema: editSchema,
                            fromManifest: (manifest) =>
                              fromRoleEnvelope(manifest) as unknown as Record<string, unknown>,
                            toManifest: (edited, stored) =>
                              toRoleEnvelope(row.home, edited as unknown as RoleForm, stored),
                          }}
                        />
                        <DeleteResourceAction
                          target={{
                            project,
                            home: row.home,
                            kind: "Role",
                            plural: "roles",
                            name: row.name,
                            label: row.name,
                          }}
                        />
                      </span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          )}
        </Table>
      )}

      <NewRoleDialog project={project} open={writing} onOpenChange={setWriting} />
    </section>
  );
}
