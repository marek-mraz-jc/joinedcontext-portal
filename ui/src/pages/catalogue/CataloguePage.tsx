import { useState } from "react";
import type { JSX } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError, unwrap } from "../../api/client";
import type { components } from "../../api/schema";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Icon,
  Input,
  PageFailed,
  PageHeader,
  PageLoading,
} from "../../components/ui";
import { FACETS, narrowed, toggled } from "./search";
import type { CatalogueSearch, FacetName } from "./search";

type CataloguePageAnswer = components["schemas"]["CataloguePage"];
type CatalogueDataset = components["schemas"]["CatalogueDataset"];
type FacetValue = components["schemas"]["CatalogueFacetValue"];

export function catalogueKey(search: CatalogueSearch) {
  return ["catalogue", search] as const;
}

/** The name of an EU data theme in the reader's language, the catalogue's English one else. */
export function useThemeLabel(): (code: string, fallback?: string) => string {
  const { t } = useTranslation();
  return (code, fallback) => t(`catalogue.theme.${code}`, { defaultValue: fallback ?? code });
}

/**
 * Every public dataset of the installation, searched and faceted (EP-81, Architecture/21 §6).
 *
 * The page reads what the catalogues hold, through the Portal's anonymous read of CKAN, so it
 * shows the same to a citizen with a link as to a steward who is signed in; nothing on it needs
 * a session. The search lives in the address, so a filtered list is a link one can share.
 */
