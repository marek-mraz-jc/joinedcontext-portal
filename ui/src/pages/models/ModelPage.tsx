/**
 * One data model's own page, `/projects/{project}/models/{name}` (DM-61, DM-62, T-2765).
 *
 * What the model is (its classes, their fields, what relates to what, its enums), the form each
 * class generates, the LinkML, who uses it, what changed it, and its Mappings. Read-only: Edit
 * opens the editor for a person who may propose a DataModel and says why not to anyone else.
 */
import { RecordLink } from "../../components/RecordLink";
import { useMemo, useState } from "react";
import type { JSX } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { readModelSource } from "../../api/datamodelSource";
import { localized } from "../../api/manifest";
import type { Change, Manifest } from "../../api/manifest";
import { ActivityFeed } from "../../components/ActivityFeed";
import { ChangeNotice } from "../../components/ChangeNotice";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tabs,
  tabPanelProps,
} from "../../components/ui";
import { LinkmlGraphView } from "./LinkmlGraphView";
import { MappingsEditor } from "./MappingsEditor";
import type { MappingModel } from "./MappingsEditor";
import { ModelForm, ModelYaml, useImportSources } from "./ModelViews";
import { ProposeLink, useProjectList, useProjectManifests } from "./ModelsList";
import { classSlots, parseModel } from "./linkml";
import type { LinkmlModel } from "./linkml";
import { spaceOfModel, USING_KINDS, usesOfModel } from "./modelUsage";
import type { ModelUse } from "./modelUsage";

type View = "overview" | "form" | "yaml" | "used" | "history" | "mappings";
const VIEWS: View[] = ["overview", "form", "yaml", "used", "history", "mappings"];

/** The source of a model: the manifest's own text, else the file the repository keeps (DM-56). */
export function useSourceOf(project: string, model: Manifest | undefined) {
  const inline = typeof model?.spec.linkml === "string" && model.spec.linkml.includes("\n") ? model.spec.linkml : undefined;
  return useQuery({
    queryKey: ["datamodel-source", project, model?.metadata.name],
    enabled: model !== undefined && inline === undefined,
    retry: false,
    queryFn: () => readModelSource(project, model?.metadata.name ?? ""),
    // The inline text is the answer as it stands; nothing is fetched for it.
    initialData: inline,
  });
}

/** A link to one user of the model: its own page where it has one, else its edit form. */
export function UseLink({ project, use }: { project: string; use: Pick<ModelUse, "plural" | "name"> }): JSX.Element {
  return <RecordLink project={project} plural={use.plural} name={use.name} className="font-mono" />;
}

