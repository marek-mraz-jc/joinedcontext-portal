import { useCreateFormFromDraft } from "../components/forms/FormRoute";
import { Fragment, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap, whilePending } from "../api/client";
import { proposeChecked } from "../api/proposal";
import { asManifests, isChange, localized, storedMetadata } from "../api/manifest";
import type { Change, Manifest, ResourceProposal } from "../api/manifest";
import { ChangeNotice } from "../components/ChangeNotice";
import { TypeLink } from "../pages/models/ModelLinks";
import { LifecycleBadge } from "../components/status/LifecycleBadge";
import { ResourceFormDialog } from "../components/ResourceFormDialog";
import { ResourceList } from "../components/ResourceList";
import { ResourceRowActions } from "../components/ResourceRowActions";
import { subscriptionSchema, subscriptionUiSchema } from "../schemas/kinds";
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

/** The space a subscription's manifest is filed under, the way every space-scoped kind is labelled. */
const SPACE_LABEL = "joinedcontext.com/space";

export interface SubscriptionForm {
  name: string;
  contextSpaceRef: string;
  subscriptionName?: string;
  description?: string;
  entities?: { type?: string; id?: string; idPattern?: string }[];
  watchedAttributes?: string[];
  q?: string;
  geoQ?: string;
  notification: {
    endpoint: {
      uri: string;
      accept?: string;
      receiverInfo?: { key: string; value: string }[];
      secretRef?: { name: string; key?: string };
    };
    format?: string;
    attributes?: string[];
  };
  throttling?: number;
  expiresAt?: string;
  isActive?: boolean;
}

/** Whether a value is worth writing: a manifest reads as what it watches, not as a list of blanks. */
function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(present(value as Record<string, unknown>)).length > 0;
  return true;
}

/** An object without its empty members, recursively. */
function present(members: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(members)
      .map(([key, value]): [string, unknown] => [
        key,
        value && typeof value === "object" && !Array.isArray(value)
          ? present(value as Record<string, unknown>)
          : value,
      ])
      .filter(([, value]) => isPresent(value)),
  );
}

/** A selector with the members it names, and no blank one beside them. */
function selectors(entities: SubscriptionForm["entities"]): Record<string, unknown>[] {
  return (entities ?? [])
    .map((selector) => present(selector as Record<string, unknown>))
    .filter((selector) => Object.keys(selector).length > 0);
}

/** Whether the form watches anything: jc-core refuses a subscription that watches nothing (CC-72). */
export function watchesSomething(form: SubscriptionForm): boolean {
  return selectors(form.entities).length > 0 || (form.watchedAttributes ?? []).some((a) => a.trim() !== "");
}

/**
 * The form as the manifest the API stores. `stored` is the manifest an edit started from: its
 * title, description and labels travel on, because the form has no field for them and an edit
 * that dropped them would propose their deletion nobody asked for.
 */
export function toSubscriptionEnvelope(
  project: string,
  form: SubscriptionForm,
  stored?: unknown,
): unknown {
  const { name, contextSpaceRef, entities, isActive, ...rest } = form;
  const kept = storedMetadata(stored);
  const labels = {
    ...((kept.labels as Record<string, string> | undefined) ?? {}),
    ...(contextSpaceRef ? { [SPACE_LABEL]: contextSpaceRef } : {}),
  };
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "Subscription",
    metadata: {
      ...kept,
      name,
      namespace: project,
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
    },
    spec: {
      ...present(rest as Record<string, unknown>),
      contextSpaceRef: { kind: "ContextSpace", name: contextSpaceRef },
      ...(selectors(entities).length > 0 ? { entities: selectors(entities) } : {}),
      // `true` is the default and stays unwritten; a parked subscription says so (DS-16).
      ...(isActive === false ? { isActive: false } : {}),
    },
  };
}

