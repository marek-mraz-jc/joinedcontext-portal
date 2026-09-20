import { useMemo, useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";
import { api, queryKeys, unwrap } from "../../api/client";
import { asManifests, localized } from "../../api/manifest";
import type { Manifest } from "../../api/manifest";
import { Instantiate } from "./Instantiate";
import { Button, EmptyState, PageFailed, PageHeader, PageLoading } from "../../components/ui";

/** The three review lanes a blueprint declares (CC-59, CC-63). */
const RISK_STYLES: Record<string, string> = {
  green: "bg-success/15 border-success/40",
  yellow: "bg-warning/20 border-warning/40",
  red: "bg-danger/15 border-danger/40",
};

/** Sorts before every real category, so "Other" is the last chip rather than a random one. */
const UNCATEGORISED = "￿";

export interface BlueprintSpec {
  version?: string;
  category?: string | null;
  riskClass?: string;
  allowedRoles?: string[];
  parameterSchema?: Record<string, unknown>;
}

export function blueprintSpec(blueprint: Manifest): BlueprintSpec {
  return blueprint.spec as BlueprintSpec;
}

function RiskBadge({ riskClass }: { riskClass?: string }): JSX.Element | null {
  const { t } = useTranslation();
  const key = (riskClass ?? "").toLowerCase();
  if (!RISK_STYLES[key]) {
    return null;
  }
  return (
    <span
      className={`rounded border px-2 py-0.5 text-caption ${RISK_STYLES[key]}`}
      // The colour is never the only carrier: the label says what the lane costs the user.
      title={t("flows.riskLabel")}
    >
      {t(`flows.risk.${key}`)}
    </span>
  );
}

/**
 * The flow gallery: the primary way a user configures anything (CC-30). Cards, not YAML, and
 * only the blueprints this caller may run — the server filters by `spec.allowedRoles` (CC-59),
 * so a card that is missing here is refused there too.
 */
export function FlowGallery({ project }: { project: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const [category, setCategory] = useState<string | null>(null);
  const [selected, setSelected] = useState<Manifest | null>(null);

  const list = useQuery({
    queryKey: queryKeys.blueprints(),
    queryFn: async () => unwrap(await api.GET("/api/v1/blueprints", {})),
  });

  const blueprints = useMemo(() => asManifests(list.data?.items ?? []), [list.data]);

  const categories = useMemo(() => {
    const found = new Set<string>();
    for (const blueprint of blueprints) {
      found.add(blueprintSpec(blueprint).category || UNCATEGORISED);
    }
    return [...found].sort();
  }, [blueprints]);

  // Both waits keep the page's own heading: without it the title appeared only once the
  // blueprints had arrived, so the tab, the outline and the first thing a screen reader reads
  // all changed under the reader between the wait and the gallery (UI-15).
  if (list.isPending) {
    return (
      <div className="space-y-4">
        <PageHeader title={t("flows.title")} description={t("flows.subtitle")} />
        <PageLoading label={t("app.loading")} lines={3} />
      </div>
    );
  }

  if (list.isError) {
    return (
      <div className="space-y-4">
        <PageHeader title={t("flows.title")} description={t("flows.subtitle")} />
        <PageFailed
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      </div>
    );
  }

  if (selected) {
    return (
      <Instantiate
        project={project}
        blueprint={selected}
        onBack={() => {
          setSelected(null);
        }}
      />
    );
  }

  const shown = category
    ? blueprints.filter((b) => (blueprintSpec(b).category || UNCATEGORISED) === category)
    : blueprints;

  return (
    <div className="space-y-4">
      <PageHeader title={t("flows.title")} description={t("flows.subtitle")} />

      {categories.length > 1 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("flows.title")}>
          <FilterChip
            label={t("flows.category.all")}
            active={category === null}
            onClick={() => {
              setCategory(null);
            }}
          />
          {categories.map((name) => (
            <FilterChip
              key={name}
              label={name === UNCATEGORISED ? t("flows.category.uncategorised") : name}
              active={category === name}
              onClick={() => {
                setCategory(name);
              }}
            />
          ))}
        </div>
      )}

      {blueprints.length === 0 && <EmptyState title={t("flows.empty")}
              description={t("flows.emptyHint")} />}
      {blueprints.length > 0 && shown.length === 0 && (
        <EmptyState title={t("flows.emptyFiltered")} />
      )}

      <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4">
        {shown.map((blueprint) => {
          const spec = blueprintSpec(blueprint);
          const title = localized(blueprint.metadata.title, i18n.language, blueprint.metadata.name);
          return (
            <li
              key={blueprint.metadata.name}
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 shadow-1"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold">{title}</h2>
                <RiskBadge riskClass={spec.riskClass} />
              </div>
              <p className="text-caption text-fg-muted">
                {localized(blueprint.metadata.description, i18n.language, "")}
              </p>
              {spec.version ? (
                <p className="text-caption text-fg-muted">{t("flows.version", { version: spec.version })}</p>
              ) : null}
              <Button
                size="sm"
                className="mt-auto self-start"
                onClick={() => {
                  setSelected(blueprint);
                }}
              >
                {t("flows.run")}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  // The shared Button, rounded into a pill: the focus ring, the height and the disabled
  // behaviour then come from one place instead of three hand-written classes that had already
  // drifted from it (UI-01, UI-16).
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-pressed={active}
      onClick={onClick}
      className={clsx("rounded-full", active && "border-border-focus bg-surface-subtle")}
    >
      {label}
    </Button>
  );
}
