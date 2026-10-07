/**
 * The form view of a space's type and the public form (T-3103, ADR-N-042 §3.2 and §3.5, API/01
 * §30 and §33).
 *
 * `FormView` asks for the fields of the type's LinkML class, as the saved view's settings choose,
 * order and relabel them, and creates one entity through the space surface with the person's own
 * session: the Policy decides the write. `FormSettingsEditor` is where the settings are made, and
 * `FormSharePanel` publishes the form: a public Endpoint whose Policy grants anyone `createEntity`
 * on the type alone. `PublicFormPage` is that link, `/f/{slug}`: it reads nothing but the
 * Endpoint's published schema and posts anonymously through the Endpoint.
 */
import { useMemo, useState } from "react";
import type { FormEvent, JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { originTransport } from "@joinedcontext/sdk";
import { api, ApiError, unwrap } from "../../api/client";
import type { Change, ResourceProposal } from "../../api/manifest";
import { useProposal } from "../../api/proposal";
import { ChangeNotice } from "../../components/ChangeNotice";
import { endpointUrl } from "../../components/endpoints/links";
import { Alert, Button, Checkbox, Field, Input, Select } from "../../components/ui";
import { DNS1123 } from "../../schemas/kinds";
import { fetchJson } from "../endpoints/SchemaProjectionPanel";
import type { LinkmlSlot } from "../models/linkml";
import { askable, createdId, entityOf, fieldsOf, fieldsOfSchema, prefilled, problemsOf, trapName, visibleFields } from "./formView";
import type { Answers, Condition, FieldOption, FieldSetting, FormField, FormSettings, Problem } from "./formView";
import { publicName } from "./PublicView";

/** The answers a form holds and what changing one does. */
function useAnswers(initial: Answers) {
  const [answers, setAnswers] = useState<Answers>(initial);
  const set = (key: string, value: string) => setAnswers((before) => ({ ...before, [key]: value }));
  return { answers, set, reset: () => setAnswers(initial) };
}

/** The controls of the shown fields, each labelled, helped and saying what is wrong with it. */
export function FormFields({
  idPrefix,
  fields,
  answers,
  problems,
  onAnswer,
}: {
  idPrefix: string;
  fields: FormField[];
  answers: Answers;
  problems: Record<string, Problem>;
  onAnswer: (key: string, value: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      {fields.map((field) => {
        const id = `${idPrefix}-${field.attr}`;
        const problem = problems[field.attr];
        const errors = problem ? [t(`spaces.form.problem.${problem}`)] : undefined;
        if (field.kind === "boolean") {
          return (
            <Field key={field.attr} id={id} hideLabel help={field.help} errors={errors}>
              <Checkbox
                id={id}
                label={field.label}
                checked={answers[field.attr] === "true"}
                onChange={(event) => onAnswer(field.attr, event.target.checked ? "true" : "false")}
              />
            </Field>
          );
        }
        if (field.kind === "point") {
          return (
            <fieldset key={field.attr} className="flex flex-col gap-2" aria-describedby={problem ? `${id}-problem` : undefined}>
              <legend className="text-body font-semibold text-fg">
                {field.label}
                {field.required ? ` (${t("spaces.form.required")})` : ""}
              </legend>
              {field.help ? <p className="text-caption text-fg-muted">{field.help}</p> : null}
              <div className="flex flex-wrap gap-3">
                {(["lat", "lon"] as const).map((part) => (
                  <Field key={part} id={`${id}-${part}`} label={t(`spaces.form.${part}`)}>
                    <Input
                      id={`${id}-${part}`}
                      inputMode="decimal"
                      value={answers[`${field.attr}.${part}`] ?? ""}
                      onChange={(event) => onAnswer(`${field.attr}.${part}`, event.target.value)}
                    />
                  </Field>
                ))}
              </div>
              {problem ? (
                <p id={`${id}-problem`} className="text-caption text-danger">
                  {t(`spaces.form.problem.${problem}`)}
                </p>
              ) : null}
            </fieldset>
          );
        }
        return (
          <Field key={field.attr} id={id} label={field.label} required={field.required} help={field.help} errors={errors}>
            {field.kind === "enum" ? (
              <Select id={id} value={answers[field.attr] ?? ""} onChange={(event) => onAnswer(field.attr, event.target.value)}>
                <option value="">{t("spaces.form.choose")}</option>
                {(field.options ?? []).map((option: FieldOption) => (
                  <option key={option.value} value={option.value}>
                    {option.title ?? option.value}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                id={id}
                type={field.kind === "date" ? "date" : field.kind === "datetime" ? "datetime-local" : "text"}
                inputMode={field.kind === "integer" ? "numeric" : field.kind === "number" ? "decimal" : undefined}
                placeholder={field.kind === "relationship" ? "urn:ngsi-ld:…" : undefined}
                value={answers[field.attr] ?? ""}
                onChange={(event) => onAnswer(field.attr, event.target.value)}
              />
            )}
          </Field>
        );
      })}
    </>
  );
}

/** What one submission did. */
type Sent = { status: "idle" } | { status: "sending" } | { status: "created"; id: string } | { status: "refused"; reason: string };

function reasonOf(status: number, body: unknown): string {
  const problem = (body ?? {}) as { detail?: unknown; title?: unknown };
  return String(problem.detail ?? problem.title ?? `HTTP ${status}`);
}

/**
 * One form that creates an entity: the shown fields, their checks, and the send. `send` posts the
 * entity and answers the status and the body.
 */
function EntityFormBody({
  idPrefix,
  type,
  fields,
  conditions,
  initial,
  locale,
  send,
  trap,
}: {
  idPrefix: string;
  type: string;
  fields: FormField[];
  conditions?: Condition[];
  initial: Answers;
  locale: string;
  /** Sends the entity; `id` is the one the server minted, when it names one. */
  send: (entity: Record<string, unknown>) => Promise<{ status: number; body: unknown; id?: string }>;
  /** A public form's trap field: hidden from people, sent as an attribute no Policy grants. */
  trap?: string;
}): JSX.Element {
  const { t } = useTranslation();
  const { answers, set, reset } = useAnswers(initial);
  const [trapped, setTrapped] = useState("");
  const [tried, setTried] = useState(false);
  const [sent, setSent] = useState<Sent>({ status: "idle" });
  const shown = visibleFields(fields, conditions, answers);
  const problems = problemsOf(shown, answers);
  const count = Object.keys(problems).length;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (count > 0) return;
    setSent({ status: "sending" });
    const entity = entityOf(type, shown, answers, locale);
    if (trap && trapped !== "") entity[trap] = { type: "Property", value: trapped };
    try {
      const answer = await send(entity);
      if (answer.status >= 200 && answer.status < 300) {
        setSent({ status: "created", id: answer.id ?? String(entity.id) });
        setTried(false);
        reset();
      } else {
        setSent({ status: "refused", reason: reasonOf(answer.status, answer.body) });
      }
    } catch (error) {
      setSent({ status: "refused", reason: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <form className="flex max-w-xl flex-col gap-3" noValidate onSubmit={(event) => void submit(event)}>
      <FormFields idPrefix={idPrefix} fields={shown} answers={answers} problems={tried ? problems : {}} onAnswer={set} />
      {trap ? (
        <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
          <label htmlFor={`${idPrefix}-${trap}`}>{t("spaces.form.trap")}</label>
          <Input id={`${idPrefix}-${trap}`} name={trap} tabIndex={-1} autoComplete="off" value={trapped} onChange={(event) => setTrapped(event.target.value)} />
        </div>
      ) : null}
      {tried && count > 0 ? (
        <Alert role="alert" tone="danger">
          {t("spaces.form.fix", { count })}
        </Alert>
      ) : null}
      {sent.status === "refused" ? (
        <Alert role="alert" tone="danger">
          {t("spaces.form.refused", { reason: sent.reason })}
        </Alert>
      ) : null}
      {sent.status === "created" ? (
        <p role="status" className="text-body text-fg [overflow-wrap:anywhere]">
          {t("spaces.form.created", { id: sent.id })}
        </p>
      ) : null}
      <Button type="submit" className="w-fit" disabled={sent.status === "sending"} disabledReason={t("app.loading")}>
        {t("spaces.form.submit")}
      </Button>
    </form>
  );
}

/** The signed-in form of a type: it creates through the space surface with this session. */
export function FormView({
  space,
  type,
  slots,
  enums,
  settings,
  search = new URLSearchParams(window.location.search),
}: {
  space: string;
  type: string;
  slots: LinkmlSlot[];
  enums: Record<string, FieldOption[]>;
  settings?: FormSettings;
  search?: URLSearchParams;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const fields = useMemo(() => fieldsOf(slots, enums, settings, i18n.language), [slots, enums, settings, i18n.language]);
  const initial = useMemo(() => prefilled(fields, search, settings), [fields, search, settings]);
  if (fields.length === 0) {
    return <p className="text-body text-fg-muted">{t("spaces.form.noFields", { type })}</p>;
  }
  return (
    <EntityFormBody
      // A view or a type chosen anew is a fresh form: nothing typed carries over.
      key={`${type}-${JSON.stringify(settings ?? {})}`}
      idPrefix="space-form"
      type={type}
      fields={fields}
      conditions={settings?.conditions}
      initial={initial}
      locale={i18n.language}
      send={async (entity) =>
        originTransport()({ method: "POST", path: `/cs/${encodeURIComponent(space)}/ngsi-ld/v1/entities`, body: entity })
      }
    />
  );
}

/** Where a form view's settings are made: which fields, in what order, as what, and when. */
export function FormSettingsEditor({
  slots,
  value,
  onChange,
}: {
  slots: LinkmlSlot[];
  value: FormSettings;
  onChange: (next: FormSettings) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const candidates = slots.filter(askable).map((slot) => slot.name);
  const chosen: FieldSetting[] = value.fields?.length ? value.fields : candidates.map((attr) => ({ attr }));
  const conditions = value.conditions ?? [];
  const setFields = (fields: FieldSetting[]) => onChange({ ...value, fields });
  const patch = (attr: string, change: Partial<FieldSetting>) =>
    setFields(chosen.map((field) => (field.attr === attr ? { ...field, ...change } : field)));
  const move = (index: number, by: number) => {
    const next = [...chosen];
    const [taken] = next.splice(index, 1);
    next.splice(index + by, 0, taken);
    setFields(next);
  };
  const [draft, setDraft] = useState<{ attr: string; when: string; equals: string }>({ attr: "", when: "", equals: "" });

  return (
    <details className="rounded-lg border border-border p-3" data-testid="form-settings">
      <summary className="cursor-pointer text-body font-semibold text-fg">{t("spaces.form.settings")}</summary>
      <div className="mt-2 flex flex-col gap-3">
        <fieldset className="flex flex-col gap-2">
          <legend className="text-caption font-semibold text-fg">{t("spaces.form.fields")}</legend>
          {candidates.map((attr) => {
            const index = chosen.findIndex((field) => field.attr === attr);
            const field = chosen[index];
            return (
              <div key={attr} className="flex flex-wrap items-end gap-2 border-b border-border pb-2">
                <Checkbox
                  label={attr}
                  checked={index >= 0}
                  onChange={(event) =>
                    setFields(event.target.checked ? [...chosen, { attr }] : chosen.filter((each) => each.attr !== attr))
                  }
                />
                {field ? (
                  <>
                    <Field id={`form-label-${attr}`} label={t("spaces.form.labelOf", { attr })}>
                      <Input id={`form-label-${attr}`} value={field.label ?? ""} onChange={(event) => patch(attr, { label: event.target.value })} />
                    </Field>
                    <Field id={`form-help-${attr}`} label={t("spaces.form.helpOf", { attr })}>
                      <Input id={`form-help-${attr}`} value={field.help ?? ""} onChange={(event) => patch(attr, { help: event.target.value })} />
                    </Field>
                    <Checkbox
                      label={t("spaces.form.requiredOf", { attr })}
                      checked={Boolean(field.required)}
                      onChange={(event) => patch(attr, { required: event.target.checked })}
                    />
                    <Button size="sm" variant="secondary" disabled={index === 0} disabledReason={t("spaces.form.first")} aria-label={t("spaces.form.up", { attr })} onClick={() => move(index, -1)}>
                      ↑
                    </Button>
                    <Button size="sm" variant="secondary" disabled={index === chosen.length - 1} disabledReason={t("spaces.form.last")} aria-label={t("spaces.form.down", { attr })} onClick={() => move(index, 1)}>
                      ↓
                    </Button>
                  </>
                ) : null}
              </div>
            );
          })}
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-caption font-semibold text-fg">{t("spaces.form.conditions")}</legend>
          {conditions.length === 0 ? <p className="text-caption text-fg-muted">{t("spaces.form.noConditions")}</p> : null}
          <ul className="flex flex-col gap-1">
            {conditions.map((condition, index) => (
              <li key={`${condition.attr}-${index}`} className="flex flex-wrap items-center gap-2 text-body">
                <span>{t("spaces.form.conditionText", { attr: condition.attr, when: condition.when.attr, equals: condition.when.equals })}</span>
                <Button size="sm" variant="secondary" onClick={() => onChange({ ...value, conditions: conditions.filter((_, at) => at !== index) })}>
                  {t("spaces.form.removeCondition")}
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-end gap-2">
            <Field id="form-condition-attr" label={t("spaces.form.show")}>
              <Select id="form-condition-attr" value={draft.attr} onChange={(event) => setDraft({ ...draft, attr: event.target.value })}>
                <option value="">{t("spaces.form.choose")}</option>
                {chosen.map((field) => (
                  <option key={field.attr} value={field.attr}>
                    {field.attr}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="form-condition-when" label={t("spaces.form.when")}>
              <Select id="form-condition-when" value={draft.when} onChange={(event) => setDraft({ ...draft, when: event.target.value })}>
                <option value="">{t("spaces.form.choose")}</option>
                {chosen
                  .filter((field) => field.attr !== draft.attr)
                  .map((field) => (
                    <option key={field.attr} value={field.attr}>
                      {field.attr}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field id="form-condition-equals" label={t("spaces.form.equals")}>
              <Input id="form-condition-equals" value={draft.equals} onChange={(event) => setDraft({ ...draft, equals: event.target.value })} />
            </Field>
            <Button
              size="sm"
              disabled={draft.attr === "" || draft.when === "" || draft.attr === draft.when}
              disabledReason={t("spaces.form.conditionHint")}
              onClick={() => {
                onChange({ ...value, conditions: [...conditions, { attr: draft.attr, when: { attr: draft.when, equals: draft.equals } }] });
                setDraft({ attr: "", when: "", equals: "" });
              }}
            >
              {t("spaces.form.addCondition")}
            </Button>
          </div>
        </fieldset>
        <Checkbox
          label={t("spaces.form.prefill")}
          checked={value.prefill !== false}
          onChange={(event) => onChange({ ...value, prefill: event.target.checked })}
        />
      </div>
    </details>
  );
}

/** What `propose-endpoint` is asked for a public form: anyone may create the type, nothing else. */
export function formPublishRequest(
  space: string,
  name: string,
  type: string,
  attributes: string[],
  asked: string[],
  relationships: string[] = [],
): Record<string, unknown> {
  return {
    contextSpace: space,
    name,
    audience: "public",
    entityTypes: [type],
    access: "create",
    // The schema the public page builds its fields from lists what the Endpoint does not hide.
    hiddenAttributes: attributes.filter((attr) => !asked.includes(attr)),
    // The Policy grants these and nothing else of the type: any other attribute is refused (T-3172).
    writeAttributes: asked.filter((attr) => !relationships.includes(attr)),
    writeRelationships: asked.filter((attr) => relationships.includes(attr)),
  };
}

interface Rendering {
  slug?: string;
  endpoint: ResourceProposal;
  policies: ResourceProposal[];
}

/** Publishes the form: a public Endpoint and its Policy, proposed as one Change (API/01 §33). */
export function FormSharePanel({
  project,
  space,
  type,
  attributes,
  asked,
  relationships = [],
}: {
  project: string;
  space: string;
  type: string;
  attributes: string[];
  /** The attributes the form asks for: the only ones the public form may show or set. */
  asked: string[];
  /** Which of the type's attributes are relationships. */
  relationships?: string[];
}): JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState(() => publicName(space, type).replace(/-public$/, "-form"));
  const [change, setChange] = useState<Change | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const proposal = useProposal(project, "endpoints", setChange);
  const nameOk = new RegExp(DNS1123).test(name) && name.length <= 63;

  const publish = async () => {
    setFailed(null);
    try {
      const rendering = (await unwrap(
        await api.POST("/api/v1/projects/{project}/assistant/propose-endpoint", {
          params: { path: { project } },
          body: formPublishRequest(space, name, type, attributes, asked, relationships) as Record<string, never>,
        }),
      )) as unknown as Rendering;
      setSlug(rendering.slug ?? null);
      proposal.mutation.mutate({ body: rendering.endpoint, create: true, bundle: rendering.policies });
    } catch (error) {
      setFailed(error instanceof ApiError ? (error.problem?.detail ?? error.message) : String(error));
    }
  };

  return (
    <details className="rounded-lg border border-border p-3" data-testid="form-share">
      <summary className="cursor-pointer text-body font-semibold text-fg">{t("spaces.form.shareTitle")}</summary>
      <div className="mt-2 flex flex-col gap-3">
        <p className="text-body text-fg-muted">{t("spaces.form.shareLead", { type })}</p>
        <Field id="form-share-name" label={t("spaces.share.name")} help={t("spaces.share.nameHint")} errors={nameOk ? undefined : [t("spaces.share.nameHint")]}>
          <Input id="form-share-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        {failed || proposal.error ? (
          <Alert role="alert" tone="danger">
            {failed ?? proposal.error}
          </Alert>
        ) : null}
        <Button
          className="w-fit"
          disabled={!nameOk || asked.length === 0 || proposal.mutation.isPending}
          disabledReason={!nameOk ? t("spaces.share.nameHint") : asked.length === 0 ? t("spaces.form.noAsked") : t("app.loading")}
          onClick={() => void publish()}
        >
          {t("spaces.form.publish")}
        </Button>
        {change ? (
          <div className="flex flex-col gap-1">
            <ChangeNotice change={change} project={project} />
            {slug ? (
              <p className="text-body text-fg [overflow-wrap:anywhere]" data-testid="form-share-link">
                {t("spaces.share.link", { url: `${window.location.origin}/f/${slug}` })}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

interface SchemaIndex {
  models?: { version?: number }[];
}

/** The page at `/f/{slug}`: a public form, built from what the Endpoint publishes and sent through it. */
export function PublicFormPage({
  slug,
  search = new URLSearchParams(window.location.search),
}: {
  slug: string;
  search?: URLSearchParams;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const base = endpointUrl(slug, "/schema");
  const schema = useQuery({
    queryKey: ["public-form", slug],
    retry: false,
    queryFn: async () => {
      const index = (await fetchJson(`${base}/index.json`)) as SchemaIndex;
      const version = index.models?.[0]?.version ?? 1;
      return (await fetchJson(`${base}/v${version}/json-schema`)) as {
        definitions?: Record<string, unknown>;
        $defs?: Record<string, unknown>;
      };
    },
  });
  const defs = useMemo(() => ({ ...schema.data?.$defs, ...schema.data?.definitions }), [schema.data]);
  // The type the Endpoint publishes: a public form's Endpoint names exactly one (API/01 §19).
  const type = Object.entries(defs).find(([, definition]) => typeof definition === "object" && definition !== null && "properties" in definition)?.[0];
  const fields = useMemo(() => (type ? fieldsOfSchema(defs[type], defs) : []), [defs, type]);
  const initial = useMemo(() => prefilled(fields, search, undefined), [fields, search]);

  if (schema.isPending || schema.isError || !type || fields.length === 0) {
    return (
      <div className="flex flex-col gap-3" data-testid="public-form">
        <h1 className="text-title font-semibold text-fg">{type ?? slug}</h1>
        <p className="text-body text-fg-muted" role="status">
          {schema.isPending ? t("app.loading") : t("spaces.form.notPublished")}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="public-form">
      <h1 className="text-title font-semibold text-fg">{type}</h1>
      <p className="text-body text-fg-muted">{t("spaces.form.publicLead")}</p>
      <Alert tone="info">{t("spaces.form.publicData")}</Alert>
      <EntityFormBody
        idPrefix="public-form"
        type={type}
        fields={fields}
        initial={initial}
        locale={i18n.language}
        trap={trapName(fields)}
        send={async (entity) => {
          // Anonymous: no Portal session goes with it; the gateway decides and rate-limits it.
          const response = await globalThis.fetch(
            new Request(endpointUrl(slug, "/ngsi-ld/v1/entities"), {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify(entity),
              credentials: "omit",
            }),
          );
          const text = await response.text();
          let body: unknown = undefined;
          try {
            body = text ? JSON.parse(text) : undefined;
          } catch {
            body = { title: text };
          }
          return { status: response.status, body, id: createdId(response.headers.get("Location")) };
        }}
      />
    </div>
  );
}
