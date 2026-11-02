import { Suspense, lazy } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAuthStatus } from "../../auth/AuthProvider";
import { Icon, PageHeader, PageLoading } from "../../components/ui";
import { readableQuery } from "./queries";
import { AccessBadge } from "./ReadableDatasets";

const EndpointDataView = lazy(() =>
  import("../../components/entities/EndpointDataView").then((module) => ({ default: module.EndpointDataView })),
);

/**
 * One dataset of the catalogue by its Endpoint (ADR-N-067 §2.4, T-6411), read live with the
 * person's own session. The grid answers the refusals itself (T-6376): anonymous on a
 * non-public Endpoint gets "sign in", signed in without a grant "no access"; never an empty grid
 * and never a copy.
 */
export function EndpointDatasetPage({ slug }: { slug: string }): JSX.Element {
  const { t } = useTranslation();
  const status = useAuthStatus();
  // The title and the mark come from what the person may read; the grid decides alone.
  const readable = useQuery({ ...readableQuery(), enabled: status === "authenticated" });
  const dataset = readable.data?.datasets.find((row) => row.slug === slug);
  return (
    <div className="flex flex-col gap-section">
      <Link to="/catalogue" className="focus-ring inline-flex items-center gap-1 self-start rounded-sm text-body text-primary-soft-fg hover:underline">
        <Icon name="chevronLeft" className="size-4" />
        {t("catalogue.dataset.back")}
      </Link>
      <PageHeader
        title={dataset?.title ?? dataset?.name ?? t("catalogue.readable.endpoint.title")}
        titleAction={dataset ? <AccessBadge dataset={dataset} /> : undefined}
        description={dataset?.description ?? t("catalogue.readable.endpoint.lead")}
      />
      <Suspense fallback={<PageLoading label={t("catalogue.dataset.loading")} />}>
        <EndpointDataView project={dataset?.project ?? "catalogue"} slug={slug} csv={dataset?.representations.includes("csv") ?? false} />
      </Suspense>
    </div>
  );
}
