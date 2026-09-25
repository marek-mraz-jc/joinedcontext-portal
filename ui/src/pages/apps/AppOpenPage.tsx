import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, queryKeys, unwrap } from "../../api/client";
import { localized } from "../../api/manifest";
import type { Manifest } from "../../api/manifest";
import { useAuth } from "../../auth/AuthProvider";
import { Button, buttonClass, EmptyState, ExternalLink, PageFailed, PageHeader, PageLoading } from "../../components/ui";
import { useAppBuild } from "./AppBuildPanel";
import { appSpec, openBlockedReason } from "./AppsCatalog";
import { appDisplayName } from "./appTitle";

/**
 * What a sandboxed App frame may do (AP-122): run its scripts on its own origin, send its forms,
 * open a link in a new window and download a file. No `allow-top-navigation`: the App never
 * takes the Portal's window away.
 */
export const APP_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads";

/** The App's own address. On the Portal's host the static host sends the frame to the apps origin. */
export function appAddress(name: string): string {
  return `/apps/${encodeURIComponent(name)}/`;
}

/** The one App manifest, shared with every page that reads it. */
function useApp(project: string, name: string) {
  return useQuery({
    queryKey: queryKeys.resource(project, "apps", name),
    retry: false,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}/{name}", {
          params: { path: { project, plural: "apps", name } },
        }),
      ) as unknown as Manifest,
  });
}

/**
 * "Open app" on the App's own page (AP-122): the in-Portal page when something is served, the
 * reason in place of the button when not. A retired App offers nothing to open.
 */
export function OpenAppButton({ project, name }: { project: string; name: string }): JSX.Element | null {
  const { t } = useTranslation();
  const app = useApp(project, name);
  const build = useAppBuild(project, name);
  // Nothing until the App is read: no guessed button, and no button for a name that is no App.
  if (app.data?.kind !== "App") return null;
  if (appSpec(app.data).lifecycle === "retired") return null;
  const reason = openBlockedReason(app.data, build.data?.run ?? null, t);
  return reason ? (
    <Button size="sm" variant="primary" disabled disabledReason={reason}>
      {t("apps.openAction")}
    </Button>
  ) : (
    <Link
      to="/projects/$project/$plural/$name/open"
      params={{ project, plural: "apps", name }}
      className={buttonClass("primary", "sm")}
    >
      {t("apps.openAction")}
    </Link>
  );
}

/**
 * A published App inside the Portal, under its header and sidebar (AP-122, UI-44). The frame is
 * sandboxed and only the Portal's host may frame an App. "Open in new window" opens the same
 * address as a page of its own. A retired, unpublished or never-built App shows its state
 * instead of a frame that would only say "not found".
 */
export function AppOpenPage({ project, name }: { project: string; name: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { signIn } = useAuth();
  const app = useApp(project, name);
  const build = useAppBuild(project, name);

  const toApp = () => {
    void navigate({
      to: "/projects/$project/$plural/$name",
      params: { project, plural: "apps", name },
    });
  };
  const details = <Button onClick={toApp}>{t("apps.openPage.details")}</Button>;
  const fallbackTitle = appDisplayName({ appName: name });

  if (app.isPending) {
    return (
      <div className="space-y-4">
        <PageHeader title={fallbackTitle} actions={details} />
        <PageLoading label={t("app.loading")} />
      </div>
    );
  }
  if (app.isError) {
    return (
      <div className="space-y-4">
        <PageHeader title={fallbackTitle} actions={details} />
        <PageFailed
          error={app.error}
          onRetry={() => {
            void app.refetch();
          }}
        />
      </div>
    );
  }

  const manifest = app.data;
  const title = localized(manifest.metadata.title, i18n.language, fallbackTitle);
  // The schema leaves `status.build` open; the lane writes the commit it built there (AP-86).
  const built = manifest.status?.build as { commit?: unknown } | undefined;
  const commit = typeof built?.commit === "string" ? built.commit : null;
  const blocked = openBlockedReason(manifest, build.data?.run ?? null, t);
  const address = appAddress(name);

  if (blocked) {
    return (
      <div className="space-y-4">
        <PageHeader title={title} actions={details} />
        <EmptyState title={blocked} description={t("apps.openPage.notOpen")} icon="apps" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageHeader
        title={title}
        description={commit ? t("apps.openPage.served", { commit: commit.slice(0, 7) }) : undefined}
        actions={
          <>
            {details}
            <ExternalLink href={address} hideIcon className={buttonClass("secondary", "sm")}>
              {t("apps.openPage.newWindow")}
            </ExternalLink>
          </>
        }
      />
      <iframe
        src={address}
        title={t("apps.openPage.frameTitle", { title })}
        sandbox={APP_FRAME_SANDBOX}
        referrerPolicy="no-referrer"
        className="min-h-[32rem] w-full flex-1 rounded-xl border border-border bg-surface"
      />
      <p className="text-sm text-fg-muted">
        {t("apps.openPage.signInHint")}{" "}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            signIn(`${window.location.pathname}${window.location.search}`);
          }}
        >
          {t("apps.openPage.signInAgain")}
        </Button>
      </p>
    </div>
  );
}
