import { useMemo, useState } from "react";
import type { JSX } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, queryKeys, unwrap } from "../../api/client";
import { ORG_NAMESPACE, asManifests, localized } from "../../api/manifest";
import { useProjects } from "../../api/projects";
import { Combobox } from "../../components/pickers/Combobox";
import type { PickerOption } from "../../components/pickers/Combobox";
import { useThemeLabel } from "../catalogue/CataloguePage";
import { THEMES } from "../catalogue/publish";
import { useBranding } from "../../branding";
import { namedServerUrl } from "../../components/endpoints/links";
import { Alert, Button, Card, Checkbox, Dialog, EmptyState, Field, Input, PageHeader } from "../../components/ui";
import { CopyValue } from "./McpServerPanels";
import { clientConfig } from "./mcp";
import {
  ACCESS_LEVELS,
  DOMAINS,
  MAX_CONNECTORS,
  asReadable,
  connectorProblems,
  connectorUrl,
  fromForm,
  reach,
  saveConnectors,
  toForm,
  useConnectors,
} from "./connectors";
import type { Connector, ConnectorForm, ConnectorRefusal, Readable } from "./connectors";

/** Every Endpoint the person may read, across the projects they see (SP-20). */
function useReadable(): Readable[] {
  const projects = useProjects();
  const lists = useQueries({
    queries: (projects.data ?? []).map((name) => ({
      queryKey: queryKeys.list(name, "endpoints"),
      queryFn: async () =>
        unwrap(await api.GET("/api/v1/projects/{project}/{plural}", { params: { path: { project: name, plural: "endpoints" } } })),
    })),
  });
  return useMemo(
    () =>
      (projects.data ?? []).flatMap((name, index) =>
        asManifests(lists[index]?.data?.items ?? [])
          .map((endpoint) => asReadable(name, endpoint))
          .filter((one): one is Readable => one !== null),
      ),
    [projects.data, lists],
  );
}

/** The context spaces of these projects the person may read: the server filters each list. */
function useReadableSpaces(projects: string[]): { items: { project: string; name: string; title: string }[]; loading: boolean } {
  const { i18n } = useTranslation();
  const lists = useQueries({
    queries: projects.map((name) => ({
      queryKey: queryKeys.list(name, "contextspaces"),
      queryFn: async () =>
        unwrap(await api.GET("/api/v1/projects/{project}/{plural}", { params: { path: { project: name, plural: "contextspaces" } } })),
    })),
  });
  return {
    items: projects.flatMap((project, index) =>
      asManifests(lists[index]?.data?.items ?? []).map((space) => ({
        project,
        name: space.metadata.name,
        title: localized(space.metadata.title, i18n.language, space.metadata.name),
      })),
    ),
    loading: lists.some((list) => list.isPending),
  };
}

/**
 * The person's own MCP connectors (UI-98, EP-123, T-4531): each one an address only their token
 * opens, over the Endpoints its selector and favourites pick from what they may read; beside them
 * the organization's servers and `org/all`, which anyone in the organization may connect to.
 */
