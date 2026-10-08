import { useId, useState } from "react";
import type { FormEvent, JSX } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap } from "../api/client";
import { ChangeNotice } from "../components/ChangeNotice";
import { changeSentence, fieldSentence } from "./changeWords";
import type { PlannedField } from "./changeWords";
import { ResourceList } from "../components/ResourceList";
import { LifecycleBadge } from "../components/status/LifecycleBadge";
import {
  Alert,
  Button,
  EmptyState,
  Field,
  Input,
  PermissionGuard,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../components/ui";

const COLUMNS = 6;

interface Filter {
  kind: string;
  name: string;
  author: string;
  since: string;
  until: string;
}

const NO_FILTER: Filter = { kind: "", name: "", author: "", since: "", until: "" };

/** What one closed change touched, each field a sentence, read when the person asks (T-3274). */
function ChangedFields({ project, id }: { project: string; id: string }): JSX.Element {
  const { t } = useTranslation();
  const detail = useQuery({
    queryKey: queryKeys.change(project, id),
    queryFn: async () => unwrap(await api.GET("/api/v1/projects/{project}/changes/{id}", { params: { path: { project, id } } })),
  });
  if (detail.isPending) return <p className="text-caption text-fg-muted">{t("app.loading")}</p>;
  const fields = (detail.data?.planFields ?? []) as PlannedField[];
  if (detail.isError || fields.length === 0) {
    return <p className="text-caption text-fg-muted">{t("approvals.history.noFields")}</p>;
  }
  return (
    <ul className="mt-1 list-disc pl-5 text-caption text-fg">
      {fields.map((field) => (
        <li key={field.path}>{fieldSentence(field, t)}</li>
      ))}
    </ul>
  );
}

/**
 * The closed changes of a project (T-3292): what was merged or rejected, by whom and when,
 * newest first, a page at a time. The API applies the read rule of the open list, so a change to
 * a kind this person does not read is not here.
 */
export function ApprovalsHistory({
  project,
}: {
  project: string;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "sk";
  const id = useId();
  // What the form holds, and what the list was last asked for: a keystroke asks the forge nothing.
  const [draft, setDraft] = useState<Filter>(NO_FILTER);
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [opened, setOpened] = useState<string | null>(null);
  const queryClient = useQueryClient();
  // A merged removal can be proposed again (T-3247): the new change waits for an approver.
  const restore = useMutation({
    mutationFn: async (id: string) =>
      unwrap(
        await api.POST("/api/v1/projects/{project}/changes/{id}/restore", {
          params: { path: { project, id } },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.changes(project) });
    },
  });

  // A merged update can be undone while nothing changed it since (T-3274).
  const undo = useMutation({
    mutationFn: async (id: string) =>
      unwrap(
        await api.POST("/api/v1/projects/{project}/changes/{id}/undo", {
          params: { path: { project, id } },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.changes(project) });
    },
  });
  const proposed = undo.data ?? restore.data;
  const refused = undo.error ?? restore.error;

  const history = useInfiniteQuery({
    queryKey: [
      ...queryKeys.changes(project),
      "history",
      filter.kind,
      filter.name,
      filter.author,
      filter.since,
      filter.until,
    ] as const,
    initialPageParam: 1,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/changes/history", {
          params: {
            path: { project },
            query: {
              page: pageParam,
              kind: filter.kind || undefined,
              name: filter.name || undefined,
              author: filter.author || undefined,
              since: filter.since || undefined,
              until: filter.until || undefined,
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const items = history.data?.pages.flatMap((page) => page.items) ?? [];
  const kinds = [
    ...new Set(
      items
        .map((item) => (item.summary.params as Record<string, unknown>).kind)
        .filter((kind): kind is string => typeof kind === "string"),
    ),
  ];
  const filtered = Object.values(filter).some((value) => value !== "");
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilter({
      kind: draft.kind.trim(),
      name: draft.name.trim(),
      author: draft.author.trim(),
      since: draft.since,
      until: draft.until,
    });
  };
  const clear = () => {
    setDraft(NO_FILTER);
    setFilter(NO_FILTER);
  };

  return (
    <div className="flex flex-col gap-4">
      {proposed ? <ChangeNotice change={proposed} project={project} /> : null}
      {refused ? (
        <Alert tone="danger" role="alert">
          {refused instanceof ApiError ? (refused.problem?.detail ?? refused.message) : t("app.error.generic")}
        </Alert>
      ) : null}
      <form
        role="search"
        aria-label={t("approvals.history.filter")}
        onSubmit={submit}
        className="flex flex-wrap items-end gap-4"
      >
        <Field id={`${id}-kind`} label={t("approvals.history.kind")}>
          <Input
            id={`${id}-kind`}
            list={`${id}-kinds`}
            value={draft.kind}
            placeholder="Endpoint"
            onChange={(event) =>
              setDraft({ ...draft, kind: event.target.value })
            }
          />
        </Field>
        <datalist id={`${id}-kinds`}>
          {kinds.map((kind) => (
            <option key={kind} value={kind} />
          ))}
        </datalist>
        <Field id={`${id}-name`} label={t("approvals.history.name")}>
          <Input
            id={`${id}-name`}
            value={draft.name}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
        </Field>
        <Field id={`${id}-author`} label={t("approvals.history.author")}>
          <Input
            id={`${id}-author`}
            value={draft.author}
            onChange={(event) => setDraft({ ...draft, author: event.target.value })}
          />
        </Field>
        <Field id={`${id}-since`} label={t("approvals.history.since")}>
          <Input id={`${id}-since`} type="date" value={draft.since} onChange={(event) => setDraft({ ...draft, since: event.target.value })} />
        </Field>
        <Field id={`${id}-until`} label={t("approvals.history.until")}>
          <Input id={`${id}-until`} type="date" value={draft.until} onChange={(event) => setDraft({ ...draft, until: event.target.value })} />
        </Field>
        <Button type="submit" variant="primary">
          {t("approvals.history.apply")}
        </Button>
        {filtered ? (
          <Button type="button" variant="ghost" onClick={clear}>
            {t("approvals.history.clear")}
          </Button>
        ) : null}
      </form>
      <ResourceList
        query={history}
        caption={t("approvals.history.caption")}
        head={
          <TableHead>
            <TableHeaderCell>{t("approvals.summary")}</TableHeaderCell>
            <TableHeaderCell>{t("approvals.history.outcome")}</TableHeaderCell>
            <TableHeaderCell>
              {t("approvals.history.proposedBy")}
            </TableHeaderCell>
            <TableHeaderCell>
              {t("approvals.history.decidedBy")}
            </TableHeaderCell>
            <TableHeaderCell>{t("approvals.history.closed")}</TableHeaderCell>
            <TableHeaderCell align="right">{t("approvals.actions")}</TableHeaderCell>
          </TableHead>
        }
        columns={COLUMNS}
        count={items.length}
        empty={
          <EmptyState
            bare
            icon="approvals"
            title={
              filtered
                ? t("approvals.noneMatch")
                : history.hasNextPage
                  ? t("approvals.history.noneOnPage")
                  : t("approvals.history.empty")
            }
            description={filtered || history.hasNextPage ? undefined : t("approvals.history.emptyHint")}
          />
        }
      >
        {items.map((change) => (
          <TableRow key={change.metadata.name}>
            <TableCell primary>
              <Link
                to="/projects/$project/approvals/$id"
                params={{ project, id: change.metadata.name }}
                className="focus-ring rounded-sm text-primary-soft-fg hover:underline"
              >
                {changeSentence(change as Parameters<typeof changeSentence>[0], t)}
              </Link>
              <div className="mt-0.5 font-mono text-caption text-fg-subtle">
                {change.metadata.name}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="mt-1"
                aria-expanded={opened === change.metadata.name}
                onClick={() => setOpened(opened === change.metadata.name ? null : change.metadata.name)}
              >
                {t("approvals.history.whatChanged")}
              </Button>
              {opened === change.metadata.name ? <ChangedFields project={project} id={change.metadata.name} /> : null}
            </TableCell>
            <TableCell>
              <LifecycleBadge kind="phase" value={change.status.phase} />
            </TableCell>
            <TableCell>{change.author.name}</TableCell>
            <TableCell>
              {change.decision ? (
                <>
                  {change.decision.by}
                  {change.decision.reason ? (
                    <div className="mt-0.5 text-caption text-fg-muted">
                      {t("approvals.history.reason", {
                        reason: change.decision.reason,
                      })}
                    </div>
                  ) : null}
                </>
              ) : (
                <span className="text-fg-muted">
                  {t("approvals.history.inForge")}
                </span>
              )}
            </TableCell>
            <TableCell className="whitespace-nowrap text-fg-muted">
              {dateFormatter.format(
                new Date(change.decision?.at ?? change.createdAt),
              )}
            </TableCell>
            <TableCell align="right">
              {change.status.phase === "Merged" &&
              change.summary.key === "change.summary.delete" ? (
                <PermissionGuard
                  project={project}
                  kind={String((change.summary.params as Record<string, unknown>).kind ?? "")}
                  verb="propose"
                >
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={restore.isPending && restore.variables === change.metadata.name}
                    aria-label={t("approvals.history.restoreOf", {
                      name: String((change.summary.params as Record<string, unknown>).name ?? change.metadata.name),
                    })}
                    onClick={() => restore.mutate(change.metadata.name)}
                  >
                    {t("approvals.history.restore")}
                  </Button>
                </PermissionGuard>
              ) : null}
              {change.status.phase === "Merged" && change.summary.key === "change.summary.update" ? (
                <PermissionGuard
                  project={project}
                  kind={String((change.summary.params as Record<string, unknown>).kind ?? "")}
                  verb="propose"
                >
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={undo.isPending && undo.variables === change.metadata.name}
                    aria-label={t("approvals.history.undoOf", {
                      name: String((change.summary.params as Record<string, unknown>).name ?? change.metadata.name),
                    })}
                    onClick={() => undo.mutate(change.metadata.name)}
                  >
                    {t("approvals.history.undo")}
                  </Button>
                </PermissionGuard>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </ResourceList>
      {history.hasNextPage ? (
        <div>
          <Button
            variant="secondary"
            disabled={history.isFetchingNextPage}
            onClick={() => {
              void history.fetchNextPage();
            }}
          >
            {history.isFetchingNextPage
              ? t("app.loading")
              : t("approvals.history.older")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
