import { useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError, unwrap } from "../../api/client";
import type { components } from "../../api/schema";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  ExternalLink,
  Icon,
  PageFailed,
  PageHeader,
  PageLoading,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../components/ui";
import { problemOf, useThemeLabel } from "./CataloguePage";
import { snippets } from "./snippets";
import type { Snippet } from "./snippets";

type DatasetDetail = components["schemas"]["CatalogueDatasetDetail"];

export function datasetKey(name: string) {
  return ["catalogue", "datasets", name] as const;
}

/**
 * One public dataset (EP-82, Architecture/21 §6): what the catalogue says of it, its resources,
 * and — when it describes an Endpoint of this installation — the model's classes, ten rows read
 * through that Endpoint, and how to use the data from a shell, an App or an MCP client.
 */
export function DatasetPage({ name }: { name: string }): JSX.Element {
  const { t } = useTranslation();
  const dataset = useQuery({
    queryKey: datasetKey(name),
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/catalogue/datasets/{name}", { params: { path: { name } } }),
      ),
  });

  const back = (
    <Link to="/catalogue" className="focus-ring inline-flex items-center gap-1 rounded-sm text-body text-primary-soft-fg hover:underline">
      <Icon name="chevronLeft" className="size-4" />
      {t("catalogue.dataset.back")}
    </Link>
  );

  if (dataset.isPending) {
    return (
      <div className="flex flex-col gap-section">
        {back}
        <PageLoading label={t("catalogue.dataset.loading")} />
      </div>
    );
  }
  if (dataset.isError) {
    const missing = dataset.error instanceof ApiError && dataset.error.status === 404;
    return (
      <div className="flex flex-col gap-section">
        {back}
        {/* Every state of the page is a page with its heading: a person who followed an old link
            learns at once what is not there. */}
        {missing ? (
          <PageHeader title={t("catalogue.dataset.missing")} description={t("catalogue.dataset.missingHint")} />
        ) : (
          <>
            <PageHeader title={t("catalogue.title")} />
            <PageFailed
              error={dataset.error}
              onRetry={() => {
                void dataset.refetch();
              }}
            />
          </>
        )}
      </div>
    );
  }
  return <Dataset detail={dataset.data} back={back} />;
}

