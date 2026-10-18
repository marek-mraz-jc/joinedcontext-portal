import { useMemo, useState } from "react";
import type { JSX } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, queryKeys, unwrap } from "../../api/client";
import { ORG_NAMESPACE, asManifests, localized } from "../../api/manifest";
import { useProjects } from "../../api/projects";
import { useBranding } from "../../branding";
import { namedServerUrl } from "../../components/endpoints/links";
import { Alert, Button, Card, Checkbox, Dialog, EmptyState, Field, Input, PageHeader } from "../../components/ui";
import { CopyValue } from "./McpServerPanels";
import { clientConfig } from "./mcp";
import {
  ACCESS_LEVELS,
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
import type { Connector, ConnectorForm, Readable } from "./connectors";

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
    <Button disabled={connectors.length >= MAX_CONNECTORS} onClick={() => setEditing("new")}>
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
  const [refused, setRefused] = useState<string | null>(null);
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
      .catch((error: Error) => setRefused(error.message))
      .finally(() => setSaving(false));
  };
  const text = (field: "projects" | "spaces" | "domains" | "themes") => (
    <Field id={`connector-${field}`} label={t(`connectors.field.${field}`)} help={t(`connectors.help.${field}`)} errors={shown(field)}>
      <Input id={`connector-${field}`} value={form[field]} autoComplete="off" spellCheck={false} onChange={(event) => set({ [field]: event.target.value })} />
    </Field>
  );
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
          {text("projects")}
          {text("spaces")}
          {text("domains")}
          {text("themes")}
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
        {refused ? (
          <Alert tone="danger" role="alert">
            {refused}
          </Alert>
        ) : null}
      </div>
    </Dialog>
  );
}
