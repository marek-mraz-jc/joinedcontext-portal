/**
 * Comments on an entity and the notifications their mentions send (T-3106, API/01 §35). A person
 * who may read the space comments and names colleagues with `@identifier`; only a person who may
 * read the space is notified. A comment changes no data, and only its author removes it.
 */
import { useId, useState } from "react";
import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, unwrap } from "../../api/client";
import type { components } from "../../api/schema";
import { Alert, Button, Icon, Textarea } from "../../components/ui";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "../../components/ui/Menu";

type CommentView = components["schemas"]["CommentView"];
type Commented = components["schemas"]["Commented"];
type Notifications = components["schemas"]["Notifications"];

/** The key one entity's comments are cached under. */
export const commentsKey = (project: string, space: string, urn: string) => ["projects", project, "spaces", space, "comments", urn];

/** The key the signed-in person's notifications are cached under. */
export const NOTIFICATIONS_KEY = ["notifications"];

/** How long a comment may be, as the API takes it. */
const MAX_TEXT = 4000;

function when(at: string, language: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString(language, { dateStyle: "medium", timeStyle: "short" });
}

function problem(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CommentsPanel({ project, space, urn }: { project: string; space: string; urn: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const key = commentsKey(project, space, urn);
  const [text, setText] = useState("");
  const [unknown, setUnknown] = useState<string[]>([]);

  const comments = useQuery({
    queryKey: key,
    retry: false,
    queryFn: async () =>
      (await unwrap(
        await api.GET("/api/v1/projects/{project}/spaces/{space}/comments", {
          params: { path: { project, space }, query: { urn } },
        }),
      )) as CommentView[],
  });

  const post = useMutation({
    mutationFn: async (body: string) =>
      (await unwrap(
        await api.POST("/api/v1/projects/{project}/spaces/{space}/comments", {
          params: { path: { project, space } },
          body: { urn, text: body },
        }),
      )) as Commented,
    onSuccess: async (made) => {
      setText("");
      setUnknown(made.unknownMentions);
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const remove = useMutation({
    mutationFn: async (comment: number) => {
      await unwrap(
        await api.DELETE("/api/v1/projects/{project}/spaces/{space}/comments/{id}", {
          params: { path: { project, space, id: comment } },
        }),
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const trimmed = text.trim();
  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-2 border-t border-border pt-3">
      <h3 id={`${id}-heading`} className="text-body font-semibold">
        {t("spaces.comments.title")}
      </h3>
      {comments.isPending ? <p role="status">{t("app.loading")}</p> : null}
      {comments.isError ? (
        <Alert role="alert" tone="danger">
          {problem(comments.error)}
        </Alert>
      ) : null}
      {comments.data && comments.data.length === 0 ? <p className="text-body text-fg-muted">{t("spaces.comments.none")}</p> : null}
      {comments.data && comments.data.length > 0 ? (
        <ol className="flex flex-col gap-2" aria-label={t("spaces.comments.title")}>
          {comments.data.map((comment) => (
            <li key={comment.id} className="rounded-md border border-border bg-surface-muted p-2">
              <p className="flex flex-wrap items-baseline justify-between gap-2 text-caption text-fg-muted">
                <span>
                  <span className="font-semibold text-fg">{comment.authorName}</span> · {when(comment.createdAt, i18n.language)}
                </span>
                {comment.mine ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={t("spaces.comments.removeOne", { when: when(comment.createdAt, i18n.language) })}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(comment.id)}
                  >
                    {t("spaces.comments.remove")}
                  </Button>
                ) : null}
              </p>
              <p className="whitespace-pre-wrap text-body [overflow-wrap:anywhere]">{comment.text}</p>
            </li>
          ))}
        </ol>
      ) : null}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed) post.mutate(trimmed);
        }}
      >
        <label htmlFor={`${id}-text`} className="text-caption font-medium text-fg-muted">
          {t("spaces.comments.label")}
        </label>
        <Textarea
          id={`${id}-text`}
          value={text}
          maxLength={MAX_TEXT}
          rows={3}
          aria-describedby={`${id}-help`}
          onChange={(event) => setText(event.target.value)}
        />
        <p id={`${id}-help`} className="text-caption text-fg-muted">
          {t("spaces.comments.help")}
        </p>
        {post.isError ? (
          <Alert role="alert" tone="danger">
            {problem(post.error)}
          </Alert>
        ) : null}
        {remove.isError ? (
          <Alert role="alert" tone="danger">
            {problem(remove.error)}
          </Alert>
        ) : null}
        {unknown.length > 0 ? (
          <Alert role="status" tone="warning">
            {t("spaces.comments.unknown", { names: unknown.map((name) => `@${name}`).join(", ") })}
          </Alert>
        ) : null}
        <Button type="submit" className="w-fit" disabled={!trimmed || post.isPending}>
          {t("spaces.comments.post")}
        </Button>
      </form>
    </section>
  );
}

/**
 * The signed-in person's notifications in the header: the unread count on the button, the latest
 * in its menu; opening one marks it read and goes to its space.
 */
export function NotificationsMenu({ project, waiting = 0 }: { project: string; waiting?: number }): JSX.Element {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const inbox = useQuery({
    queryKey: NOTIFICATIONS_KEY,
    retry: false,
    // A mention is not urgent: a minute is soon enough, and the menu reads again when opened.
    refetchInterval: 60_000,
    queryFn: async () => (await unwrap(await api.GET("/api/v1/notifications", {}))) as Notifications,
  });
  const read = useMutation({
    mutationFn: async (id: number) => {
      await unwrap(await api.POST("/api/v1/notifications/{id}/read", { params: { path: { id } } }));
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    },
  });
  // What waits beside the mentions: the project's changes this person may decide (T-3273).
  const unread = (inbox.data?.unread ?? 0) + waiting;
  const items = inbox.data?.items ?? [];
  return (
    <Menu onOpenChange={(open) => (open ? void inbox.refetch() : undefined)}>
      <MenuTrigger asChild>
        <Button variant="ghost" className="relative px-1.5" aria-label={t("notifications.label", { count: unread })}>
          <Icon name="inbox" className="size-5" />
          {unread > 0 ? (
            <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-danger px-1 text-center text-caption font-bold text-danger-fg">
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </Button>
      </MenuTrigger>
      <MenuContent align="end" className="w-80 max-w-full">
        <MenuItem onSelect={() => void navigate({ to: "/projects/$project/inbox", params: { project } })}>
          <span className="font-semibold">{t("inbox.open", { count: unread })}</span>
        </MenuItem>
        <MenuLabel>{t("notifications.title")}</MenuLabel>
        {inbox.isError ? <p className="px-2.5 py-1.5 text-body text-danger">{problem(inbox.error)}</p> : null}
        {items.length === 0 && !inbox.isError ? <p className="px-2.5 py-1.5 text-body text-fg-muted">{t("notifications.none")}</p> : null}
        {items.map((item) => (
          <MenuItem
            key={item.id}
            className="flex-col items-start gap-0.5"
            onSelect={() => {
              if (!item.read) read.mutate(item.id);
              void navigate({ href: `/projects/${encodeURIComponent(item.project)}/spaces/${encodeURIComponent(item.space)}` });
            }}
          >
            <span className={item.read ? "text-fg-muted" : "font-semibold"}>
              {t("notifications.mentioned", { name: item.authorName, space: item.space })}
            </span>
            <span className="line-clamp-2 text-caption text-fg-muted [overflow-wrap:anywhere]">{item.excerpt}</span>
            <span className="text-caption text-fg-subtle">{when(item.createdAt, i18n.language)}</span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
