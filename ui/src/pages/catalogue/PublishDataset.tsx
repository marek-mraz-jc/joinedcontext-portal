import { useState } from "react";
import type { JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, unwrap } from "../../api/client";
import { isChange, localized } from "../../api/manifest";
import type { Change, ResourceProposal } from "../../api/manifest";
import { proposeChecked } from "../../api/proposal";
import type { components } from "../../api/schema";
import { ChangeNotice } from "../../components/ChangeNotice";
import { ResourceNamePicker } from "../../components/pickers/ResourceNamePicker";
import { Alert, Badge, Button, Checkbox, Dialog, Field, Input, Select } from "../../components/ui";
import { problemOf, useThemeLabel } from "./CataloguePage";
import { catalogOf, formOf, FREQUENCIES, LICENCES, problems, THEMES } from "./publish";
import type { CatalogBlock, PublishForm } from "./publish";

type Draft = components["schemas"]["CatalogueDraft"];
type Step = "pick" | "describe" | "preview";

interface Drafted {
  draft: Draft;
  manifest: ResourceProposal;
  form: PublishForm;
}

/**
 * Publish a dataset in one step (EP-83, Architecture/21 §7): pick the Endpoint, review the DCAT-AP
 * description the Portal drafted from the Endpoint, its model and the organization, preview the
 * catalogue entry, propose. The proposal is one Change on the Endpoint; nothing is written to the
 * catalogue here, and the dataset appears after the approval, on the reconciler's next run.
 */
