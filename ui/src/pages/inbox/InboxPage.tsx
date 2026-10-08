import { useId, useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, queryKeys, unwrap } from "../../api/client";
import type { components } from "../../api/schema";
import { useDecision, useDecisions } from "../../api/decision";
import { useProjects } from "../../api/projects";
import { PlanDiffViewer } from "../../components/diff/PlanDiffViewer";
import { LifecycleBadge } from "../../components/status/LifecycleBadge";
import { Alert, Button, Field, Input, PageHeader, Textarea } from "../../components/ui";
import { NOTIFICATIONS_KEY } from "../spaces/Comments";

type ChangeProposal = components["schemas"]["ChangeProposal"];

/** The name a Red-lane change asks to be typed back before it is approved (CC-19). */
function expectedName(change: ChangeProposal): string {
  return String((change.summary.params as Record<string, unknown>).name ?? change.metadata.name);
}

/** One change, decided where it is listed: its diff, Approve, and Reject with a reason. */
function Decision({ project, change }: { project: string; change: ChangeProposal }): JSX.Element {
  const { t } = useTranslation();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const decision = useDecision(project, change.metadata.name);
  const detail = useQuery({
    queryKey: queryKeys.change(project, change.metadata.name),
    enabled: open,
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/projects/{project}/changes/{id}", { params: { path: { project, id: change.metadata.name } } })),
  });
  const red = change.status.lane === "red";
  const name = expectedName(change);
  const decided = detail.data && detail.data.status.phase !== "PendingApproval";
  const summary = t(change.summary.key, change.summary.params as Record<string, unknown>);
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-body font-semibold text-fg">{summary}</span>
        <LifecycleBadge kind="lane" value={change.status.lane} />
        <span className="text-caption text-fg-muted">
          {t("inbox.by", { author: change.author.name, project })}
        </span>
        <Link
          to="/projects/$project/approvals/$id"
          params={{ project, id: change.metadata.name }}
          className="ml-auto text-caption text-primary-soft-fg underline-offset-2 hover:underline"
        >
          {t("inbox.openChange")}
        </Link>
      </div>
      <Button size="sm" variant="ghost" className="w-fit" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? t("inbox.hideDiff") : t("inbox.showDiff")}
      </Button>
      {open ? (
        detail.isPending ? (
          <p className="text-caption text-fg-muted">{t("app.loading")}</p>
        ) : detail.isError ? (
          <Alert role="alert" tone="danger">
            {t("inbox.diffFailed")}
          </Alert>
        ) : (
          <PlanDiffViewer fields={detail.data.planFields} />
        )
      ) : null}
      {decision.error ? (
        <Alert role="alert" tone="danger">
          {decision.error}
        </Alert>
      ) : null}
      {decided ? (
        <p role="status" className="text-body text-fg">
          {t(`inbox.decided.${detail.data?.status.phase === "Rejected" ? "rejected" : "approved"}`)}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {red ? (
            <Field id={`${ids}-confirm`} label={t("approvals.confirmPrompt")} description={name}>
              <Input id={`${ids}-confirm`} value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="off" />
            </Field>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={decision.approve.isPending}
              disabled={decision.pending || (red && confirm.trim() !== name)}
              disabledReason={red && confirm.trim() !== name ? t("approvals.confirmFirst", { name }) : undefined}
              onClick={() => {
                decision.approve.mutate(red ? confirm : undefined, { onSuccess: () => setOpen(true) });
              }}
            >
              {t("approvals.approve")}
            </Button>
            <Button size="sm" variant="secondary" disabled={decision.pending} onClick={() => setRejecting(!rejecting)}>
              {t("approvals.reject")}
            </Button>
          </div>
          {rejecting ? (
            <div className="flex flex-col gap-2">
              <Field id={`${ids}-reason`} label={t("approvals.rejectReason")} description={t("approvals.rejectReasonHint")}>
                <Textarea id={`${ids}-reason`} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
              </Field>
              <Button
                size="sm"
                variant="danger"
                className="w-fit"
                loading={decision.reject.isPending}
                disabled={decision.pending || reason.trim() === ""}
                disabledReason={reason.trim() === "" ? t("inbox.reasonFirst") : undefined}
                onClick={() => decision.reject.mutate(reason, { onSuccess: () => setOpen(true) })}
              >
                {t("approvals.rejectConfirm")}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </li>
  );
}

/** The changes one project holds for this person; nothing when there are none. */
function ProjectDecisions({ project }: { project: string }): JSX.Element | null {
  const changes = useDecisions(project);
  if (changes.length === 0) return null;
  return (
    <>
      {changes.map((change) => (
        <Decision key={`${project}/${change.metadata.name}`} project={project} change={change} />
      ))}
    </>
  );
}

interface Notification {
  id: number;
  read: boolean;
  project: string;
  space: string;
  authorName: string;
  excerpt: string;
}

/**
 * What waits for this person (T-3273): every change of every project they may decide, each
 * decided where it is listed with its diff, and the comments that mention them.
 */
export function InboxPage({ project }: { project: string }): JSX.Element {
  const { t } = useTranslation();
  const projects = useProjects();
  // The project in hand first, then every other the person reads.
  const order = [project, ...(projects.data ?? []).filter((name) => name !== project)];
  const mentions = useQuery({
    queryKey: NOTIFICATIONS_KEY,
    retry: false,
    queryFn: async () => (await unwrap(await api.GET("/api/v1/notifications", {}))) as { unread: number; items: Notification[] },
  });
  const unread = (mentions.data?.items ?? []).filter((item) => !item.read);
  return (
    <div className="space-y-6">
      <PageHeader title={t("inbox.title")} description={t("inbox.lead")} />
      <section aria-labelledby="inbox-decisions" className="space-y-3">
        <h2 id="inbox-decisions" className="text-title font-semibold text-fg">
          {t("inbox.decisions")}
        </h2>
        {/* Each project adds its own; an empty list says so with CSS rather than a count no
            component holds across projects. */}
        <ul className="peer flex flex-col gap-3 empty:hidden" data-testid="inbox-decisions">
          {order.map((name) => (
            <ProjectDecisions key={name} project={name} />
          ))}
        </ul>
        <p className="hidden text-body text-fg-muted peer-empty:block">{t("inbox.noDecisions")}</p>
        <p className="text-caption text-fg-muted">{t("inbox.decisionsHint")}</p>
      </section>
      <section aria-labelledby="inbox-mentions" className="space-y-3">
        <h2 id="inbox-mentions" className="text-title font-semibold text-fg">
          {t("inbox.mentions")}
        </h2>
        {unread.length === 0 ? (
          <p className="text-body text-fg-muted">{t("inbox.noMentions")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {unread.map((item) => (
              <li key={item.id} className="rounded-md border border-border p-2">
                <Link
                  to="/projects/$project/$plural/$name"
                  params={{ project: item.project, plural: "spaces", name: item.space }}
                  className="text-body font-semibold text-primary-soft-fg underline-offset-2 hover:underline"
                >
                  {t("notifications.mentioned", { name: item.authorName, space: item.space })}
                </Link>
                <p className="line-clamp-2 text-caption text-fg-muted [overflow-wrap:anywhere]">{item.excerpt}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
