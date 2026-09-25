import { useCreateFormFromDraft } from "../components/forms/FormRoute";
import { RecordLink } from "../components/RecordLink";
import { useState } from "react";
import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap, whilePending } from "../api/client";
import { proposeChecked } from "../api/proposal";
import { asManifests, isChange, localized, storedMetadata } from "../api/manifest";
import type { Change, Manifest, ResourceProposal } from "../api/manifest";
import { useOrgDomain } from "../api/projects";
import { ChangeNotice } from "../components/ChangeNotice";
import { LifecycleBadge } from "../components/status/LifecycleBadge";
import { ResourceFormDialog } from "../components/ResourceFormDialog";
import { ResourceList } from "../components/ResourceList";
import { ResourceRowActions } from "../components/ResourceRowActions";
import { expandOperations } from "../components/endpoints/operationGroups";
import { policySchema, policyUiSchema } from "../schemas/kinds";
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  PageHeader,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Term,
} from "../components/ui";
import { PermissionGuard } from "../components/ui/PermissionGuard";

/** The space a policy's manifest is filed under, the way the Portal labels every space-scoped kind. */
const SPACE_LABEL = "joinedcontext.com/space";

export interface PolicyForm {
  name: string;
  contextSpaceRef: string;
  effect?: string;
  assignee: { kind: string; id: string };
  operations: string[];
  information?: {
    entities: { type: string; idPattern?: string }[];
    propertyNames?: string[];
    relationshipNames?: string[];
  }[];
  q?: string;
  scopeQ?: string;
  geoQ?: string;
  temporalQ?: string;
  validity?: { from?: string; to?: string };
  /** The assigner the stored manifest carries, kept as it is; never a field a person retypes. */
  assigner?: string;
}

/** Drops what the form leaves empty: a manifest reads as what it grants, not as a list of blanks. */
function present<T extends Record<string, unknown>>(members: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(members).filter(([, value]) => {
      if (value === undefined || value === null) return false;
      if (typeof value === "string") return value.trim() !== "";
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === "object") return Object.keys(value as object).length > 0;
      return true;
    }),
  ) as Partial<T>;
}

/**
 * The form as the manifest the API stores.
 *
 * `assigner` is the data owner and not a box a person fills: an existing policy keeps the one it
 * was written with, and a new one names the organization this project belongs to (R5).
 */
export function toPolicyEnvelope(
  project: string,
  orgDomain: string,
  form: PolicyForm,
  stored?: unknown,
): unknown {
  const { name, assigner, validity, information, ...rest } = form;
  // What the form has no field for travels on from the manifest the edit started from (T-2470).
  const kept = storedMetadata(stored);
  const labels = {
    ...((kept.labels as Record<string, string> | undefined) ?? {}),
    ...(form.contextSpaceRef ? { [SPACE_LABEL]: form.contextSpaceRef } : {}),
  };
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "Policy",
    metadata: {
      ...kept,
      name,
      namespace: project,
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
    },
    spec: {
      ...present({ ...rest }),
      contextSpaceRef: { kind: "ContextSpace", name: form.contextSpaceRef },
      assigner: assigner?.trim() ? assigner : `did:web:${orgDomain}`,
      ...(information && information.length > 0 ? { information } : {}),
      ...(validity && (validity.from || validity.to)
        ? { validity: present(validity as Record<string, unknown>) }
        : {}),
    },
  };
}

/** The stored manifest back as the form: the same pair, so the YAML view and the fields agree. */
export function fromPolicyEnvelope(manifest: unknown): PolicyForm {
  const envelope = (manifest ?? {}) as {
    metadata?: { name?: string };
    spec?: Record<string, unknown>;
  };
  const spec = envelope.spec ?? {};
  const reference = spec.contextSpaceRef as string | { name?: string } | undefined;
  return {
    ...(spec as object),
    name: envelope.metadata?.name ?? "",
    contextSpaceRef:
      (typeof reference === "string" ? reference : reference?.name) ?? "",
    assignee: (spec.assignee as PolicyForm["assignee"]) ?? { kind: "role", id: "" },
    operations: (spec.operations as string[] | undefined) ?? [],
  } as PolicyForm;
}

const COLUMNS = 6;

/**
 * The policies of one project: what each one grants, to whom, and on which space (R5…R9, UI-01).
 *
 * Every other kind a person authors has a form; a `Policy` had none, so the manifest that decides
 * who may read a city's context data was the one kind editable only as YAML (T-2326). The form is
 * the same `ResourceFormDialog` every kind uses, so the YAML view, the draft, the Check and the
 * verdict come with it, and a policy is still proposed as a Change rather than written (UI-44).
 */
