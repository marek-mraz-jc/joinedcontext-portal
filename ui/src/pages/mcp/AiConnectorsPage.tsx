import { useState } from "react";
import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError, api, unwrap } from "../../api/client";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageFailed,
  PageHeader,
  PageLoading,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../components/ui";
import { CopyValue } from "./McpServerPanels";
import { emptyForm, formProblems, lastDay, pickKey, refusedSection, scopeLines, setup, toForm, toRequest } from "./aiConnectors";
import type { AiConnector, AiConnectorForm, ConnectorOptions, Pick, PickKind } from "./aiConnectors";

const KEY = ["ai-connectors"] as const;
const OPTIONS_KEY = ["ai-connectors", "options"] as const;

function useOptions() {
  return useQuery({ queryKey: OPTIONS_KEY, queryFn: async () => unwrap(await api.GET("/api/v1/connectors/options")) });
}

/**
 * The person's AI connectors (AG-142, API/14, T-5951): each a Portal MCP address an AI client
 * adds, reaching only the projects, spaces, Endpoints and pipelines ticked here, never more than
 * the person may do themself. The page shows no token: the client signs the person in itself.
 */
export function AiConnectorsPage(): JSX.Element {
  const { t } = useTranslation();
  const list = useQuery({ queryKey: KEY, queryFn: async () => unwrap(await api.GET("/api/v1/connectors")) });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  const live = items.filter((one) => one.state === "active").length;
  const create = (
    <Button disabled={live >= 20} disabledReason={t("aiConnectors.full")} onClick={() => setCreating(true)}>
      {t("aiConnectors.new")}
    </Button>
  );
  return (
    <section aria-label={t("aiConnectors.title")} className="space-y-6">
      <PageHeader title={t("aiConnectors.title")} description={t("aiConnectors.lead")} actions={create} />
      {list.isPending ? <PageLoading label={t("aiConnectors.loading")} /> : null}
      {list.isError ? <PageFailed error={list.error} onRetry={() => void list.refetch()} /> : null}
      {list.isSuccess && items.length === 0 ? (
        <EmptyState title={t("aiConnectors.empty")} description={t("aiConnectors.emptyHint")} icon="endpoints" action={create} />
      ) : null}
      {items.map((connector) => (
        <AiConnectorCard key={connector.id} connector={connector} justCreated={connector.id === created} />
      ))}
      {creating ? (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreated(id);
            setCreating(false);
          }}
        />
      ) : null}
    </section>
  );
}

const STATE_TONE = { active: "success", expired: "warning", revoked: "neutral" } as const;