export function CataloguePage({
  search,
  onSearch,
}: {
  search: CatalogueSearch;
  onSearch: (next: CatalogueSearch) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const catalogue = useQuery({
    queryKey: catalogueKey(search),
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/catalogue", {
          params: {
            query: {
              q: search.q,
              publisher: search.publisher,
              theme: search.theme,
              format: search.format,
              licence: search.licence,
              spatial: search.spatial,
              year: search.year,
              page: search.page,
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
  });

  const header = <PageHeader title={t("catalogue.title")} description={t("catalogue.lead")} />;

  return (
    <div className="flex flex-col gap-section">
      {header}
      {/* Keyed by the address's text: a back button or a shared link resets the box to it. */}
      <SearchForm key={search.q ?? ""} search={search} onSearch={onSearch} />

      {catalogue.isPending ? (
        <PageLoading label={t("catalogue.loading")} />
      ) : catalogue.isError ? (
        <PageFailed
          error={catalogue.error}
          onRetry={() => {
            void catalogue.refetch();
          }}
        />
      ) : (
        <Results
          answer={catalogue.data}
          search={search}
          onSearch={onSearch}
          refreshing={catalogue.isFetching}
        />
      )}
    </div>
  );
}

function SearchForm({
  search,
  onSearch,
}: {
  search: CatalogueSearch;
  onSearch: (next: CatalogueSearch) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [text, setText] = useState(search.q ?? "");
  return (
    <form
      role="search"
      aria-label={t("catalogue.search.label")}
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const q = text.trim();
        onSearch({ ...search, q: q === "" ? undefined : q, page: undefined });
      }}
    >
      <label className="flex min-w-64 flex-1 flex-col gap-1 text-body font-medium text-fg">
        {t("catalogue.search.label")}
        <Input
          type="search"
          value={text}
          maxLength={200}
          placeholder={t("catalogue.search.placeholder")}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <Button type="submit" variant="primary" icon={<Icon name="search" className="size-4" />}>
        {t("catalogue.search.submit")}
      </Button>
      {narrowed(search) ? (
        <Button type="button" variant="ghost" onClick={() => onSearch({})}>
          {t("catalogue.search.clear")}
        </Button>
      ) : null}
    </form>
  );
}

function Results({
  answer,
  search,
  onSearch,
  refreshing,
}: {
  answer: CataloguePageAnswer;
  search: CatalogueSearch;
  onSearch: (next: CatalogueSearch) => void;
  refreshing: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(answer.total / answer.pageSize));
  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <aside aria-label={t("catalogue.facets.label")} className="flex w-full flex-col gap-4 lg:w-72 lg:shrink-0">
        {FACETS.map((facet) => (
          <FacetGroup
            key={facet}
            facet={facet}
            values={answer.facets[facet]}
            selected={search[facet] ?? []}
            onToggle={(value) => onSearch(toggled(search, facet, value))}
          />
        ))}
      </aside>
      <section aria-label={t("catalogue.results.label")} aria-busy={refreshing} className="flex min-w-0 flex-1 flex-col gap-4">
        {answer.unavailable.length > 0 ? (
          <Alert tone="warning">
            {t("catalogue.unavailable", { catalogues: answer.unavailable.join(", ") })}
          </Alert>
        ) : null}
        <p role="status" className="text-body text-fg-muted">
          {t("catalogue.results.count", { count: answer.total })}
        </p>
        {answer.datasets.length === 0 ? (
          <EmptyState
            icon="ckan"
            title={narrowed(search) ? t("catalogue.results.noMatch") : t("catalogue.results.empty")}
            description={
              narrowed(search) ? t("catalogue.results.noMatchHint") : t("catalogue.results.emptyHint")
            }
            action={
              narrowed(search) ? (
                <Button variant="secondary" onClick={() => onSearch({})}>
                  {t("catalogue.search.clear")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {answer.datasets.map((dataset) => (
              <li key={dataset.name}>
                <DatasetCard dataset={dataset} />
              </li>
            ))}
          </ul>
        )}
        {pages > 1 ? (
          <nav aria-label={t("catalogue.pages.label")} className="flex items-center justify-between gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={answer.page <= 1}
              disabledReason={t("catalogue.pages.first")}
              onClick={() => onSearch({ ...search, page: answer.page - 1 > 1 ? answer.page - 1 : undefined })}
            >
              {t("catalogue.pages.previous")}
            </Button>
            <span className="text-body text-fg-muted">
              {t("catalogue.pages.of", { page: answer.page, pages })}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={answer.page >= pages}
              disabledReason={t("catalogue.pages.last")}
              onClick={() => onSearch({ ...search, page: answer.page + 1 })}
            >
              {t("catalogue.pages.next")}
            </Button>
          </nav>
        ) : null}
      </section>
    </div>
  );
}

function FacetGroup({
  facet,
  values,
  selected,
  onToggle,
}: {
  facet: FacetName;
  values: FacetValue[];
  selected: string[];
  onToggle: (value: string) => void;
}): JSX.Element | null {
  const { t } = useTranslation();
  const themeLabel = useThemeLabel();
  // A selected value the current search no longer counts stays, so it can be turned off again.
  const shown = [
    ...values,
    ...selected
      .filter((value) => !values.some((v) => v.value === value))
      .map((value) => ({ value, label: value, count: 0 })),
  ];
  if (shown.length === 0) {
    return null;
  }
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-caption font-semibold uppercase tracking-wide text-fg-muted">
        {t(`catalogue.facets.${facet}`)}
      </legend>
      <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
        {shown.map((value) => (
          <Checkbox
            key={value.value}
            checked={selected.includes(value.value)}
            onChange={() => onToggle(value.value)}
            label={facet === "theme" ? themeLabel(value.value, value.label) : value.label}
            hint={`(${value.count})`}
          />
        ))}
      </div>
    </fieldset>
  );
}

function DatasetCard({ dataset }: { dataset: CatalogueDataset }): JSX.Element {
  const { t, i18n } = useTranslation();
  const themeLabel = useThemeLabel();
  const modified = dataset.modified ? new Date(dataset.modified) : null;
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="font-heading text-title font-semibold">
        <Link
          to="/catalogue/$name"
          params={{ name: dataset.name }}
          className="focus-ring rounded-sm text-fg hover:underline"
        >
          {dataset.title}
        </Link>
      </h2>
      <p className="text-caption text-fg-muted">
        {[
          dataset.publisher?.title,
          dataset.licence?.title,
          modified && !Number.isNaN(modified.getTime())
            ? t("catalogue.dataset.modified", {
                date: modified.toLocaleDateString(i18n.resolvedLanguage ?? i18n.language),
              })
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {dataset.notes ? <p className="line-clamp-3 text-body text-fg">{dataset.notes}</p> : null}
      {dataset.formats.length > 0 || dataset.themes.length > 0 ? (
        <ul className="flex flex-wrap gap-1" aria-label={t("catalogue.dataset.tags")}>
          {dataset.themes.map((theme) => (
            <li key={`theme-${theme}`}>
              <Badge tone="info">{themeLabel(theme)}</Badge>
            </li>
          ))}
          {dataset.formats.map((format) => (
            <li key={`format-${format}`}>
              <Badge mono>{format}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/** A failed read's words, for the pages that show them inline rather than as a page. */
export function problemOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.problem?.detail ?? error.message) : fallback;
}