export function ConnectorsPage(): JSX.Element {
  const { t } = useTranslation();
  const branding = useBranding();
  const connectors = useConnectors();
  const readable = useReadable();
  const [editing, setEditing] = useState<Connector | "new" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const create = (
    <Button
      disabled={connectors.length >= MAX_CONNECTORS}
      disabledReason={t("connectors.full")}
      onClick={() => setEditing("new")}
    >
      {t("connectors.new")}
    </Button>
  );
  const remove = (name: string) => {
    setFailed(null);
    saveConnectors((current) => current.filter((one) => one.name !== name)).catch((error: Error) => setFailed(error.message));
  };

  return (
    <section aria-label={t("connectors.title")} className="space-y-6">
      <PageHeader title={t("connectors.title")} description={t("connectors.lead", { max: MAX_CONNECTORS })} actions={create} />
      {failed ? (
        <Alert tone="danger" role="alert">
          {failed}
        </Alert>
      ) : null}
      {connectors.length === 0 ? <EmptyState title={t("connectors.empty")} description={t("connectors.emptyHint")} icon="endpoints" action={create} /> : null}
      {connectors.map((connector) => (
        <ConnectorCard
          key={connector.name}
          connector={connector}
          url={connectorUrl(branding.domain, connector.name)}
          reached={reach(connector, readable)}
          onEdit={() => setEditing(connector)}
          onRemove={() => remove(connector.name)}
        />
      ))}
      <OrganizationServers domain={branding.domain} />
      {editing !== null ? (
        <ConnectorDialog
          stored={editing === "new" ? undefined : editing}
          others={connectors.filter((one) => editing === "new" || one.name !== editing.name)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}

function ConnectorCard({
  connector,
  url,
  reached,
  onEdit,
  onRemove,
}: {
  connector: Connector;
  url: string;
  reached: Readable[];
  onEdit: () => void;
  onRemove: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { name } = connector;
  const narrowedAtGateway = Boolean(connector.select?.domains?.length || connector.select?.themes?.length);
  const titleId = `connector-${name}`;
  return (
    <Card>
      <section aria-labelledby={titleId} className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id={titleId} className="font-mono text-title font-semibold">
            {name}
          </h2>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" aria-label={t("connectors.editOf", { name })} onClick={onEdit}>
              {t("connectors.edit")}
            </Button>
            <Button variant="danger" size="sm" aria-label={t("connectors.removeOf", { name })} onClick={onRemove}>
              {t("connectors.remove")}
            </Button>
          </div>
        </div>
        <CopyValue label={t("mcp.address")} value={url} />
        <CopyValue label={t("mcp.config")} value={clientConfig(url, name)} code />
        <div>
          <h3 className="text-body font-semibold">{t("connectors.reach", { count: reached.length })}</h3>
          <ul aria-label={t("connectors.reachOf", { name })} className="flex flex-wrap gap-2">
            {reached.map((endpoint) => (
              <li key={endpoint.slug} className="rounded-md border border-border px-2 py-1 font-mono text-caption">
                {endpoint.project}/{endpoint.name}
              </li>
            ))}
          </ul>
          {narrowedAtGateway ? <p className="text-caption text-fg-muted">{t("connectors.narrowedAtGateway")}</p> : null}
        </div>
      </section>
    </Card>
  );
}

/** The organization's named servers and `org/all`, the picker's other half (EP-122). */
function OrganizationServers({ domain }: { domain: string | undefined }): JSX.Element {
  const { t, i18n } = useTranslation();
  const servers = useQuery({
    queryKey: queryKeys.list(ORG_NAMESPACE, "mcpservers"),
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/projects/{project}/{plural}", { params: { path: { project: ORG_NAMESPACE, plural: "mcpservers" } } })),
  });
  const named = asManifests(servers.data?.items ?? []).filter((server) => server.metadata.name !== "all");
  return (
    <Card>
      <section aria-labelledby="connectors-org" className="flex flex-col gap-3">
        <h2 id="connectors-org" className="text-title font-semibold">
          {t("connectors.organization")}
        </h2>
        <p className="text-caption text-fg-muted">{t("connectors.organizationLead")}</p>
        <CopyValue label={t("connectors.all")} value={namedServerUrl(domain, ORG_NAMESPACE, "all")} />
        {named.map((server) => (
          <CopyValue
            key={server.metadata.name}
            label={localized(server.metadata.title, i18n.language, server.metadata.name)}
            value={namedServerUrl(domain, ORG_NAMESPACE, server.metadata.name)}
          />
        ))}
      </section>
    </Card>
  );
}

function ConnectorDialog({ stored, others, onClose }: { stored?: Connector; others: Connector[]; onClose: () => void }): JSX.Element {
  const { t } = useTranslation();
  const [form, setForm] = useState<ConnectorForm>(() => toForm(stored));
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<{ message: string; fields: string[] } | null>(null);
  const projects = useProjects();
  const spaces = useReadableSpaces(projects.data ?? []);
  const themeLabel = useThemeLabel();
  const connector = fromForm(form);
  const problems = connectorProblems(connector, others);
  const set = (patch: Partial<ConnectorForm>) => setForm((current) => ({ ...current, ...patch }));
  const shown = (field: string) => (tried && problems[field] ? [t(problems[field])] : undefined);
  const submit = () => {
    setTried(true);
    if (Object.keys(problems).length > 0) return;
    setSaving(true);
    setRefused(null);
    saveConnectors((current) =>
      stored ? current.map((one) => (one.name === stored.name ? connector : one)) : [...current, connector],
    )
      .then(onClose)
      .catch((error: ConnectorRefusal) => setRefused({ message: error.message, fields: error.fields ?? [] }))
      .finally(() => setSaving(false));
  };
  // Each selector field picks from what the server lists for this person, and the server checks
  // each value again on save (T-4948): its refusal shows beside the field it names.
  const picker = (
    field: "projects" | "spaces" | "domains" | "themes",
    options: PickerOption[],
    list: { loading?: boolean; empty: string },
  ) => {
    const refusedHere = refused?.fields.includes(field) ? [refused.message] : undefined;
    return (
      <Field id={`connector-${field}`} label={t(`connectors.field.${field}`)} help={t(`connectors.help.${field}`)} errors={refusedHere ?? shown(field)}>
        <Combobox
          id={`connector-${field}`}
          labelled
          label={t(`connectors.field.${field}`)}
          multiple
          value={form[field]}
          onChange={(values) => set({ [field]: values })}
          options={options}
          loading={list.loading}
          invalid={Boolean(refusedHere)}
          empty={list.empty}
        />
      </Field>
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      size="lg"
      title={stored ? t("connectors.editTitle", { name: stored.name }) : t("connectors.newTitle")}
      description={t("connectors.formLead")}
      closeLabel={t("app.close")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("form.cancel")}
          </Button>
          <Button loading={saving} onClick={submit}>
            {t("connectors.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field id="connector-name" label={t("connectors.field.name")} required help={t("connectors.help.name")} errors={shown("name")}>
          <Input id="connector-name" value={form.name} autoComplete="off" spellCheck={false} onChange={(event) => set({ name: event.target.value.trim() })} />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          {picker(
            "projects",
            (projects.data ?? []).map((name) => ({ value: name, label: name, group: t("connectors.field.projects") })),
            { loading: projects.isPending, empty: t("connectors.noMatch.projects") },
          )}
          {picker(
            "spaces",
            spaces.items
              .filter((space) => form.projects.length === 0 || form.projects.includes(space.project))
              .map((space) => ({ value: `${space.project}/${space.name}`, label: space.title, detail: `${space.project}/${space.name}`, group: space.project })),
            { loading: spaces.loading, empty: t("connectors.noMatch.spaces") },
          )}
          {picker(
            "domains",
            DOMAINS.map((domain) => ({ value: domain, label: domain, group: t("connectors.field.domains") })),
            { empty: t("connectors.noMatch.none") },
          )}
          {picker(
            "themes",
            THEMES.map((theme) => ({ value: theme, label: themeLabel(theme), detail: theme, group: t("connectors.field.themes") })),
            { empty: t("connectors.noMatch.none") },
          )}
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-body font-semibold">{t("connectors.field.accessLevel")}</legend>
          {ACCESS_LEVELS.map((level) => (
            <Checkbox
              key={level}
              label={t(`connectors.level.${level}`)}
              checked={form.accessLevel.includes(level)}
              onChange={(event) =>
                set({ accessLevel: event.target.checked ? [...form.accessLevel, level] : form.accessLevel.filter((one) => one !== level) })
              }
            />
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-body font-semibold">{t("connectors.field.endpoints", { count: form.endpoints.length })}</legend>
          {form.endpoints.length === 0 ? <p className="text-caption text-fg-muted">{t("connectors.help.endpoints")}</p> : null}
          {form.endpoints.map((slug) => (
            <Checkbox key={slug} label={slug} checked onChange={() => set({ endpoints: form.endpoints.filter((one) => one !== slug) })} />
          ))}
        </fieldset>
        {shown("select") ? <Alert tone="danger">{shown("select")?.[0]}</Alert> : null}
        {refused && refused.fields.length === 0 ? (
          <Alert tone="danger" role="alert">
            {refused.message}
          </Alert>
        ) : null}
      </div>
    </Dialog>
  );
}