export function AiConnectorCard({ connector, justCreated }: { connector: AiConnector; justCreated?: boolean }): JSX.Element {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [showSetup, setShowSetup] = useState(Boolean(justCreated));
  const [showActivity, setShowActivity] = useState(false);
  const [editing, setEditing] = useState(false);
  const revoke = useMutation({
    mutationFn: async () => unwrap(await api.DELETE("/api/v1/connectors/{id}", { params: { path: { id: connector.id } } })),
    onSuccess: () => {
      setConfirming(false);
      void client.invalidateQueries({ queryKey: KEY });
    },
  });
  const when = (at: string | null | undefined) => (at ? new Date(at).toLocaleString(i18n.language) : t("aiConnectors.never"));
  const titleId = `ai-connector-${connector.id}`;
  const active = connector.state === "active";
  return (
    <Card>
      <section aria-labelledby={titleId} className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={titleId} className="font-mono text-title font-semibold">
              {connector.name}
            </h2>
            <Badge tone={STATE_TONE[connector.state as keyof typeof STATE_TONE] ?? "neutral"}>{t(`aiConnectors.state.${connector.state}`)}</Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            {active ? (
              <Button variant="secondary" size="sm" aria-expanded={showSetup} onClick={() => setShowSetup(!showSetup)}>
                {t("aiConnectors.setup")}
              </Button>
            ) : null}
            {connector.state !== "revoked" ? (
              <Button variant="secondary" size="sm" aria-label={t("aiConnectors.editOf", { name: connector.name })} onClick={() => setEditing(true)}>
                {t("aiConnectors.edit")}
              </Button>
            ) : null}
            <Button variant="secondary" size="sm" aria-expanded={showActivity} onClick={() => setShowActivity(!showActivity)}>
              {t("aiConnectors.activity")}
            </Button>
            {active ? (
              <Button variant="danger" size="sm" aria-label={t("aiConnectors.revokeOf", { name: connector.name })} onClick={() => setConfirming(true)}>
                {t("aiConnectors.revoke")}
              </Button>
            ) : null}
          </div>
        </div>
        {confirming ? (
          <Alert tone="warning" role="alert">
            <p>{t("aiConnectors.revokeConfirm", { name: connector.name })}</p>
            {revoke.isError ? <p>{revoke.error.message}</p> : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="danger" size="sm" loading={revoke.isPending} onClick={() => revoke.mutate()}>
                {t("aiConnectors.revokeNow")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
                {t("aiConnectors.keep")}
              </Button>
            </div>
          </Alert>
        ) : null}
        <dl className="grid gap-x-6 gap-y-2 text-body sm:grid-cols-2">
          <div>
            <dt className="text-caption font-semibold">{t("aiConnectors.field.scope")}</dt>
            <dd>
              <ul aria-label={t("aiConnectors.scopeOf", { name: connector.name })}>
                {scopeLines(connector.scope).map((line) => (
                  <li key={`${line.where}/${line.kind}/${line.name ?? ""}`}>
                    <span className="font-mono">{line.where}</span>
                    {line.name ? ` / ${t(`aiConnectors.kind.${line.kind}`)} ` : ` (${t("aiConnectors.kind.project")})`}
                    {line.name ? <span className="font-mono">{line.name === "*" ? t("aiConnectors.every") : line.name}</span> : null}
                    {" · "}
                    {t(`aiConnectors.access.${line.access}`)}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
          <div>
            <dt className="text-caption font-semibold">{t("aiConnectors.field.segments")}</dt>
            <dd>{connector.segments.map((segment) => t(`aiConnectors.segment.${segment}`)).join(", ")}</dd>
          </div>
          <div>
            <dt className="text-caption font-semibold">{t("aiConnectors.field.clients")}</dt>
            <dd>
              {connector.allowedClients.length === 0
                ? t("aiConnectors.anyClient")
                : connector.allowedClients.map((id) => t(`aiConnectors.client.${id}`, { defaultValue: id })).join(", ")}
            </dd>
          </div>
          <div>
            <dt className="text-caption font-semibold">{t("aiConnectors.lastCall")}</dt>
            <dd>{when(connector.lastUsedAt)}</dd>
          </div>
          <div>
            <dt className="text-caption font-semibold">{t("aiConnectors.field.expires")}</dt>
            <dd>{when(connector.expiresAt)}</dd>
          </div>
        </dl>
        {showSetup && active ? <SetupPanel name={connector.name} url={connector.url} /> : null}
        {showActivity ? <ActivityTable id={connector.id} name={connector.name} /> : null}
        {editing ? <CreateDialog stored={connector} onClose={() => setEditing(false)} onCreated={() => setEditing(false)} /> : null}
      </section>
    </Card>
  );
}

/** What to paste into each AI client; the client then signs the person in (OAuth), no token here. */
export function SetupPanel({ name, url }: { name: string; url: string }): JSX.Element {
  const { t } = useTranslation();
  const snippets = setup(name, url);
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <h3 className="text-body font-semibold">{t("aiConnectors.setupTitle")}</h3>
      <CopyValue label={t("mcp.address")} value={url} />
      <CopyValue label={t("aiConnectors.client.claudeCode")} value={snippets.claudeCode} code />
      <div>
        <h4 className="text-caption font-semibold">{t("aiConnectors.client.claudeAi")}</h4>
        <p className="text-caption text-fg-muted">{t("aiConnectors.steps.claudeAi")}</p>
      </div>
      <div>
        <h4 className="text-caption font-semibold">{t("aiConnectors.client.chatgpt")}</h4>
        <p className="text-caption text-fg-muted">{t("aiConnectors.steps.chatgpt")}</p>
      </div>
      <CopyValue label={t("aiConnectors.client.vscode")} value={snippets.vscode} code />
    </div>
  );
}

export function ActivityTable({ id, name }: { id: string; name: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const calls = useQuery({
    queryKey: [...KEY, id, "activity"],
    queryFn: async () => unwrap(await api.GET("/api/v1/connectors/{id}/activity", { params: { path: { id } } })),
  });
  if (calls.isPending) return <PageLoading label={t("aiConnectors.activityLoading")} lines={1} />;
  if (calls.isError) return <PageFailed error={calls.error} onRetry={() => void calls.refetch()} />;
  if (calls.data.items.length === 0) return <p className="text-caption text-fg-muted">{t("aiConnectors.noCalls")}</p>;
  return (
    <Table caption={t("aiConnectors.activityOf", { name })} maxHeight="max-h-80">
      <TableHead>
        <TableHeaderCell>{t("aiConnectors.call.at")}</TableHeaderCell>
        <TableHeaderCell>{t("aiConnectors.call.tool")}</TableHeaderCell>
        <TableHeaderCell>{t("aiConnectors.call.target")}</TableHeaderCell>
        <TableHeaderCell>{t("aiConnectors.call.client")}</TableHeaderCell>
        <TableHeaderCell>{t("aiConnectors.call.verdict")}</TableHeaderCell>
      </TableHead>
      <TableBody>
        {calls.data.items.map((call, index) => (
          <TableRow key={`${call.at}-${index}`}>
            <TableCell>{new Date(call.at).toLocaleString(i18n.language)}</TableCell>
            <TableCell className="font-mono">{call.tool}</TableCell>
            <TableCell className="font-mono">{call.target ?? "–"}</TableCell>
            <TableCell>{call.client ? t(`aiConnectors.client.${call.client}`, { defaultValue: call.client }) : "–"}</TableCell>
            <TableCell>
              <Badge tone={call.verdict === "allowed" ? "success" : "danger"}>{call.verdict}</Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function picked(form: AiConnectorForm, project: string, kind: PickKind, name?: string): Pick | undefined {
  return form.picks.find((pick) => pickKey(pick) === pickKey({ project, kind, name, access: "read" }));
}

/** The tick tree: only what the server lists for this person, so nothing past their own rights. */
export function ScopeTree({
  options,
  form,
  onChange,
}: {
  options: ConnectorOptions;
  form: AiConnectorForm;
  onChange: (picks: Pick[]) => void;
}): JSX.Element {
  const { t } = useTranslation();
  if (options.projects.length === 0) {
    return <p className="text-caption text-fg-muted">{t("aiConnectors.noProjects")}</p>;
  }
  const toggle = (project: string, kind: PickKind, name: string | undefined, on: boolean) => {
    const key = pickKey({ project, kind, name, access: "read" });
    const rest = form.picks.filter((pick) => pickKey(pick) !== key);
    onChange(on ? [...rest, { project, kind, name, access: "read" }] : rest);
  };
  const setAccess = (pick: Pick, access: "read" | "write") =>
    onChange(form.picks.map((one) => (pickKey(one) === pickKey(pick) ? { ...one, access } : one)));
  const row = (project: string, kind: PickKind, name: string | undefined, label: string, disabledReason?: string) => {
    const pick = picked(form, project, kind, name);
    return (
      <li key={`${kind}/${name ?? ""}`} className="flex flex-wrap items-center gap-2">
        <Checkbox
          label={label}
          checked={Boolean(pick)}
          disabled={Boolean(disabledReason)}
          disabledReason={disabledReason}
          onChange={(event) => toggle(project, kind, name, event.target.checked)}
        />
        {pick ? (
          <Select
            aria-label={t("aiConnectors.accessOf", { what: label })}
            value={pick.access}
            onChange={(event) => setAccess(pick, event.target.value as "read" | "write")}
            className="w-auto"
          >
            <option value="read">{t("aiConnectors.access.read")}</option>
            <option value="write" disabled={!options.ceiling.writes}>
              {options.ceiling.writes ? t("aiConnectors.access.write") : t("aiConnectors.access.writeNeedsApproval")}
            </option>
          </Select>
        ) : null}
      </li>
    );
  };
  return (
    <ul className="flex flex-col gap-3" aria-label={t("aiConnectors.field.scope")}>
      {options.projects.map((project) => {
        const whole = Boolean(picked(form, project.project, "project"));
        const inWhole = whole ? t("aiConnectors.inWholeProject") : undefined;
        const groups: [PickKind, string[]][] = [
          ["space", project.spaces],
          ["endpoint", project.endpoints],
          ["pipeline", project.pipelines],
        ];
        return (
          <li key={project.project} className="rounded-md border border-border p-2">
            <ul className="flex flex-col gap-1">
              {row(project.project, "project", undefined, t("aiConnectors.wholeProject", { project: project.project }))}
            </ul>
            {groups.map(([kind, names]) =>
              names.length > 0 ? (
                <fieldset key={kind} className="ml-6 mt-2">
                  <legend className="text-caption font-semibold">{t(`aiConnectors.kinds.${kind}`)}</legend>
                  <ul className="flex flex-col gap-1">{names.map((name) => row(project.project, kind, name, name, inWhole))}</ul>
                </fieldset>
              ) : null,
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A new connector, or an edit of `stored`: one form, checked by the server again on submit. */
export function CreateDialog({
  stored,
  onClose,
  onCreated,
}: {
  stored?: AiConnector;
  onClose: () => void;
  onCreated: (id: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const client = useQueryClient();
  const options = useOptions();
  const [now] = useState(() => new Date());
  const [form, setForm] = useState<AiConnectorForm | null>(null);
  const [tried, setTried] = useState(false);
  const [refused, setRefused] = useState<{ section?: string; message: string } | null>(null);
  const current = form ?? (stored ? toForm(stored) : emptyForm(options.data, now));
  const set = (patch: Partial<AiConnectorForm>) => setForm({ ...current, ...patch });
  const problems = options.data ? formProblems(current, options.data, now) : {};
  const create = useMutation({
    mutationFn: async () => {
      const { segments, scope, writes, expiresAt, allowedClients } = toRequest(current);
      return stored
        ? unwrap(
            await api.PATCH("/api/v1/connectors/{id}", {
              params: { path: { id: stored.id } },
              body: { segments, scope, writes, expiresAt, allowedClients },
            }),
          )
        : unwrap(await api.POST("/api/v1/connectors", { body: toRequest(current) }));
    },
    onSuccess: (connector) => {
      void client.invalidateQueries({ queryKey: KEY });
      // A create without `?dryRun` answers the connector; the dry run's `{valid}` is never asked here.
      if ("id" in connector) onCreated(connector.id);
    },
    onError: (error: Error) => {
      const problem = error instanceof ApiError ? error.problem : undefined;
      setRefused({ section: refusedSection(problem?.errors ?? undefined, problem?.detail ?? error.message), message: problem?.detail ?? error.message });
    },
  });
  const errorsOf = (section: string) =>
    refused?.section === section ? [refused.message] : tried && problems[section] ? [t(problems[section])] : undefined;
  const submit = () => {
    setTried(true);
    setRefused(null);
    if (Object.keys(problems).length === 0) create.mutate();
  };
  const ceiling = options.data?.ceiling;
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      size="lg"
      title={stored ? t("aiConnectors.editTitle", { name: stored.name }) : t("aiConnectors.newTitle")}
      description={t("aiConnectors.formLead")}
      closeLabel={t("app.close")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("form.cancel")}
          </Button>
          <Button loading={create.isPending} disabled={!options.data} disabledReason={t("aiConnectors.loadingOptions")} onClick={submit}>
            {stored ? t("aiConnectors.save") : t("aiConnectors.create")}
          </Button>
        </>
      }
    >
      {options.isPending ? <PageLoading label={t("aiConnectors.loadingOptions")} /> : null}
      {options.isError ? <PageFailed error={options.error} onRetry={() => void options.refetch()} /> : null}
      {options.data && ceiling ? (
        <div className="flex flex-col gap-4">
          <Field
            id="ai-connector-name"
            label={t("aiConnectors.field.name")}
            required
            help={stored ? t("aiConnectors.help.nameStays") : t("aiConnectors.help.name")}
            errors={errorsOf("name")}
          >
            <Input
              id="ai-connector-name"
              value={current.name}
              readOnly={Boolean(stored)}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set({ name: event.target.value.trim() })}
            />
          </Field>
          <fieldset className="flex flex-col gap-1" aria-describedby="ai-connector-segments-help">
            <legend className="text-body font-semibold">{t("aiConnectors.field.segments")}</legend>
            <p id="ai-connector-segments-help" className="text-caption text-fg-muted">
              {t("aiConnectors.help.segments")}
            </p>
            {options.data.segments.map((segment) => {
              const allowed = ceiling.segments.includes(segment);
              return (
                <Checkbox
                  key={segment}
                  label={t(`aiConnectors.segment.${segment}`)}
                  hint={allowed ? t(`aiConnectors.segmentHint.${segment}`) : t("aiConnectors.needsApproval")}
                  checked={current.segments.includes(segment)}
                  disabled={!allowed}
                  disabledReason={allowed ? undefined : t("aiConnectors.aboveCeiling")}
                  onChange={(event) =>
                    set({ segments: event.target.checked ? [...current.segments, segment] : current.segments.filter((one) => one !== segment) })
                  }
                />
              );
            })}
            {errorsOf("segments") ? <Alert tone="danger">{errorsOf("segments")?.[0]}</Alert> : null}
          </fieldset>
          <fieldset className="flex flex-col gap-1" aria-describedby="ai-connector-scope-help">
            <legend className="text-body font-semibold">{t("aiConnectors.field.scope")}</legend>
            <p id="ai-connector-scope-help" className="text-caption text-fg-muted">
              {t("aiConnectors.help.scope")}
            </p>
            <ScopeTree options={options.data} form={current} onChange={(picks) => set({ picks })} />
            {errorsOf("scope") ? <Alert tone="danger">{errorsOf("scope")?.[0]}</Alert> : null}
          </fieldset>
          <Field
            id="ai-connector-expires"
            label={t("aiConnectors.field.expires")}
            required
            help={t("aiConnectors.help.expires", { days: ceiling.maxDays })}
            errors={errorsOf("expiresAt")}
          >
            <Input
              id="ai-connector-expires"
              type="date"
              value={current.expires}
              min={now.toISOString().slice(0, 10)}
              max={lastDay(ceiling.maxDays, now)}
              onChange={(event) => set({ expires: event.target.value })}
            />
          </Field>
          <fieldset className="flex flex-col gap-1" aria-describedby="ai-connector-clients-help">
            <legend className="text-body font-semibold">{t("aiConnectors.field.clients")}</legend>
            <p id="ai-connector-clients-help" className="text-caption text-fg-muted">
              {t("aiConnectors.help.clients")}
            </p>
            {options.data.clients.map((one) => (
              <Checkbox
                key={one.id}
                label={t(`aiConnectors.client.${one.id}`, { defaultValue: one.id })}
                hint={one.isBoundary ? t("aiConnectors.binds") : t("aiConnectors.intendedFor")}
                checked={current.clients.includes(one.id)}
                onChange={(event) =>
                  set({ clients: event.target.checked ? [...current.clients, one.id] : current.clients.filter((id) => id !== one.id) })
                }
              />
            ))}
            {errorsOf("allowedClients") ? <Alert tone="danger">{errorsOf("allowedClients")?.[0]}</Alert> : null}
          </fieldset>
          {refused && !refused.section ? (
            <Alert tone="danger" role="alert">
              {refused.message}
            </Alert>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