export function PoliciesPage({ project, edit }: { project: string; edit?: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";
  const queryClient = useQueryClient();
  const orgDomain = useOrgDomain(project);
  // The create form is a page at `/{plural}/new` on a routed list (T-2474).
  const [dialogOpen, setDialogOpen, handedDraft] = useCreateFormFromDraft();
  const [form, setForm] = useState<PolicyForm | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [change, setChange] = useState<Change | null>(null);

  const list = useQuery({
    queryKey: queryKeys.list(project, "policies"),
    refetchInterval: whilePending,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project, plural: "policies" } },
        }),
      ),
  });

  const spaces = useQuery({
    queryKey: queryKeys.list(project, "spaces"),
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project, plural: "spaces" } },
        }),
      ),
  });
  const spaceNames = asManifests(spaces.data?.items ?? []).map((space) => space.metadata.name);

  // The schema carries what the form holds, so a policy granting an operation this build
  // does not name still opens in the form rather than only in the YAML view.
  const schema = policySchema(t, spaceNames, [], form?.operations ?? []);

  const create = useMutation({
    mutationFn: async (form: PolicyForm) => {
      setFormError(null);
      return proposeChecked(
        project,
        "policies",
        toPolicyEnvelope(project, orgDomain, form) as ResourceProposal,
        true,
      );
    },
    onSuccess: (result) => {
      if (isChange(result)) {
        setChange(result);
      }
      setDialogOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.list(project, "policies") });
    },
    onError: (err) => {
      setFormError(
        err instanceof ApiError
          ? (err.problem?.detail ?? err.message)
          : err instanceof Error
            ? err.message
            : t("app.error.generic"),
      );
    },
  });

  const addButton = (
    <PermissionGuard project={project} kind="Policy" verb="propose">
      <Button
        variant="primary"
        icon={<Icon name="plus" className="size-4" />}
        onClick={() => {
          setFormError(null);
          setForm(undefined);
          setDialogOpen(true);
        }}
      >
        {t("policies.add")}
      </Button>
    </PermissionGuard>
  );

  const policies = asManifests(list.data?.items ?? []);

  return (
    <div className="flex flex-col gap-section">
      <PageHeader title={t("policies.title")} description={t("policies.lead")} actions={addButton} />

      {change ? <ChangeNotice change={change} project={project} /> : null}

      <ResourceList
        query={list}
        caption={t("policies.title")}
        head={
          <TableHead>
            <TableHeaderCell>{t("policies.field.name")}</TableHeaderCell>
            <TableHeaderCell>
              <Term name="contextSpace">{t("policies.field.space")}</Term>
            </TableHeaderCell>
            <TableHeaderCell>{t("policies.field.assignee")}</TableHeaderCell>
            <TableHeaderCell>{t("policies.field.grants")}</TableHeaderCell>
            <TableHeaderCell>{t("resourceList.phase")}</TableHeaderCell>
            <TableHeaderCell align="right">{t("approvals.actions")}</TableHeaderCell>
          </TableHead>
        }
        columns={COLUMNS}
        count={policies.length}
        empty={
          <EmptyState
            bare
            title={t("policies.empty")}
            description={t("policies.addHint")}
            action={addButton}
          />
        }
      >
        {policies.map((policy: Manifest) => {
          const spec = policy.spec as Record<string, unknown>;
          const shape = fromPolicyEnvelope(policy);
          const title = localized(policy.metadata.title, locale, policy.metadata.name);
          const target = {
            project,
            kind: "Policy",
            plural: "policies",
            name: policy.metadata.name,
            label: title,
          };
          return (
            <TableRow key={policy.metadata.name}>
              <TableCell primary>
                <div className="flex items-center gap-2">
                  <RecordLink project={project} plural="policies" name={policy.metadata.name}>
                    {title}
                  </RecordLink>
                  {spec.effect === "prohibition" ? (
                    <Badge tone="danger">{t("policies.effect.prohibition")}</Badge>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>
                <span className="font-mono text-caption">{shape.contextSpaceRef || "—"}</span>
              </TableCell>
              <TableCell>
                <span className="font-mono text-caption">
                  {shape.assignee.kind}:{shape.assignee.id}
                </span>
              </TableCell>
              <TableCell>
                {/* The names the manifest carries, and what they cover: a group is a word nobody
                    can check until the page says which operations it stands for (T-2282). */}
                <div className="font-mono text-caption">{shape.operations.join(", ") || "—"}</div>
                <div className="mt-0.5 text-caption text-fg-subtle">
                  {t("policies.operations.total", {
                    count: expandOperations(shape.operations).length,
                  })}
                </div>
              </TableCell>
              <TableCell>
                <LifecycleBadge kind="phase" value={policy.status?.phase} />
              </TableCell>
              <TableCell align="right">
                <ResourceRowActions
                  project={project}
                  target={target}
                  form={{
                    schema: policySchema(t, spaceNames, [], shape.operations),
                    uiSchema: policyUiSchema,
                    fromManifest: (manifest) =>
                      fromPolicyEnvelope(manifest) as unknown as Record<string, unknown>,
                    toManifest: (edited, stored) =>
                      toPolicyEnvelope(project, orgDomain, edited as unknown as PolicyForm, stored),
                  }}
                />
              </TableCell>
            </TableRow>
          );
        })}
      </ResourceList>

      <ResourceFormDialog<PolicyForm>
        kind="Policy"
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={t("policies.add")}
        description={t("policies.addHint")}
        schema={schema}
        uiSchema={policyUiSchema}
        formData={form}
        onChange={setForm}
        project={project}
        draftKind="Policy"
        draftName={edit ?? handedDraft}
        plural="policies"
        source={{
          toManifest: (form) => toPolicyEnvelope(project, orgDomain, form),
          fromManifest: (manifest) => fromPolicyEnvelope(manifest),
        }}
        submitLabel={t("policies.propose")}
        submitting={create.isPending}
        error={formError}
        onSubmit={(form) => create.mutate(form)}
      />
    </div>
  );
}
