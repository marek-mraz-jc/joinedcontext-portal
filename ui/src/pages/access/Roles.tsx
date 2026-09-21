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
import { EditResourceAction } from "../../components/EditResourceDialog";
import { ResourceFormDialog } from "../../components/ResourceFormDialog";
import { FormFrame, useFormRoute } from "../../components/forms/FormRoute";
import { ROLE_VERBS, roleSchema } from "../../schemas/kinds";
import {
  Alert,
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

function useRoles(project: string) {
  return useQuery({
    queryKey: queryKeys.list(project, "roles"),
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
  const schema = roleSchema(
    t,
    rights.kinds,
    rights.verbs.length > 0 ? rights.verbs : ROLE_VERBS,
  );
  // PF-52 as the form reads it: the rules of the role in hand against the grants the caller holds.
  // The server runs the same comparison; this one only says it before the proposal is sent.
  const missing = beyondOwnRights(permissions.data, form?.rules);

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
        missing.length > 0
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
export function Roles({ project }: { project: string }): JSX.Element {
  const { t } = useTranslation();
  const organization = useRoles(ORG_NAMESPACE);
  const here = useRoles(project);
  const [writing, setWriting] = useState(false);
  // A role already written may name a kind the editor does not hold; the lists offer what they
  // hold and the schema keeps the rest, so editing one rule never silently drops another (PF-52).
  const editSchema = roleSchema(t, [], ROLE_VERBS);

  const rows: Row[] = [
    ...asManifests(here.data?.items ?? []).map((role: Manifest) => ({
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
  const pending = organization.isPending || here.isPending;

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
        <Table caption={t("access.projectRoles.caption", { project })} status={pending ? t("app.loading") : undefined}>
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
                    <TableCell primary>{row.name}</TableCell>
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