export function PublishDatasetDialog({
  project,
  endpoint,
  open,
  onOpenChange,
}: {
  project: string;
  /** Start at the description of this Endpoint rather than at the picker. */
  endpoint?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t("catalogue.publish.title")}
      description={t("catalogue.publish.lead")}
      closeLabel={t("app.close")}
    >
      {/* Mounted only while open: every opening starts from the draft, never from a half-edit. */}
      {open ? <Flow project={project} endpoint={endpoint} onDone={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

function Flow({
  project,
  endpoint,
  onDone,
}: {
  project: string;
  endpoint?: string;
  onDone: () => void;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState(endpoint ?? "");
  const [step, setStep] = useState<Step>("pick");
  const [drafted, setDrafted] = useState<Drafted | null>(null);
  const [touched, setTouched] = useState(false);
  const [change, setChange] = useState<Change | null>(null);

  const load = useMutation({
    mutationFn: async (name: string): Promise<Drafted> => {
      const draft = await unwrap(
        await api.POST("/api/v1/projects/{project}/catalogue/drafts", {
          params: { path: { project } },
          body: { endpoint: name },
        }),
      );
      const { apiVersion, kind, metadata, spec } = await unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}/{name}", {
          params: { path: { project, plural: "endpoints", name } },
        }),
      );
      // What the Change carries back is the manifest, never the status the Portal computed.
      const manifest: ResourceProposal = { apiVersion, kind, metadata, spec };
      const language = i18n.resolvedLanguage ?? i18n.language ?? "en";
      return { draft, manifest, form: formOf(draft.catalog as CatalogBlock, language) };
    },
    onSuccess: (result) => {
      setDrafted(result);
      setStep("describe");
    },
  });

  const propose = useMutation({
    mutationFn: async (value: Drafted) => {
      const { apiVersion, kind, metadata, spec } = value.manifest;
      const body = {
        apiVersion,
        kind,
        metadata,
        spec: {
          ...(spec as Record<string, unknown>),
          catalog: catalogOf(value.draft.catalog as CatalogBlock, value.form),
          publish: value.draft.publish,
          // Publishing a restricted Endpoint would list a dataset nobody browsing can open; the
          // flow said so before this button, and the Change takes the red lane (EP-76, PF-72).
          ...(value.draft.makesPublic ? { audience: "public" } : {}),
        },
      } as ResourceProposal;
      return proposeChecked(project, "endpoints", body, false);
    },
    onSuccess: (result) => {
      if (isChange(result)) {
        setChange(result);
      }
      void queryClient.invalidateQueries({ queryKey: ["catalogue"] });
    },
  });

  if (change) {
    return (
      <div className="flex flex-col gap-4">
        <ChangeNotice change={change} project={project} />
        <p className="text-body text-fg-muted">{t("catalogue.publish.afterApproval")}</p>
        <div className="flex justify-end">
          <Button variant="primary" onClick={onDone}>
            {t("catalogue.publish.close")}
          </Button>
        </div>
      </div>
    );
  }

  if (step === "pick" || !drafted) {
    return (
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (picked) load.mutate(picked);
        }}
      >
        <ol className="flex gap-3 text-caption text-fg-muted" aria-label={t("catalogue.publish.steps")}>
          <li aria-current="step" className="font-semibold text-fg">
            {t("catalogue.publish.step.pick")}
          </li>
          <li>{t("catalogue.publish.step.describe")}</li>
          <li>{t("catalogue.publish.step.preview")}</li>
        </ol>
        <Field id="publish-endpoint" label={t("catalogue.publish.endpoint")} required description={t("catalogue.publish.endpointHelp")}>
          <ResourceNamePicker
            id="publish-endpoint"
            labelled
            label={t("catalogue.publish.endpoint")}
            from={{ project, plural: "endpoints" }}
            value={picked}
            onChange={setPicked}
            required
          />
        </Field>
        {load.error ? (
          <Alert tone="danger" role="alert">
            {problemOf(load.error, t("app.error.generic"))}
          </Alert>
        ) : null}
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="primary"
            loading={load.isPending}
            disabled={!picked}
            disabledReason={t("catalogue.publish.pickFirst")}
          >
            {t("catalogue.publish.describe")}
          </Button>
        </div>
      </form>
    );
  }

  const found = problems(drafted.form);
  const invalid = Object.keys(found).length > 0;
  const errorOf = (field: keyof PublishForm) => (touched && found[field] ? [t(found[field])] : undefined);
  const update = (patch: Partial<PublishForm>) =>
    setDrafted({ ...drafted, form: { ...drafted.form, ...patch } });

  if (step === "preview") {
    return (
      <div className="flex flex-col gap-4">
        <Preview drafted={drafted} />
        {drafted.draft.makesPublic ? (
          <Alert tone="warning">{t("catalogue.publish.makesPublic")}</Alert>
        ) : null}
        {propose.error ? (
          <Alert tone="danger" role="alert">
            {problemOf(propose.error, t("app.error.generic"))}
          </Alert>
        ) : null}
        <div className="flex justify-between gap-2">
          <Button onClick={() => setStep("describe")}>{t("catalogue.publish.back")}</Button>
          <Button variant="primary" loading={propose.isPending} onClick={() => propose.mutate(drafted)}>
            {drafted.draft.makesPublic ? t("catalogue.publish.proposePublic") : t("catalogue.publish.propose")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (!invalid) setStep("preview");
      }}
    >
      <p className="text-body text-fg-muted">
        {t("catalogue.publish.drafted", { endpoint: drafted.draft.endpoint })}
      </p>
      {drafted.draft.makesPublic ? <Alert tone="warning">{t("catalogue.publish.makesPublic")}</Alert> : null}
      {drafted.draft.missing.length > 0 ? (
        <Alert tone="info">
          {t("catalogue.publish.missing", {
            fields: drafted.draft.missing.map((m) => t(`catalogue.publish.member.${m}`, { defaultValue: m })).join(", "),
          })}
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="publish-publisher" label={t("catalogue.facets.publisher")} description={t("catalogue.publish.inLanguage", { language: drafted.form.language })}>
          <Input id="publish-publisher" value={drafted.form.publisher} maxLength={200} onChange={(e) => update({ publisher: e.target.value })} />
        </Field>
        <Field id="publish-licence" label={t("catalogue.facets.licence")} required errors={errorOf("license")}>
          <Select id="publish-licence" value={drafted.form.license} onChange={(e) => update({ license: e.target.value })}>
            <option value="">{t("catalogue.publish.choose")}</option>
            {LICENCES.map((licence) => (
              <option key={licence} value={licence}>
                {t(`catalogue.licence.${licence}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="publish-contact-name" label={t("catalogue.publish.contactName")} description={t("catalogue.publish.contactHelp")} errors={errorOf("contactName")}>
          <Input id="publish-contact-name" value={drafted.form.contactName} maxLength={200} onChange={(e) => update({ contactName: e.target.value })} />
        </Field>
        <Field id="publish-contact-email" label={t("catalogue.publish.contactEmail")} errors={errorOf("contactEmail")}>
          <Input id="publish-contact-email" type="email" value={drafted.form.contactEmail} maxLength={254} onChange={(e) => update({ contactEmail: e.target.value })} />
        </Field>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-body font-medium text-fg">{t("catalogue.facets.theme")}</legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {THEMES.map((theme) => (
            <Checkbox
              key={theme}
              label={t(`catalogue.theme.${theme}`)}
              checked={drafted.form.themes.includes(theme)}
              onChange={() =>
                update({
                  themes: drafted.form.themes.includes(theme)
                    ? drafted.form.themes.filter((x) => x !== theme)
                    : [...drafted.form.themes, theme],
                })
              }
            />
          ))}
        </div>
      </fieldset>
      <Field id="publish-keywords" label={t("catalogue.publish.keywords")} description={t("catalogue.publish.keywordsHelp", { language: drafted.form.language })}>
        <Input id="publish-keywords" value={drafted.form.keywords} maxLength={1000} onChange={(e) => update({ keywords: e.target.value })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="publish-spatial" label={t("catalogue.facets.spatial")} description={t("catalogue.publish.spatialHelp")}>
          <Input id="publish-spatial" value={drafted.form.spatial} maxLength={500} onChange={(e) => update({ spatial: e.target.value })} />
        </Field>
        <Field id="publish-frequency" label={t("catalogue.dataset.frequency")}>
          <Select id="publish-frequency" value={drafted.form.frequency} onChange={(e) => update({ frequency: e.target.value })}>
            <option value="">{t("catalogue.publish.choose")}</option>
            {FREQUENCIES.map((frequency) => (
              <option key={frequency} value={frequency}>
                {t(`catalogue.frequency.${frequency}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="publish-start" label={t("catalogue.publish.start")}>
          <Input id="publish-start" type="date" value={drafted.form.temporalStart} onChange={(e) => update({ temporalStart: e.target.value })} />
        </Field>
        <Field id="publish-end" label={t("catalogue.publish.end")} errors={errorOf("temporalEnd")}>
          <Input id="publish-end" type="date" value={drafted.form.temporalEnd} onChange={(e) => update({ temporalEnd: e.target.value })} />
        </Field>
      </div>
      <div className="flex justify-between gap-2">
        <Button onClick={() => setStep("pick")}>{t("catalogue.publish.back")}</Button>
        <Button type="submit" variant="primary">
          {t("catalogue.publish.preview")}
        </Button>
      </div>
    </form>
  );
}

/** The catalogue entry as the dataset page will show it (Architecture/21 §7, step 3). */
function Preview({ drafted }: { drafted: Drafted }): JSX.Element {
  const { t, i18n } = useTranslation();
  const themeLabel = useThemeLabel();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";
  const { form } = drafted;
  const title = localized(drafted.manifest.metadata.title, locale, drafted.manifest.metadata.name);
  const description = localized(drafted.manifest.metadata.description, locale, "");
  const keywords = form.keywords.split(",").map((k) => k.trim()).filter(Boolean);
  const facts: Array<[string, string]> = [
    [t("catalogue.facets.publisher"), form.publisher],
    [t("catalogue.facets.licence"), form.license ? t(`catalogue.licence.${form.license}`) : ""],
    [t("catalogue.dataset.frequency"), form.frequency ? t(`catalogue.frequency.${form.frequency}`) : ""],
    [t("catalogue.facets.spatial"), form.spatial],
    [
      t("catalogue.facets.year"),
      form.temporalStart || form.temporalEnd
        ? t("catalogue.dataset.period", {
            start: form.temporalStart || t("catalogue.dataset.open"),
            end: form.temporalEnd || t("catalogue.dataset.open"),
          })
        : "",
    ],
    [t("catalogue.dataset.contact"), [form.contactName, form.contactEmail].filter(Boolean).join(", ")],
  ];
  return (
    <section aria-label={t("catalogue.publish.step.preview")} className="flex flex-col gap-3 rounded-md border border-border p-4">
      <h3 className="font-heading text-title font-semibold text-fg">{title}</h3>
      {description ? <p className="text-body text-fg">{description}</p> : null}
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {facts
          .filter(([, value]) => value.trim() !== "")
          .map(([label, value]) => (
            <div key={label}>
              <dt className="text-caption font-semibold text-fg-muted">{label}</dt>
              <dd className="text-body text-fg">{value}</dd>
            </div>
          ))}
      </dl>
      {form.themes.length > 0 || keywords.length > 0 ? (
        <ul className="flex flex-wrap gap-1" aria-label={t("catalogue.dataset.tags")}>
          {form.themes.map((theme) => (
            <li key={`theme-${theme}`}>
              <Badge tone="info">{themeLabel(theme)}</Badge>
            </li>
          ))}
          {keywords.map((keyword) => (
            <li key={`keyword-${keyword}`}>
              <Badge>{keyword}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
