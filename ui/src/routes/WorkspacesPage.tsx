import { useState } from "react";
import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { WorkOnCopyAction } from "../components/WorkOnCopyDialog";
import {
  Alert,
  Badge,
  Button,
  buttonClass,
  ConfirmDialog,
  EmptyState,
  Icon,
  PageHeader,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../components/ui";
import type { components } from "../api/schema";

type WorkspaceView = components["schemas"]["WorkspaceView"];

export function WorkspacesPage({
  project,
  creating = false,
}: {
  project: string;
  /** `/workspaces/new`: the "Work on a copy" dialog is open on the list (T-2749). */
  creating?: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const { identity } = useAuth();
  const navigate = useNavigate();
  // Into the copy at the project's spaces; someone else's copy reads, and refuses a write.
  const openIn = (name: string) =>
    void navigate({
      to: "/projects/$project/$plural",
      params: { project, plural: "spaces" },
      search: { workspace: name },
    });
  const queryClient = useQueryClient();
  // The copy a person asked to discard, while the dialog names it and asks (UI-16).
  const [discarding, setDiscarding] = useState<string | null>(null);

  const list = useQuery({
    queryKey: queryKeys.list(project, "workspaces"),
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/workspaces", {
          params: { path: { project } },
        }),
      ),
  });

  const discard = useMutation({
    mutationFn: async (name: string) =>
      unwrap(
        await api.DELETE("/api/v1/projects/{project}/workspaces/{name}", {
          params: { path: { project, name } },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.list(project, "workspaces"),
      });
    },
  });

  const items = list.data?.items ?? [];
  // The owner is who opened it, by the address commits are signed with, or the username.
  const isMine = (w: WorkspaceView) =>
    !!identity && (w.owner === identity.email || w.owner === identity.username);
  const mine = items.filter(isMine);
  const others = items.filter((w) => !isMine(w));

  const confirmDiscard = discarding ? (
    <ConfirmDialog
      open
      onOpenChange={(next) => {
        if (!next) setDiscarding(null);
      }}
      title={t("workspaces.discard")}
      description={t("workspaces.discardConfirm", { name: discarding })}
      confirmLabel={t("workspaces.discard")}
      pending={discard.isPending}
      onConfirm={() =>
        discard.mutate(discarding, {
          onSettled: () => setDiscarding(null),
        })
      }
    />
  ) : null;

  return (
    <section aria-label={t("workspaces.title")} className="space-y-6">
      <PageHeader
        title={t("workspaces.title")}
        description={t("workspaces.lead")}
        actions={
          <WorkOnCopyAction
            project={project}
            scope={{ kind: "project" }}
            label={t("workspaces.new")}
            variant="primary"
            open={creating}
            onOpenChange={(open) => {
              if (!open && creating) {
                void navigate({ to: "/projects/$project/workspaces", params: { project } });
              }
            }}
          />
        }
      />

      {list.isPending ? (
        <div role="status" aria-busy="true" aria-label={t("app.loading")} className="space-y-3">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-24" />
        </div>
      ) : null}
      {/* A list that could not be asked for is not "you have no copies" (T-1763): the API's own
          sentence, and one more try, so "you may not read this project" and "the database is
          away" do not read the same. */}
      {list.isError ? (
        <Alert
          role="alert"
          tone="danger"
          actions={
            <Button
              size="sm"
              icon={<Icon name="refresh" className="size-4" />}
              onClick={() => {
                void list.refetch();
              }}
            >
              {t("app.error.retry")}
            </Button>
          }
        >
          {list.error instanceof ApiError
            ? (list.error.problem?.detail ?? list.error.message)
            : t("app.error.generic")}
        </Alert>
      ) : null}

      {list.isPending || list.isError ? null : items.length === 0 ? (
        <EmptyState title={t("workspaces.empty")}
          description={t("workspaces.emptyHint")} />
      ) : (
        <div className="space-y-8">
          {mine.length > 0 ? (
            <section>
              <h2 className="text-title font-semibold mb-3">
                {t("workspaces.mine")}
              </h2>
              <WorkspaceTable
                project={project}
                workspaces={mine}
                isMine
                onOpen={openIn}
                onDiscard={setDiscarding}
              />
            </section>
          ) : null}
          {others.length > 0 ? (
            <section>
              <h2 className="text-title font-semibold mb-3">
                {t("workspaces.othersTitle")}
              </h2>
              <WorkspaceTable
                project={project}
                workspaces={others}
                isMine={false}
                onOpen={openIn}
              />
            </section>
          ) : null}
        </div>
      )}
      {confirmDiscard}
    </section>
  );
}

function WorkspaceTable({
  project,
  workspaces,
  isMine,
  onOpen,
  onDiscard,
}: {
  project: string;
  workspaces: WorkspaceView[];
  isMine: boolean;
  onOpen: (name: string) => void;
  onDiscard?: (name: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <Table caption={t("workspaces.tableCaption")}>
      <TableHead>
        <TableHeaderCell>{t("workspaces.name")}</TableHeaderCell>
        {!isMine ? (
          <TableHeaderCell>{t("workspaces.owner")}</TableHeaderCell>
        ) : null}
        <TableHeaderCell>{t("workspaces.scope")}</TableHeaderCell>
        <TableHeaderCell>{t("workspaces.expiresColumn")}</TableHeaderCell>
        <TableHeaderCell>{t("workspaces.previewColumn")}</TableHeaderCell>
        <TableHeaderCell align="right">{t("workspaces.actions")}</TableHeaderCell>
      </TableHead>
      <TableBody>
        {workspaces.map((ws) => (
          <TableRow key={ws.name}>
            <TableCell primary>
              <span className="font-medium">{ws.title ?? ws.name}</span>
              {ws.title ? (
                <span className="block text-caption text-fg-muted">
                  {ws.name}
                </span>
              ) : null}
            </TableCell>
            {!isMine ? (
              <TableCell>{ws.owner}</TableCell>
            ) : null}
            <TableCell>
              {ws.scope?.kind === "project"
                ? t("workspaces.scopeProject")
                : ws.scope?.kind === "space"
                  ? t("workspaces.scopeSpace", { name: ws.scope.name })
                  : ws.scope?.kind === "resources"
                    ? ws.scope.items?.map((i) => `${i.kind}/${i.name}`).join(", ") ?? ""
                    : ""}
            </TableCell>
            <TableCell>
              {t("workspaces.expires", {
                date: new Date(ws.expiresAt).toLocaleDateString(),
              })}
            </TableCell>
            <TableCell>
              <Badge
                tone={
                  ws.previewState === "error"
                    ? "danger"
                    : ws.previewState === "running"
                      ? "success"
                      : ws.previewState === "starting"
                        ? "warning"
                        : "neutral"
                }
              >
                {t(`workspaces.previewStates.${ws.previewState}`)}
              </Badge>
            </TableCell>
            <TableCell align="right">
              <div className="flex flex-wrap justify-end gap-2">
                <Button size="sm" onClick={() => onOpen(ws.name)}>
                  {t("workspaces.openAction")}
                </Button>
                <Link
                  to="/projects/$project/workspaces/$name/compare"
                  params={{ project, name: ws.name }}
                  className={buttonClass("ghost", "sm")}
                >
                  {t("workspaces.compareAction")}
                </Link>
                {isMine && onDiscard ? (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => onDiscard(ws.name)}
                  >
                    {t("workspaces.discard")}
                  </Button>
                ) : null}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
