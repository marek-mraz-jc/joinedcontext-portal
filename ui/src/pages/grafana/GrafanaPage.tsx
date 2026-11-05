import { useState } from "react";
import type { JSX, ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, fieldErrors, reasonOf, unwrap } from "../../api/client";
import type { components } from "../../api/schema";
import {
  Alert,
  Badge,
  Button,
  buttonClass,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  PageFailed,
  PageHeader,
  PageLoading,
  Select,
  Skeleton,
  safeHref,
} from "../../components/ui";
import { cellOf } from "../../components/ui/recordView";
import { columnLabel } from "../../components/entities/displayOrder";
import { unitSymbol } from "../../units";

type Item = components["schemas"]["VisualizationItem"];
type Kind = components["schemas"]["Kind"];
type Options = components["schemas"]["GrafanaOptions"];

const KINDS: readonly Kind[] = ["timeseries", "stat", "table", "map"];

const pageKey = (project: string) => ["projects", project, "grafana"];

function useOptions(project: string, endpoint: string, type: string) {
  return useQuery({
    queryKey: [...pageKey(project), "options", endpoint, type],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/grafana/options", {
          params: {
            path: { project },
            query: { endpoint: endpoint || undefined, type: type || undefined },
          },
        }),
      ),
  });
}

/** One saved visualization: what it draws, where it opens, and its removal, asked twice. */
export function SavedVisualization({
  project,
  item,
  mayRemove,
}: {
  project: string;
  item: Item;
  mayRemove: boolean;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const remove = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.DELETE("/api/v1/projects/{project}/grafana/{id}", {
          params: { path: { project, id: item.id } },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: pageKey(project) }),
  });
  const safe = safeHref(item.openUrl);
  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-border py-3 last:border-b-0">
      <div className="min-w-0 flex-1 basis-full sm:basis-60">
        <p className="break-words text-body font-medium text-fg">{item.title}</p>
        <p className="break-words text-caption text-fg-muted">
          {t("grafana.saved.reads", {
            endpoint: item.endpointTitle,
            type: columnLabel(undefined, item.type, i18n.language),
            attribute: columnLabel(undefined, item.attribute, i18n.language),
          })}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{t(`grafana.kind.${item.kind}`)}</Badge>
        {safe ? (
          <a
            className={buttonClass("secondary", "sm")}
            href={safe}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span aria-hidden="true">{t("grafana.saved.openShort")}</span>
            <span className="sr-only">{t("grafana.saved.open", { title: item.title })}</span>
          </a>
        ) : null}
        {mayRemove && !asking ? (
          <Button
            variant="secondary"
            size="sm"
            aria-label={t("grafana.saved.remove", { title: item.title })}
            onClick={() => setAsking(true)}
          >
            {t("grafana.saved.removeShort")}
          </Button>
        ) : null}
        {asking ? (
          <span className="flex items-center gap-2">
            <Button
              variant="danger"
              size="sm"
              disabled={remove.isPending}
              disabledReason={t("grafana.saved.removing")}
              onClick={() => remove.mutate()}
            >
              {t("grafana.saved.confirm")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
              {t("grafana.saved.keep")}
            </Button>
          </span>
        ) : null}
      </div>
      {remove.isError ? (
        <Alert tone="danger" className="basis-full">
          {reasonOf(remove.error)}
        </Alert>
      ) : null}
    </li>
  );
}

/** A value as a line of text; a place by its first coordinates, never as raw JSON. */
/** A preview cell: the value with its unit symbol, and when it was observed. */
function valueText(raw: unknown): { text: string; at?: string } {
  const cell = cellOf(raw);
  if (cell.kind === "nested") return { text: "…", at: cell.at };
  const text = cell.text.replace(/^Point /, "");
  const unit = cell.unit ? unitSymbol(cell.unit) || cell.unit : "";
  return { text: unit ? `${text} ${unit}` : text, at: cell.at };
}