/** The stored manifest back as the form: the same pair, so the YAML view and the fields agree. */
export function fromSubscriptionEnvelope(manifest: unknown): SubscriptionForm {
  const envelope = (manifest ?? {}) as {
    metadata?: { name?: string };
    spec?: Record<string, unknown>;
  };
  const spec = envelope.spec ?? {};
  const reference = spec.contextSpaceRef as string | { name?: string } | undefined;
  const notification = (spec.notification ?? {}) as Partial<SubscriptionForm["notification"]>;
  return {
    ...(spec as object),
    name: envelope.metadata?.name ?? "",
    contextSpaceRef: (typeof reference === "string" ? reference : reference?.name) ?? "",
    notification: {
      ...notification,
      endpoint: { uri: "", ...(notification.endpoint ?? {}) },
    },
    isActive: spec.isActive !== false,
  } as SubscriptionForm;
}

/** The secret names this project's subscriptions already carry, offered before a new one is typed. */
function secretNames(subscriptions: Manifest[]): string[] {
  const names = new Set<string>();
  for (const subscription of subscriptions) {
    const name = fromSubscriptionEnvelope(subscription).notification.endpoint.secretRef?.name;
    if (name) names.add(name);
  }
  return [...names].sort();
}

/**
 * What a row says a subscription watches: its types or ids, then its attributes. A type links to
 * the class of the model that carries it (T-2766).
 */
function Watched({ project, form }: { project: string; form: SubscriptionForm }): JSX.Element {
  const parts: ReactNode[] = [
    ...selectors(form.entities).map((selector, index) =>
      typeof selector.type === "string" ? (
        <TypeLink key={`t${index}`} project={project} type={selector.type} space={form.contextSpaceRef || undefined} />
      ) : (
        String(selector.id ?? selector.idPattern)
      ),
    ),
    ...(form.watchedAttributes ?? []),
  ];
  if (parts.length === 0) {
    return <>—</>;
  }
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index === 0 ? null : ", "}
          {part}
        </Fragment>
      ))}
    </>
  );
}

const COLUMNS = 6;

/**
 * The subscriptions of one project: what each one watches, in which space, and where its
 * notifications go (CC-72, DS-16, UI-01).
 *
 * A Subscription had no form, so a standing query was authored only as YAML (T-2344). The form
 * is the same `ResourceFormDialog` every kind uses, so the YAML view, the draft, the Check and the
 * verdict come with it, and a subscription is proposed as a Change rather than written (UI-44).
 */