function Dataset({ detail, back }: { detail: DatasetDetail; back: JSX.Element }): JSX.Element {
  const { t, i18n } = useTranslation();
  const themeLabel = useThemeLabel();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const date = (value: string | null | undefined) => {
    const parsed = value ? new Date(value) : null;
    return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toLocaleDateString(locale) : null;
  };
  const temporal = detail.temporal
    ? t("catalogue.dataset.period", {
        start: date(detail.temporal.start) ?? t("catalogue.dataset.open"),
        end: date(detail.temporal.end) ?? t("catalogue.dataset.open"),
      })
    : null;
  const frequency = detail.frequency ? detail.frequency.split("/").pop() : null;
  const facts: Array<[string, React.ReactNode]> = [
    [t("catalogue.facets.publisher"), detail.publisher?.title],
    [
      t("catalogue.facets.licence"),
      detail.licence ? (
        detail.licence.url ? (
          <ExternalLink href={detail.licence.url}>{detail.licence.title}</ExternalLink>
        ) : (
          detail.licence.title
        )
      ) : null,
    ],
    [
      t("catalogue.dataset.frequency"),
      frequency ? t(`catalogue.frequency.${frequency}`, { defaultValue: frequency }) : null,
    ],
    [t("catalogue.facets.spatial"), detail.spatial.length > 0 ? detail.spatial.join(", ") : null],
    [t("catalogue.facets.year"), temporal],
    [
      t("catalogue.dataset.contact"),
      detail.contact
        ? [detail.contact.name, detail.contact.email].filter(Boolean).join(", ")
        : null,
    ],
    [t("catalogue.dataset.modifiedLabel"), date(detail.modified)],
  ];

  return (
    <div className="flex flex-col gap-section">
      {back}
      <PageHeader
        title={detail.title}
        description={detail.notes}
        actions={<ExternalLink href={detail.catalogueUrl}>{t("catalogue.dataset.inCatalogue")}</ExternalLink>}
      />

      <Card>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {facts
            .filter(([, value]) => value !== null && value !== undefined && value !== "")
            .map(([label, value]) => (
              <div key={label} className="flex flex-col gap-0.5">
                <dt className="text-caption font-semibold text-fg-muted">{label}</dt>
                <dd className="text-body text-fg">{value}</dd>
              </div>
            ))}
        </dl>
        {detail.themes.length > 0 || detail.keywords.length > 0 ? (
          <ul className="mt-4 flex flex-wrap gap-1" aria-label={t("catalogue.dataset.tags")}>
            {detail.themes.map((theme) => (
              <li key={`theme-${theme.code}`}>
                <Badge tone="info">{themeLabel(theme.code, theme.label)}</Badge>
              </li>
            ))}
            {detail.keywords.map((keyword) => (
              <li key={`keyword-${keyword}`}>
                <Badge>{keyword}</Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Resources detail={detail} />
      {detail.model ? <Model model={detail.model} /> : null}
      {detail.endpoint ? <Sample name={detail.name} /> : null}
      {detail.endpoint ? (
        <UseThisData
          items={snippets(
            detail.endpoint.url,
            detail.endpoint.representations,
            detail.model?.classes[0]?.name,
            detail.name,
          )}
        />
      ) : null}
    </div>
  );
}

function Resources({ detail }: { detail: DatasetDetail }): JSX.Element {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="catalogue-resources" className="flex flex-col gap-3">
      <h2 id="catalogue-resources" className="font-heading text-title font-semibold">
        {t("catalogue.dataset.resources")}
      </h2>
      {detail.resources.length === 0 ? (
        <p className="text-body text-fg-muted">{t("catalogue.dataset.noResources")}</p>
      ) : (
        <Table caption={t("catalogue.dataset.resources")}>
          <TableHead>
            <TableHeaderCell>{t("catalogue.dataset.resource")}</TableHeaderCell>
            <TableHeaderCell>{t("catalogue.facets.format")}</TableHeaderCell>
            <TableHeaderCell>{t("catalogue.dataset.links")}</TableHeaderCell>
          </TableHead>
          <TableBody>
            {detail.resources.map((resource) => (
              <TableRow key={`${resource.format}-${resource.url}`}>
                <TableCell primary>
                  <div>{resource.name}</div>
                  {resource.description ? (
                    <div className="mt-0.5 text-caption text-fg-muted">{resource.description}</div>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Badge mono>{resource.format || "—"}</Badge>
                </TableCell>
                <TableCell>
                  <ul className="flex flex-wrap gap-3">
                    <li>
                      <ExternalLink href={resource.url}>{t("catalogue.dataset.download")}</ExternalLink>
                    </li>
                    {resource.previewUrl ? (
                      <li>
                        <ExternalLink href={resource.previewUrl}>{t("catalogue.dataset.preview")}</ExternalLink>
                      </li>
                    ) : null}
                  </ul>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function Model({ model }: { model: NonNullable<DatasetDetail["model"]> }): JSX.Element {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader
        title={t("catalogue.dataset.model", { name: model.name })}
        actions={
          model.docsUrl ? <ExternalLink href={model.docsUrl}>{t("catalogue.dataset.modelDocs")}</ExternalLink> : undefined
        }
      />
      <dl className="flex flex-col gap-2">
        {model.classes.map((cls) => (
          <div key={cls.name}>
            <dt className="font-mono text-body font-medium text-fg">{cls.name}</dt>
            <dd className="text-body text-fg-muted">{cls.description ?? t("catalogue.dataset.noDescription")}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function Sample({ name }: { name: string }): JSX.Element {
  const { t } = useTranslation();
  const sample = useQuery({
    queryKey: [...datasetKey(name), "sample"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/catalogue/datasets/{name}/sample", { params: { path: { name } } }),
      ),
  });
  return (
    <section aria-labelledby="catalogue-sample" className="flex flex-col gap-3">
      <h2 id="catalogue-sample" className="font-heading text-title font-semibold">
        {t("catalogue.dataset.sample")}
      </h2>
      {sample.isPending ? (
        <p role="status" className="text-body text-fg-muted">
          {t("catalogue.dataset.sampleLoading")}
        </p>
      ) : sample.isError ? (
        sample.error instanceof ApiError && sample.error.status === 404 ? (
          <p className="text-body text-fg-muted">{t("catalogue.dataset.noSample")}</p>
        ) : (
          <Alert
            tone="danger"
            role="alert"
            actions={
              <Button size="sm" onClick={() => void sample.refetch()}>
                {t("app.error.retry")}
              </Button>
            }
          >
            {problemOf(sample.error, t("app.error.generic"))}
          </Alert>
        )
      ) : sample.data.rows.length === 0 ? (
        <p className="text-body text-fg-muted">{t("catalogue.dataset.sampleEmpty", { type: sample.data.type })}</p>
      ) : (
        <Table caption={t("catalogue.dataset.sampleCaption", { type: sample.data.type })} maxHeight="24rem">
          <TableHead>
            {sample.data.columns.map((column) => (
              <TableHeaderCell key={column}>{column}</TableHeaderCell>
            ))}
          </TableHead>
          <TableBody>
            {sample.data.rows.map((row, index) => (
              <TableRow key={row[0] || index}>
                {row.map((cell, column) => (
                  <TableCell key={sample.data.columns[column]} className="max-w-64 truncate font-mono text-caption" title={cell}>
                    {cell}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function UseThisData({ items }: { items: Snippet[] }): JSX.Element | null {
  const { t } = useTranslation();
  if (items.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="catalogue-use" className="flex flex-col gap-3">
      <h2 id="catalogue-use" className="font-heading text-title font-semibold">
        {t("catalogue.use.title")}
      </h2>
      {items.map((item) => (
        <SnippetBlock key={item.key} item={item} />
      ))}
    </section>
  );
}

function SnippetBlock({ item }: { item: Snippet }): JSX.Element {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const title = t(`catalogue.use.${item.key}`);
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-body font-semibold text-fg">{title}</h3>
        <Button
          size="sm"
          variant="ghost"
          aria-label={copied ? t("catalogue.use.copied") : t("catalogue.use.copy", { what: title })}
          icon={<Icon name={copied ? "check" : "copy"} className="size-4" />}
          onClick={() => {
            void navigator.clipboard?.writeText(item.code).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? t("catalogue.use.copied") : t("catalogue.use.copyShort")}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md bg-surface-muted p-3 font-mono text-caption text-fg">
        <code>{item.code}</code>
      </pre>
    </Card>
  );
}