/** The classes with their fields: what each slot is, and which class a relationship points at. */
function ClassesTable({ model }: { model: LinkmlModel }): JSX.Element {
  const { t } = useTranslation();
  const classes = new Set(model.classes.map((one) => one.name));
  const enums = new Set(model.enums.map((one) => one.name));
  return (
    <Table caption={t("models.classes")}>
      <TableHead>
        <TableHeaderCell>{t("models.page.class")}</TableHeaderCell>
        <TableHeaderCell>{t("models.slots")}</TableHeaderCell>
      </TableHead>
      <TableBody>
        {model.classes.map((klass) => (
          <TableRow key={klass.name}>
            <TableCell primary>
              {klass.name}
              {klass.is_a ? <span className="block text-caption text-fg-muted">is_a {klass.is_a}</span> : null}
            </TableCell>
            <TableCell>
              <ul className="flex flex-col gap-0.5">
                {classSlots(model, klass).map((slot) => {
                  const name = slot.name;
                  const range = slot.range;
                  return (
                    <li key={name}>
                      <span className="font-mono">{name}</span>
                      {range ? <span className="text-fg-muted">: {range}</span> : null}
                      {range && classes.has(range) ? (
                        <Badge className="ml-2">{t("models.page.relationship")}</Badge>
                      ) : range && enums.has(range) ? (
                        <Badge className="ml-2">{t("models.page.enum")}</Badge>
                      ) : null}
                      {slot.required ? <span className="text-fg-muted"> · {t("models.required")}</span> : null}
                      {slot.multivalued ? <span className="text-fg-muted"> · {t("models.multivalued")}</span> : null}
                    </li>
                  );
                })}
              </ul>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The model's Mappings to and from the project's other models (DM-33), proposed from here. */
function ModelMappings({
  project,
  model,
  source,
  models,
  spaces,
}: {
  project: string;
  model: Manifest;
  source: string;
  models: Manifest[];
  spaces: Manifest[];
}): JSX.Element {
  const [proposed, setProposed] = useState<Change | null>(null);
  const others = models.filter((other) => other.metadata.name !== model.metadata.name);
  const sources = useQueries({
    queries: others.map((other) => ({
      queryKey: ["datamodel-source", project, other.metadata.name],
      retry: false,
      queryFn: () => readModelSource(project, other.metadata.name),
    })),
  });
  const version = (manifest: Manifest) => (typeof manifest.spec.version === "string" ? manifest.spec.version : "1.0.0");
  const mappable: MappingModel[] = [
    { name: model.metadata.name, version: version(model), source },
    ...others.flatMap((other, index) => {
      const text = sources[index]?.data;
      return text === undefined ? [] : [{ name: other.metadata.name, version: version(other), source: text }];
    }),
  ];
  const byName = new Map(models.map((one) => [one.metadata.name, one]));
  return (
    <div className="flex flex-col gap-3">
      {proposed ? <ChangeNotice change={proposed} project={project} /> : null}
      <MappingsEditor
        project={project}
        models={mappable}
        spaceOf={(name) => {
          const one = byName.get(name);
          return one ? spaceOfModel(one, spaces) : undefined;
        }}
        onProposed={setProposed}
      />
    </div>
  );
}

export function ModelPage({
  project,
  name,
  initialClass,
}: {
  project: string;
  name: string;
  /** A class to open the form on, when a link named a type of the model. */
  initialClass?: string;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<View>(initialClass ? "form" : "overview");
  const models = useProjectList(project, "datamodels");
  const all = useProjectManifests(project);
  const model = models.data?.find((one) => one.metadata.name === name);
  const source = useSourceOf(project, model);
  const parsed = useMemo(() => (source.data ? parseModel(source.data) : undefined), [source.data]);
  const uses = useMemo(() => (model ? usesOfModel(model, all) : []), [model, all]);
  const imports = useImportSources(project, name, source.data ?? "");

  const back = (
    <Link
      to="/projects/$project/models"
      params={{ project }}
      className="focus-ring text-body text-primary-soft-fg underline hover:no-underline"
    >
      {t("models.page.back")}
    </Link>
  );

  if (models.isPending) {
    return (
      <p role="status" className="text-body text-fg-muted">
        {t("app.loading")}
      </p>
    );
  }
  if (models.isError || model === undefined) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <EmptyState
          icon="models"
          title={t("models.page.notFound", { name })}
          description={models.isError ? t("app.error.generic") : t("models.page.notFoundLead")}
          action={
            models.isError ? (
              <Button size="sm" onClick={() => void models.refetch()}>
                {t("app.error.retry")}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const space = spaceOfModel(model, all.spaces);
  const version = typeof model.spec.version === "string" ? model.spec.version : undefined;
  const lifecycle = typeof model.spec.lifecycle === "string" ? model.spec.lifecycle : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div>
        {back}
        <PageHeader
          title={localized(model.metadata.title, i18n.language, name)}
          description={
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{name}</span>
              {space ? (
                <span>
                  {t("models.field.space")}:{" "}
                  <Link
                    to="/projects/$project/$plural/$name"
                    params={{ project, plural: "spaces", name: space }}
                    className="focus-ring text-primary-soft-fg underline-offset-2 hover:underline"
                  >
                    {space}
                  </Link>
                </span>
              ) : null}
              {version ? <span className="font-mono">v{version}</span> : null}
              {lifecycle ? <Badge>{t(`models.lifecycleOption.${lifecycle}`, { defaultValue: lifecycle })}</Badge> : null}
            </span>
          }
          actions={
            <ProposeLink project={project} search={{ edit: name }} variant="primary">
              {t("models.page.edit")}
            </ProposeLink>
          }
        />
      </div>

      <Tabs
        id="model-page"
        label={t("models.page.views")}
        tabs={VIEWS.map((one) => ({ value: one, label: t(`models.page.view.${one}`) }))}
        value={view}
        onChange={setView}
      />
      <div {...tabPanelProps("model-page", view)}>
        {source.isError && (view === "overview" || view === "form" || view === "yaml" || view === "mappings") ? (
          <Alert tone="danger" role="alert">
            <p>{t("models.page.sourceFailed", { reason: source.error instanceof Error ? source.error.message : "" })}</p>
            <Button size="sm" className="mt-2" onClick={() => void source.refetch()}>
              {t("app.error.retry")}
            </Button>
          </Alert>
        ) : source.data === undefined && view !== "used" && view !== "history" ? (
          <p role="status" className="text-body text-fg-muted">
            {t("models.source.loading")}
          </p>
        ) : (
          <>
            {view === "overview" && source.data !== undefined && parsed ? (
              <div className="flex flex-col gap-4">
                <LinkmlGraphView
                  source={source.data}
                  imports={imports}
                  onOpenClass={() => {
                    setView("form");
                  }}
                />
                <ClassesTable model={parsed} />
                {parsed.enums.length > 0 ? (
                  <section aria-labelledby="model-enums" className="flex flex-col gap-2">
                    <h2 id="model-enums" className="text-sm font-semibold">
                      {t("models.enums")}
                    </h2>
                    <ul className="flex flex-col gap-1 text-body">
                      {parsed.enums.map((entry) => (
                        <li key={entry.name}>
                          <span className="font-mono font-medium">{entry.name}</span>:{" "}
                          {entry.permissible_values
                            .map((value) => (value.title ? `${value.name} (${localized(value.title, i18n.language, value.name)})` : value.name))
                            .join(", ")}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>
            ) : null}
            {view === "form" && source.data !== undefined ? <ModelForm source={source.data} initialClass={initialClass} /> : null}
            {view === "yaml" && source.data !== undefined ? <ModelYaml source={source.data} name={name} /> : null}
            {view === "used" ? (
              uses.length === 0 ? (
                <p className="text-body text-fg-muted">{t("models.page.unusedLead")}</p>
              ) : (
                <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[12rem_1fr]">
                  {USING_KINDS.filter(({ kind }) => uses.some((use) => use.kind === kind)).map(({ kind }) => (
                    <div key={kind} className="contents">
                      <dt className="font-medium">{t(`models.page.usedKind.${kind}`)}</dt>
                      <dd>
                        <ul className="flex flex-wrap gap-x-3 gap-y-1">
                          {uses
                            .filter((use) => use.kind === kind)
                            .map((use) => (
                              <li key={use.name}>
                                <UseLink project={project} use={use} />
                              </li>
                            ))}
                        </ul>
                      </dd>
                    </div>
                  ))}
                </dl>
              )
            ) : null}
            {view === "history" ? (
              <ActivityFeed project={project} compact fixed={{ object: `datamodels/${name}` }} limit={20} />
            ) : null}
            {view === "mappings" && source.data !== undefined ? (
              <ModelMappings
                project={project}
                model={model}
                source={source.data}
                models={models.data ?? []}
                spaces={all.spaces ?? []}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