export function SubscriptionsPage({ project, edit }: { project: string; edit?: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";
  const queryClient = useQueryClient();
  // The create form is a page at `/{plural}/new` on a routed list (T-2474).
  const [dialogOpen, setDialogOpen, handedDraft] = useCreateFormFromDraft();
  const [form, setForm] = useState<SubscriptionForm | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [change, setChange] = useState<Change | null>(null);

  const list = useQuery({
    queryKey: queryKeys.list(project, "subscriptions"),
    refetchInterval: whilePending,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project, plural: "subscriptions" } },
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
  const subscriptions = asManifests(list.data?.items ?? []);
  const schema = subscriptionSchema(t, spaceNames, secretNames(subscriptions));

  const create = useMutation({
    mutationFn: async (form: SubscriptionForm) => {
      setFormError(null);
      return proposeChecked(
        project,
        "subscriptions",
        toSubscriptionEnvelope(project, form) as ResourceProposal,
        true,
      );
    },
    onSuccess: (result) => {
      if (isChange(result)) {
        setChange(result);
      }
      setDialogOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.list(project, "subscriptions") });
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
    <PermissionGuard project={project} kind="Subscription" verb="propose">
      <Button
        variant="primary"
        icon={<Icon name="plus" className="size-4" />}
        onClick={() => {
          setFormError(null);
          setForm(undefined);
          setDialogOpen(true);
        }}
      >
        {t("subscriptions.add")}
      </Button>
    </PermissionGuard>
  );

  return (
    <div className="flex flex-col gap-section">
      <PageHeader
        title={t("subscriptions.title")}
        description={t("subscriptions.lead")}
        actions={addButton}
      />

      {change ? <ChangeNotice change={change} project={project} /> : null}

      <ResourceList
        query={list}
        caption={t("subscriptions.title")}
        head={
          <TableHead>
            <TableHeaderCell>{t("subscriptions.field.name")}</TableHeaderCell>
            <TableHeaderCell>
              <Term name="contextSpace">{t("subscriptions.field.space")}</Term>
            </TableHeaderCell>
            <TableHeaderCell>{t("subscriptions.field.watches")}</TableHeaderCell>
            <TableHeaderCell>{t("subscriptions.field.receiver")}</TableHeaderCell>
            <TableHeaderCell>{t("resourceList.phase")}</TableHeaderCell>
            <TableHeaderCell align="right">{t("approvals.actions")}</TableHeaderCell>
          </TableHead>
        }
        columns={COLUMNS}
        count={subscriptions.length}
        empty={
          <EmptyState
            bare
            title={t("subscriptions.empty")}
            description={t("subscriptions.addHint")}
            action={addButton}
          />
        }
      >
        {subscriptions.map((subscription: Manifest) => {
          const shape = fromSubscriptionEnvelope(subscription);
          const title = localized(
            subscription.metadata.title,
            locale,
            shape.subscriptionName || subscription.metadata.name,
          );
          const target = {
            project,
            kind: "Subscription",
            plural: "subscriptions",
            name: subscription.metadata.name,
            label: title,
          };
          return (
            <TableRow key={subscription.metadata.name}>
              <TableCell primary>
                <div className="flex items-center gap-2">
                  <span>{title}</span>
                  {shape.isActive === false ? (
                    <Badge tone="warning">{t("subscriptions.paused")}</Badge>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>
                <span className="font-mono text-caption">{shape.contextSpaceRef || "—"}</span>
              </TableCell>
              <TableCell>
                <span className="font-mono text-caption">
                  <Watched project={project} form={shape} />
                </span>
              </TableCell>
              <TableCell>
                <span className="break-all font-mono text-caption">
                  {shape.notification.endpoint.uri || "—"}
                </span>
              </TableCell>
              <TableCell>
                <LifecycleBadge kind="phase" value={subscription.status?.phase} />
              </TableCell>
              <TableCell align="right">
                <ResourceRowActions
                  project={project}
                  target={target}
                  form={{
                    schema,
                    uiSchema: subscriptionUiSchema,
                    fromManifest: (manifest) =>
                      fromSubscriptionEnvelope(manifest) as unknown as Record<string, unknown>,
                    toManifest: (edited, stored) =>
                      toSubscriptionEnvelope(project, edited as unknown as SubscriptionForm, stored),
                  }}
                />
              </TableCell>
            </TableRow>
          );
        })}
      </ResourceList>

      <ResourceFormDialog<SubscriptionForm>
        kind="Subscription"
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={t("subscriptions.add")}
        description={t("subscriptions.addHint")}
        schema={schema}
        uiSchema={subscriptionUiSchema}
        formData={form}
        onChange={setForm}
        project={project}
        draftKind="Subscription"
        draftName={edit ?? handedDraft}
        plural="subscriptions"
        source={{
          toManifest: (form) => toSubscriptionEnvelope(project, form),
          fromManifest: (manifest) => fromSubscriptionEnvelope(manifest),
        }}
        submitLabel={t("subscriptions.propose")}
        submitting={create.isPending}
        error={formError}
        onSubmit={(form) => {
          // The one rule a schema cannot say field by field: something has to be watched. Said
          // here, before a round trip, in the words the person can act on (CC-72).
          if (!watchesSomething(form)) {
            setFormError(t("subscriptions.watchesNothing"));
            return;
          }
          create.mutate(form);
        }}
      />
    </div>
  );
}
