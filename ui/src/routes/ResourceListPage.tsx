import { useState } from "react";
import type { JSX } from "react";
import { ResourceList } from "../components/ResourceList";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap, whilePending } from "../api/client";
import { NotFoundState } from "../components/NotFoundState";
import { asManifests, isChange, localized } from "../api/manifest";
import type { Change, ResourceProposal } from "../api/manifest";
import { proposeChecked } from "../api/proposal";
import { ChangeNotice } from "../components/ChangeNotice";
import { ResourceFormDialog } from "../components/ResourceFormDialog";
import { useCreateFormFromDraft } from "../components/forms/FormRoute";
import { PermissionGuard } from "../components/ui/PermissionGuard";
import { humanizeName } from "../pages/apps/appTitle";
import { ResourceRowActions } from "../components/ResourceRowActions";
import type { EditableForm } from "../components/EditResourceDialog";
import {
  fromMappingManifest,
  mappingSchema,
  mappingUiSchema,
  toMappingManifest,
} from "../schemas/mapping";
import type { MappingForm } from "../schemas/mapping";
import { dataModelSchema, fromDataModelManifest, toDataModelManifest } from "../schemas/datamodel";
import type { DataModelForm } from "../schemas/datamodel";
import { dataAgreementSchema, fromDataAgreementManifest, toDataAgreementManifest } from "../schemas/dataagreement";
import { blueprintSchema, blueprintUiSchema, fromBlueprintManifest, toBlueprintManifest } from "../schemas/blueprint";
import type { BlueprintForm } from "../schemas/blueprint";
import {
  agentProfileSchema,
  agentProfileUiSchema,
  fromAgentProfileManifest,
  toAgentProfileManifest,
} from "../schemas/agentprofile";
import type { AgentProfileForm } from "../schemas/agentprofile";
import { dataOfferSchema, dataOfferUiSchema, fromDataOfferManifest, toDataOfferManifest } from "../schemas/dataoffer";
import type { DataOfferForm } from "../schemas/dataoffer";
import {
  dataSpaceParticipantSchema,
  fromDataSpaceParticipantManifest,
  toDataSpaceParticipantManifest,
} from "../schemas/dataspaceparticipant";
import type { DataSpaceParticipantForm } from "../schemas/dataspaceparticipant";
import { environmentSchema, fromEnvironmentManifest, toEnvironmentManifest } from "../schemas/environment";
import type { EnvironmentForm } from "../schemas/environment";
import type { DataAgreementForm } from "../schemas/dataagreement";
import { LifecycleBadge } from "../components/status/LifecycleBadge";
import {
  Button,
  EmptyState,
  Icon,
  PageHeader,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../components/ui";
import { SpacesPage } from "./SpacesPage";
import { EndpointsPage } from "./EndpointsPage";
import { DashboardsPage } from "./DashboardsPage";
import { PipelinesPage } from "./PipelinesPage";
import { PoliciesPage } from "./PoliciesPage";
import { SubscriptionsPage } from "./SubscriptionsPage";
import { RegistrationsPage } from "./RegistrationsPage";
import { DataSourcesPage } from "../pages/datasources/DataSourcesPage";
import { FlowGallery } from "../pages/flows/Gallery";
import { AppsCatalog } from "../pages/apps/AppsCatalog";
import { SyncSourcesPage } from "../pages/sync/SyncSourcesPage";

const VIEWS: Record<string, (props: { project: string; edit?: string }) => JSX.Element> = {
  spaces: SpacesPage,
  endpoints: EndpointsPage,
  pipelines: PipelinesPage,
  // A Policy is authored through a form like every other kind, not as YAML (T-2326).
  policies: PoliciesPage,
  // A Subscription is authored through a form too, not as YAML (T-2344).
  subscriptions: SubscriptionsPage,
  // A ContextSourceRegistration too: which space's broker answers with whose data (T-2345, MF-36).
  csrs: RegistrationsPage,
  datasources: DataSourcesPage,
  dashboards: DashboardsPage,
  // "flows" is a section too: the gallery reads organization-level Blueprints, not a project
  // collection, and the wizard writes through /flows rather than a resource route (CC-30).
  flows: FlowGallery,
  // Apps are a kind, but a card catalogue with a preview frame and a publication action, not
  // a manifest table (AP-18, AP-19, AP-20).
  apps: AppsCatalog,
  // A SyncSource is a running loop as well as a manifest, so its view carries the phase, the
  // revision it carries and the three buttons of MF-30.
  syncsources: SyncSourcesPage,
};

/**
 * The edit form of a kind that has no page of its own. It writes onto the manifest the edit dialog
 * read, so it keeps what it does not show (T-2354). A kind not listed here opens as YAML.
 */
const EDIT_FORMS: Record<string, (t: (key: string) => string, project: string) => EditableForm> = {
  mappings: (t) => ({
    schema: mappingSchema(t),
    uiSchema: mappingUiSchema,
    fromManifest: (manifest) => fromMappingManifest(manifest) as Record<string, unknown>,
    toManifest: (form, stored) => toMappingManifest(stored, form as MappingForm),
  }),
  datamodels: (t) => ({
    schema: dataModelSchema(t),
    fromManifest: (manifest) => fromDataModelManifest(manifest) as Record<string, unknown>,
    toManifest: (form, stored) => toDataModelManifest(stored, form as DataModelForm),
  }),
  dataagreements: (t, project) => ({
    schema: dataAgreementSchema(t),
    fromManifest: (manifest) => fromDataAgreementManifest(manifest) as Record<string, unknown>,
    toManifest: (form, stored) => toDataAgreementManifest(project, form as DataAgreementForm, stored),
  }),
  dataoffers: (t, project) => ({
    schema: dataOfferSchema(t),
    uiSchema: dataOfferUiSchema,
    fromManifest: (manifest) => fromDataOfferManifest(manifest) as Record<string, unknown>,
    toManifest: (form, stored) => toDataOfferManifest(project, form as DataOfferForm, stored),
  }),
  blueprints: (t) => ({
    schema: blueprintSchema(t),
    uiSchema: blueprintUiSchema,
    fromManifest: (manifest) => fromBlueprintManifest(manifest) as Record<string, unknown>,
    toManifest: (form, stored) => toBlueprintManifest(form as BlueprintForm, stored),
  }),
  dataspaceparticipants: (t) => ({
    schema: dataSpaceParticipantSchema(t),
    fromManifest: (manifest) => fromDataSpaceParticipantManifest(manifest) as Record<string, unknown>,
    toManifest: (form, stored) => toDataSpaceParticipantManifest(form as DataSpaceParticipantForm, stored),
  }),
  environments: (t) => ({
    schema: environmentSchema(t),
    fromManifest: (manifest) => fromEnvironmentManifest(manifest) as Record<string, unknown>,
    toManifest: (form, stored) => toEnvironmentManifest(form as EnvironmentForm, stored),
  }),
  agentprofiles: (t) => ({
    schema: agentProfileSchema(t),
    uiSchema: agentProfileUiSchema,
    fromManifest: (manifest) => fromAgentProfileManifest(manifest) as Record<string, unknown>,
    toManifest: (form, stored) => toAgentProfileManifest(form as AgentProfileForm, stored),
  }),
};

/**
 * The kinds a person creates from their list with the form above, by the kind's name (T-1542). A
 * Mapping is created on the Models page's Mappings view, which writes its transformation and golden
 * tests; a DataModel in the LinkML editor. Neither is offered here.
 */
const CREATE_KINDS: Record<string, string> = {
  dataagreements: "DataAgreement",
  dataoffers: "DataOffer",
  blueprints: "Blueprint",
  agentprofiles: "AgentProfile",
  dataspaceparticipants: "DataSpaceParticipant",
  environments: "Environment",
};

/**
 * Kinds jc-core keeps one of per organization, at one path whatever the name (T-1544): New is offered
 * only once the list has answered that there is none, so a second one is never proposed over the first.
 */
const ONE_PER_ORGANIZATION = new Set(["dataspaceparticipants"]);

/** `/api/v1/projects/{project}/{plural}`: a kind's own page, or its resources in a table (MF-11…MF-15). */
export function ResourceListPage({
  project,
  plural,
  edit,
}: {
  project: string;
  plural: string;
  /** `?edit=<name>`: open this kind's own editor on that resource at once (T-2281). */
  edit?: string;
}): JSX.Element {
  const View = VIEWS[plural];
  if (View) {
    return <View project={project} edit={edit} />;
  }
  return <KindList project={project} plural={plural} />;
}

/**
 * The resources of one kind in a table, with the kind's form to create and edit them where it has
 * one. A page of its own for a project's kinds; `embedded` in a tab of another page, such as the
 * Organization's, where the page already carries the heading of level one.
 */
export function KindList({
  project,
  plural,
  embedded = false,
}: {
  project: string;
  plural: string;
  embedded?: boolean;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";
  const queryClient = useQueryClient();
  const form = EDIT_FORMS[plural]?.(t, project);
  const createKind = form ? CREATE_KINDS[plural] : undefined;
  // The create form is a page at `/{plural}/new` on a routed list (T-2474).
  const [dialogOpen, setDialogOpen, handedDraft] = useCreateFormFromDraft();
  const [values, setValues] = useState<Record<string, unknown> | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [change, setChange] = useState<Change | null>(null);
  const create = useMutation({
    mutationFn: (next: Record<string, unknown>) => {
      setFormError(null);
      return proposeChecked(project, plural, form?.toManifest(next, undefined) as ResourceProposal, true);
    },
    onSuccess: (result) => {
      if (isChange(result)) setChange(result);
      setDialogOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.list(project, plural) });
    },
    onError: (err) =>
      setFormError(
        err instanceof ApiError
          ? (err.problem?.detail ?? err.message)
          : err instanceof Error
            ? err.message
            : t("app.error.generic"),
      ),
  });
  const list = useQuery({
    queryKey: queryKeys.list(project, plural),
    // A change on its way polls until it lands (T-1392).
    refetchInterval: whilePending,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project, plural } },
        }),
      ),
  });

  // The API is what knows the project's kinds: a plural it does not serve is an address with no
  // page, not a list that failed and could be tried again (T-2749, UI-15).
  if (list.error instanceof ApiError && list.error.status === 404) {
    return <NotFoundState />;
  }
  const items = asManifests(list.data?.items ?? []);
  // A kind with no page of its own still opens under a heading that names it, in the person's
  // own language where the navigation already has a word for it, and read as words where it
  // does not — never the bare URL segment the table used as its caption (UI-01, UI-16).
  const title = t(`nav.${plural}`, { defaultValue: humanizeName(plural) });
  const newButton =
    createKind && form && !(ONE_PER_ORGANIZATION.has(plural) && (list.data === undefined || items.length > 0)) ? (
      <PermissionGuard project={project} kind={createKind} verb="propose">
        <Button
          variant="primary"
          icon={<Icon name="plus" className="size-4" />}
          onClick={() => {
            setFormError(null);
            setValues(undefined);
            setDialogOpen(true);
          }}
        >
          {t("resourceList.new", { kind: createKind })}
        </Button>
      </PermissionGuard>
    ) : undefined;
  return (
    <div className="flex flex-col gap-section">
      {embedded ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-title font-semibold text-fg">{title}</h2>
            <p className="text-body text-fg-muted">{t("resourceList.lead", { kind: title })}</p>
          </div>
          {newButton}
        </div>
      ) : (
        <PageHeader title={title} description={t("resourceList.lead", { kind: title })} actions={newButton} />
      )}
      {change ? <ChangeNotice change={change} project={project} /> : null}
      <ResourceList
      query={list}
      caption={title}
      head={
        <TableHead>
          <TableHeaderCell>{t("resourceList.name")}</TableHeaderCell>
          <TableHeaderCell>{t("resourceList.phase")}</TableHeaderCell>
          <TableHeaderCell align="right">{t("approvals.actions")}</TableHeaderCell>
        </TableHead>
      }
      columns={3}
      count={items.length}
      empty={<EmptyState bare
            title={t("resourceList.empty")}
            // A page with no create action names none in its hint (T-2488).
            description={
              newButton
                ? t("resourceList.emptyHintCreate", { kind: createKind })
                : t(`resourceList.emptyHintFor.${plural}`, { defaultValue: t("resourceList.emptyHint") })
            }
            action={newButton} />}
    >
      {items.map((item) => {
          const title = localized(item.metadata.title, locale, item.metadata.name);
          const target = { project, kind: item.kind, plural, name: item.metadata.name, label: title };
          return (
            <TableRow key={item.metadata.name}>
              <TableCell primary>
                <div>{title}</div>
                {item.metadata.title ? (
                  <div className="mt-0.5 font-mono text-caption text-fg-subtle">{item.metadata.name}</div>
                ) : null}
              </TableCell>
              <TableCell>
                <LifecycleBadge kind="phase" value={item.status?.phase} />
              </TableCell>
              <TableCell align="right">
                {/* One menu at the end of the row, for every kind that falls through here (T-2287). */}
                <ResourceRowActions project={project} target={target} form={form} />
              </TableCell>
            </TableRow>
          );
        })}
      </ResourceList>
      {createKind && form ? (
        <ResourceFormDialog<Record<string, unknown>>
          kind={createKind}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title={t("resourceList.new", { kind: createKind })}
          description={t("resourceList.newHint", { kind: createKind })}
          schema={form.schema}
          uiSchema={form.uiSchema}
          formData={values}
          onChange={setValues}
          project={project}
          draftKind={createKind}
          draftName={handedDraft}
          plural={plural}
          source={{
            toManifest: (next) => form.toManifest(next, undefined),
            fromManifest: (manifest) => form.fromManifest(manifest),
          }}
          submitLabel={t("resourceList.propose")}
          submitting={create.isPending}
          error={formError}
          onSubmit={(next) => create.mutate(next)}
        />
      ) : null}
    </div>
  );
}