interface PreviewRow {
  id: string;
  name?: unknown;
  [attribute: string]: unknown;
}

/** A row's own name in the reader's language (else English, else any), or the last part of its id. */
function rowName(row: PreviewRow, language: string): string {
  const texts = (row.name as { languageMap?: Record<string, unknown> } | undefined)?.languageMap;
  if (texts && typeof texts === "object") {
    const text = [texts[language.split("-")[0]], texts.en, ...Object.values(texts)].find((one) => typeof one === "string");
    if (typeof text === "string") return text;
  }
  const name = cellOf(row.name);
  return name.kind === "text" && name.text !== "—" ? name.text : (row.id.split(":").pop() ?? row.id);
}

/**
 * The first rows the visualization will draw, read through the Endpoint with the person's own
 * session: what they would see in Grafana, refusals included.
 */
export function VisualizationPreview({
  slug,
  type,
  attribute,
}: {
  slug: string;
  type: string;
  attribute: string;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const when = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" });
  const rows = useQuery({
    queryKey: ["grafana-preview", slug, type, attribute],
    queryFn: async (): Promise<PreviewRow[]> => {
      const query = new URLSearchParams({ type, attrs: `name,${attribute}`, limit: "5" });
      const response = await fetch(`/api/endpoint/${slug}/ngsi-ld/v1/entities?${query}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        const error: unknown = await response.json().catch(() => undefined);
        await unwrap({ error, response });
      }
      return (await response.json()) as PreviewRow[];
    },
  });
  return (
    <Card>
      <CardHeader
        as="h2"
        title={t("grafana.form.previewEmptyTitle")}
        description={rows.isSuccess && rows.data.length > 0 ? t("grafana.form.preview") : undefined}
        className="mb-2"
      />
      {rows.isPending ? <PreviewLoading label={t("grafana.form.previewLoading")} /> : null}
      {rows.isError ? <PreviewFailed error={rows.error} onRetry={() => void rows.refetch()} /> : null}
      {rows.isSuccess && rows.data.length === 0 ? (
        <p className="text-body text-fg-muted">{t("grafana.form.previewNoRows")}</p>
      ) : null}
      {rows.isSuccess && rows.data.length > 0 ? (
        <dl>
          {rows.data.map((row) => {
            const value = valueText(row[attribute]);
            return (
              <div key={row.id} className="flex items-baseline justify-between gap-3 border-b border-border py-1.5 last:border-b-0">
                <dt className="min-w-0 break-words text-body text-fg-muted">{rowName(row, i18n.language)}</dt>
                <dd className="flex shrink-0 flex-wrap items-baseline justify-end gap-x-2 text-right">
                  <span className="text-body font-medium text-fg">{value.text}</span>
                  {value.at ? (
                    <time className="text-caption text-fg-muted" dateTime={value.at}>
                      {when.format(new Date(value.at))}
                    </time>
                  ) : null}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}
    </Card>
  );
}

/** The preview's wait: one bar pair per row it will show, announced once in words. */
export function PreviewLoading({ label }: { label: string }): JSX.Element {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} aria-hidden="true" className="flex justify-between gap-3 border-b border-border py-2.5 last:border-b-0">
          <Skeleton className="h-4 w-full max-w-48" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

/**
 * Why the preview shows no rows: a refusal of the person's own read says Grafana would draw
 * nothing for them either; any other failure gives the reason and a way to ask again.
 */
export function PreviewFailed({ error, onRetry }: { error: unknown; onRetry: () => void }): JSX.Element {
  const { t } = useTranslation();
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
    return (
      <Alert tone="warning" title={t("grafana.form.previewForbiddenTitle")}>
        {t("grafana.form.previewForbidden")}
      </Alert>
    );
  }
  return (
    <Alert
      tone="danger"
      title={t("grafana.form.previewFailedTitle")}
      actions={
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t("grafana.form.retry")}
        </Button>
      }
    >
      {reasonOf(error, t("grafana.form.previewFailed"))}
    </Alert>
  );
}

/**
 * The Endpoints Grafana cannot read yet, by their titles. One with no title of its own (an App's
 * internal Endpoint such as app-t6429-bike-live) is only counted: its name tells a person nothing.
 */
export function notReachable(closed: readonly { name: string; title: string }[], t: (key: string, options?: Record<string, unknown>) => string): string {
  const titled = closed.filter((endpoint) => endpoint.title !== endpoint.name).map((endpoint) => endpoint.title);
  const untitled = closed.length - titled.length;
  if (titled.length === 0) return t("grafana.form.notReachableCount", { count: untitled });
  const names = untitled > 0 ? [...titled, t("grafana.form.notReachableOthers", { count: untitled })] : titled;
  return t("grafana.form.notReachable", { names: names.join(", ") });
}

/** The kinds the chosen attribute can be drawn as, or all of them until one is chosen. */
function kindsFor(options: Options | undefined, attribute: string): readonly Kind[] {
  return options?.attributes.find((option) => option.name === attribute)?.kinds ?? KINDS;
}

function useChoices(project: string) {
  const [endpoint, setEndpoint] = useState("");
  const [type, setType] = useState("");
  const [attribute, setAttribute] = useState("");
  const [kind, setKind] = useState<Kind>("timeseries");
  const [title, setTitle] = useState("");
  const options = useOptions(project, endpoint, type);
  return {
    endpoint,
    type,
    attribute,
    kind,
    title,
    options,
    setTitle,
    setKind,
    chooseEndpoint: (next: string) => {
      setEndpoint(next);
      setType("");
      setAttribute("");
    },
    chooseType: (next: string) => {
      setType(next);
      setAttribute("");
    },
    chooseAttribute: (next: string) => {
      setAttribute(next);
      const fits = kindsFor(options.data, next);
      if (!fits.includes(kind) && fits[0]) setKind(fits[0]);
    },
  };
}

/**
 * The form. Each dropdown lists what the server offers this person; the server checks each value
 * again on the save, and a refusal names its field here. The preview reads through the Endpoint
 * with the person's own session, so it shows what they would see in Grafana.
 */
export function VisualizationForm({ project, aside }: { project: string; aside?: ReactNode }): JSX.Element {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const form = useChoices(project);
  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/v1/projects/{project}/grafana", {
          params: { path: { project } },
          body: {
            title: form.title,
            endpoint: form.endpoint,
            type: form.type,
            attribute: form.attribute,
            kind: form.kind,
          },
        }),
      ),
    onSuccess: () => {
      // A second click would save a twin: the next visualization starts with an empty Name.
      form.setTitle("");
      return queryClient.invalidateQueries({ queryKey: pageKey(project) });
    },
  });
  const endpoints = form.options.data?.endpoints ?? [];
  const usable = endpoints.filter((endpoint) => endpoint.usable);
  const closed = endpoints.filter((endpoint) => !endpoint.usable);
  const chosen = usable.find((endpoint) => endpoint.name === form.endpoint);
  const attributes = form.options.data?.attributes ?? [];
  const ready = Boolean(form.title.trim() && chosen && form.type && form.attribute);
  if (form.options.isError) {
    return <PageFailed error={form.options.error} />;
  }
  if (form.options.isSuccess && usable.length === 0) {
    return (
      <EmptyState
        icon="endpoints"
        title={t("grafana.form.noEndpointsTitle")}
        description={t("grafana.form.noEndpoints")}
      />
    );
  }
  const safe = safeHref(save.data?.openUrl);
  return (
    <div className="grid items-start gap-section lg:grid-cols-5 [&>*]:min-w-0">
      <Card className="lg:col-span-3">
        <CardHeader as="h2" title={t("grafana.form.title")} className="mb-3" />
        <form
          className="grid gap-x-4 gap-y-3 sm:grid-cols-2"
          onChange={save.reset}
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) save.mutate();
          }}
        >
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Field id="grafana-endpoint" label={t("grafana.form.endpoint")} help={t("grafana.form.endpointHelp")} errors={refusalsOf(save.error, "endpoint")}>
              <Select id="grafana-endpoint" value={form.endpoint} onChange={(event) => form.chooseEndpoint(event.target.value)}>
                <option value="">{t("grafana.form.choose")}</option>
                {usable.map((endpoint) => (
                  <option key={endpoint.name} value={endpoint.name}>
                    {endpoint.title}
                  </option>
                ))}
              </Select>
            </Field>
            {closed.length > 0 ? <p className="text-caption text-fg-muted">{notReachable(closed, t)}</p> : null}
          </div>
          <Field id="grafana-type" label={t("grafana.form.type")} help={t("grafana.form.typeHelp")} errors={refusalsOf(save.error, "type")}>
            <Select
              id="grafana-type"
              value={form.type}
              disabled={!chosen}
              title={chosen ? undefined : t("grafana.form.chooseEndpointFirst")}
              onChange={(event) => form.chooseType(event.target.value)}
            >
              <option value="">{t("grafana.form.choose")}</option>
              {(form.options.data?.types ?? []).map((type) => (
                <option key={type} value={type}>
                  {columnLabel(undefined, type, i18n.language)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="grafana-attribute" label={t("grafana.form.attribute")} help={t("grafana.form.attributeHelp")} errors={refusalsOf(save.error, "attribute")}>
            <Select
              id="grafana-attribute"
              value={form.attribute}
              disabled={!form.type}
              title={form.type ? undefined : t("grafana.form.chooseTypeFirst")}
              onChange={(event) => form.chooseAttribute(event.target.value)}
            >
              <option value="">{t("grafana.form.choose")}</option>
              {attributes.map((attribute) => (
                <option key={attribute.name} value={attribute.name}>
                  {columnLabel(undefined, attribute.name, i18n.language)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="grafana-kind" label={t("grafana.form.kind")} help={t("grafana.form.kindHelp")} errors={
              refusalsOf(save.error, "kind").length > 0
                ? [t("grafana.form.kindRefused", { kind: t(`grafana.kind.${form.kind}`), attribute: columnLabel(undefined, form.attribute, i18n.language) })]
                : []
            }>
            <Select id="grafana-kind" value={form.kind} onChange={(event) => form.setKind(event.target.value as Kind)}>
              {kindsFor(form.options.data, form.attribute).map((kind) => (
                <option key={kind} value={kind}>
                  {t(`grafana.kind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="grafana-title" label={t("grafana.form.name")} help={t("grafana.form.nameHelp")} errors={refusalsOf(save.error, "title")}>
            <Input id="grafana-title" value={form.title} maxLength={120} onChange={(event) => form.setTitle(event.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Button
              variant="primary"
              type="submit"
              disabled={!ready || save.isPending}
              disabledReason={ready ? t("grafana.form.saving") : t("grafana.form.incomplete")}
            >
              {t("grafana.form.save")}
            </Button>
          </div>
          {save.isError ? (
            <div className="sm:col-span-2">
              <SaveFailed error={save.error} />
            </div>
          ) : null}
          {save.isSuccess ? (
            <Alert tone="success" className="sm:col-span-2">
              {t("grafana.form.saved", { title: save.data.title })}{" "}
              {safe ? (
                <a className="underline" href={safe} target="_blank" rel="noopener noreferrer">
                  {t("grafana.form.openSaved")}
                </a>
              ) : null}
            </Alert>
          ) : null}
        </form>
      </Card>
      <div className="flex flex-col gap-section lg:col-span-2">
        {chosen && form.type && form.attribute ? (
          <VisualizationPreview slug={chosen.slug} type={form.type} attribute={form.attribute} />
        ) : (
          <Card>
            <CardHeader as="h2" title={t("grafana.form.previewEmptyTitle")} className="mb-1" />
            <EmptyState bare icon="dashboards" title={t("grafana.form.previewEmptyHeading")} description={t("grafana.form.previewEmpty")} />
          </Card>
        )}
        {aside}
      </div>
    </div>
  );
}

/** The server words a refusal as a clause ("a stat cannot draw name; …"): shown as a sentence. */
export function refusalsOf(error: unknown, field: string): string[] {
  return fieldErrors(error, field).map((line) => `${line.charAt(0).toUpperCase()}${line.slice(1)}${/[.!?]$/.test(line) ? "" : "."}`);
}

/**
 * Why a save did not land, worded by who can fix it: a role the person lacks (403), a field the
 * server refused (422, the field itself carries the words), or a failure to try again later.
 */
export function SaveFailed({ error }: { error: unknown }): JSX.Element {
  const { t } = useTranslation();
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 403) {
    return (
      <Alert tone="danger" title={t("grafana.form.saveForbiddenTitle")}>
        {reasonOf(error)} {t("grafana.form.saveForbidden")}
      </Alert>
    );
  }
  if (error instanceof ApiError && (error.problem?.errors ?? []).length > 0) {
    return (
      <Alert tone="danger" title={t("grafana.form.saveFieldsTitle")}>
        {t("grafana.form.saveFieldsBody")}
      </Alert>
    );
  }
  return (
    <Alert tone="danger" title={t("grafana.form.saveFailedTitle")}>
      {reasonOf(error, t("grafana.form.saveFailed"))}
    </Alert>
  );
}

/** The project's visualizations in Grafana, and the form that adds one (T-6509). */
export function GrafanaPage({ project }: { project: string }): JSX.Element {
  const { t } = useTranslation();
  const page = useQuery({
    queryKey: pageKey(project),
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/projects/{project}/grafana", { params: { path: { project } } })),
  });
  const header = <PageHeader title={t("grafana.title")} description={t("grafana.lead")} />;
  if (page.isPending) {
    return <PageLoading label={t("grafana.title")} />;
  }
  if (page.isError) {
    return (
      <div className="flex flex-col gap-section">
        {header}
        {page.error instanceof ApiError && page.error.status === 403 ? (
          <EmptyState
            icon="lock"
            title={t("grafana.forbiddenTitle")}
            description={`${reasonOf(page.error)} ${t("app.error.forbiddenHint")}`}
          />
        ) : (
          <PageFailed error={page.error} onRetry={() => void page.refetch()} />
        )}
      </div>
    );
  }
  const { ready, reason, mayCreate, items } = page.data;
  const saved = (
    <Card>
      <CardHeader as="h2" title={t("grafana.saved.title")} className="mb-1" />
      {items.length === 0 ? (
        <EmptyState
          bare
          icon="dashboards"
          title={t("grafana.saved.emptyTitle")}
          description={t(mayCreate ? "grafana.saved.empty" : "grafana.saved.emptyReader")}
        />
      ) : (
        <ul>
          {items.map((item) => (
            <SavedVisualization key={item.id} project={project} item={item} mayRemove={mayCreate} />
          ))}
        </ul>
      )}
    </Card>
  );
  return (
    <div className="flex flex-col gap-section">
      {header}
      {ready ? null : (
        <EmptyState
          icon="dashboards"
          title={t("grafana.notReadyTitle")}
          description={reason ?? t("grafana.notReady")}
        />
      )}
      {ready && mayCreate ? <VisualizationForm project={project} aside={saved} /> : null}
      {ready && !mayCreate ? (
        <div className="grid items-start gap-section lg:grid-cols-5 [&>*]:min-w-0">
          <Alert tone="info" title={t("grafana.readOnlyTitle")} className="lg:order-last lg:col-span-2">
            {t("grafana.readOnly")}
          </Alert>
          <div className="lg:col-span-3">{saved}</div>
        </div>
      ) : null}
    </div>
  );
}
