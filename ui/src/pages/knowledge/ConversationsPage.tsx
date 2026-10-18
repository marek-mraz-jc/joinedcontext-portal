import { useState } from "react";
import type { JSX } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../../api/permissions";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  PageFailed,
  PageHeader,
  Select,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../components/ui";
import { reasonOf } from "./KnowledgePage";
import { timeText } from "./knowledge";
import {
  conversationKeys,
  eraseConversation,
  evalCase,
  getConversation,
  listConversations,
  msText,
  usdText,
} from "./conversations";
import type { ConversationFilter, ConversationStep, ConversationTurn } from "./conversations";

/**
 * Asistent → Konverzácie (API/01 §34, T-4670): the project's stored assistant conversations,
 * redacted, for its administrator (`approve` on AssistantDeployment); every read is recorded.
 * One conversation opens as its turns, each with the steps that made the answer.
 */
export function ConversationsPage({ project }: { project: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const { data: permissions, can } = usePermissions(project);
  const [filter, setFilter] = useState<ConversationFilter>({});
  const [open, setOpen] = useState<string | null>(null);
  const allowed = can("AssistantDeployment", "approve");
  const list = useQuery({
    queryKey: conversationKeys.list(project, filter),
    queryFn: () => listConversations(project, filter),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  const set = (change: ConversationFilter) => {
    setFilter((now) => ({ ...now, ...change, cursor: undefined }));
  };

  if (permissions !== undefined && !allowed) {
    return (
      <section aria-label={t("conversations.title")} className="space-y-6">
        <PageHeader title={t("conversations.title")} />
        <Alert tone="info">{t("conversations.notAllowed")}</Alert>
      </section>
    );
  }
  const items = list.data?.items ?? [];
  return (
    <section aria-label={t("conversations.title")} className="space-y-6">
      <PageHeader title={t("conversations.title")} description={t("conversations.intro")} />
      <div className="flex flex-wrap items-end gap-3">
        <Field id="conv-q" label={t("conversations.filter.q")} className="w-64">
          <Input id="conv-q" type="search" value={filter.q ?? ""} onChange={(e) => set({ q: e.target.value })} />
        </Field>
        <Field id="conv-status" label={t("conversations.filter.status")} className="w-44">
          <Select
            id="conv-status"
            value={filter.status ?? ""}
            onChange={(e) => set({ status: (e.target.value || undefined) as ConversationFilter["status"] })}
          >
            <option value="">{t("conversations.filter.all")}</option>
            <option value="ok">{t("conversations.status.ok")}</option>
            <option value="error">{t("conversations.status.error")}</option>
            <option value="timeout">{t("conversations.status.timeout")}</option>
          </Select>
        </Field>
        <Field id="conv-feedback" label={t("conversations.filter.feedback")} className="w-44">
          <Select
            id="conv-feedback"
            value={filter.feedback ?? ""}
            onChange={(e) => set({ feedback: (e.target.value || undefined) as ConversationFilter["feedback"] })}
          >
            <option value="">{t("conversations.filter.all")}</option>
            <option value="up">{t("conversations.feedback.up")}</option>
            <option value="down">{t("conversations.feedback.down")}</option>
            <option value="none">{t("conversations.feedback.none")}</option>
          </Select>
        </Field>
        <Field id="conv-sort" label={t("conversations.filter.sort")} className="w-44">
          <Select
            id="conv-sort"
            value={filter.sort ?? "lastAt"}
            onChange={(e) => set({ sort: e.target.value as ConversationFilter["sort"] })}
          >
            <option value="lastAt">{t("conversations.sort.lastAt")}</option>
            <option value="costUsd">{t("conversations.sort.costUsd")}</option>
          </Select>
        </Field>
        <Field id="conv-deployment" label={t("conversations.filter.deployment")} className="w-44">
          <Input
            id="conv-deployment"
            value={filter.deployment ?? ""}
            onChange={(e) => set({ deployment: e.target.value })}
          />
        </Field>
        <Field id="conv-from" label={t("conversations.filter.from")} className="w-44">
          <Input id="conv-from" type="date" value={filter.from ?? ""} onChange={(e) => set({ from: e.target.value })} />
        </Field>
        <Field id="conv-to" label={t("conversations.filter.to")} className="w-44">
          <Input id="conv-to" type="date" value={filter.to ?? ""} onChange={(e) => set({ to: e.target.value })} />
        </Field>
        <Switch
          checked={Boolean(filter.slow)}
          onCheckedChange={(slow) => set({ slow })}
          label={t("conversations.filter.slow")}
          className="mb-2"
        />
        <Switch
          checked={Boolean(filter.expensive)}
          onCheckedChange={(expensive) => set({ expensive })}
          label={t("conversations.filter.expensive")}
          className="mb-2"
        />
      </div>
      {list.isError ? (
        <PageFailed error={list.error} onRetry={() => void list.refetch()}>
          {reasonOf(list.error, t("app.error.generic"))}
        </PageFailed>
      ) : null}
      {list.isLoading ? <p role="status">{t("app.loading")}</p> : null}
      {list.isSuccess && items.length === 0 ? (
        <EmptyState title={t("conversations.empty")} description={t("conversations.emptyHint")} icon="search" />
      ) : null}
      {items.length > 0 ? (
        <Table caption={t("conversations.title")}>
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t("conversations.column.lastAt")}</TableHeaderCell>
              <TableHeaderCell>{t("conversations.column.question")}</TableHeaderCell>
              <TableHeaderCell>{t("conversations.column.turns")}</TableHeaderCell>
              <TableHeaderCell>{t("conversations.column.route")}</TableHeaderCell>
              <TableHeaderCell>{t("conversations.column.slowest")}</TableHeaderCell>
              <TableHeaderCell>{t("conversations.column.cost")}</TableHeaderCell>
              <TableHeaderCell>{t("conversations.column.status")}</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{timeText(row.lastAt, i18n.language)}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" className="h-auto text-left underline" onClick={() => setOpen(row.id)}>
                    {row.firstQuestion}
                  </Button>
                  <div className="text-caption text-fg-muted">{row.deployment}</div>
                </TableCell>
                <TableCell>{row.turns}</TableCell>
                <TableCell>{row.routes.join(", ")}</TableCell>
                <TableCell>{msText(row.totalMs)}</TableCell>
                <TableCell>
                  {usdText(row.costUsd)}
                  {row.uncosted > 0 ? (
                    <span className="text-caption text-fg-muted"> {t("conversations.uncosted", { count: row.uncosted })}</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  {row.timeouts > 0 ? <Badge tone="warning">{t("conversations.status.timeout")}</Badge> : null}
                  {row.errors > 0 ? <Badge tone="danger">{t("conversations.status.error")}</Badge> : null}
                  {row.thumbsDown > 0 ? <Badge tone="danger">{t("conversations.feedback.down")}</Badge> : null}
                  {row.thumbsUp > 0 ? <Badge tone="success">{t("conversations.feedback.up")}</Badge> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      {list.data?.nextCursor ? (
        <Button onClick={() => setFilter((now) => ({ ...now, cursor: list.data?.nextCursor ?? undefined }))}>
          {t("conversations.next")}
        </Button>
      ) : null}
      {open ? (
        <ConversationDetail project={project} id={open} mayErase={can("AssistantDeployment", "delete")} onGone={() => setOpen(null)} />
      ) : null}
    </section>
  );
}

function ConversationDetail({
  project,
  id,
  mayErase,
  onGone,
}: {
  project: string;
  id: string;
  mayErase: boolean;
  onGone: () => void;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const one = useQuery({ queryKey: conversationKeys.one(project, id), queryFn: () => getConversation(project, id) });
  const erase = useMutation({
    mutationFn: () => eraseConversation(project, id),
    onSuccess: () => {
      setConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ["projects", project, "knowledge", "conversations"] });
      onGone();
    },
  });
  const copy = (turn: ConversationTurn) => {
    void navigator.clipboard
      .writeText(evalCase(turn, i18n.language))
      .then(() => setCopied(turn.turn))
      .catch(() => setCopied(null));
  };
  return (
    <Card aria-label={t("conversations.detail")}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-title">{t("conversations.detail")}</h2>
        {mayErase ? (
          <Button variant="danger" onClick={() => setConfirm(true)}>
            {t("conversations.erase")}
          </Button>
        ) : null}
      </div>
      {one.isError ? <Alert tone="danger">{reasonOf(one.error, t("app.error.generic"))}</Alert> : null}
      {one.isLoading ? <p role="status">{t("app.loading")}</p> : null}
      {copied !== null ? <Alert role="status" tone="success">{t("conversations.copied")}</Alert> : null}
      <ol className="space-y-6">
        {(one.data?.turns ?? []).map((turn) => (
          <li key={turn.turn} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-caption text-fg-muted">
              <span>{timeText(turn.at, i18n.language)}</span>
              <Badge tone="neutral">{turn.route}</Badge>
              <span>{t("conversations.timing", { first: msText(turn.firstTokenMs), total: msText(turn.totalMs) })}</span>
              <span>{usdText(turn.costUsd)}</span>
              {turn.timedOut ? <Badge tone="warning">{t("conversations.status.timeout")}</Badge> : null}
              {turn.verdict === "down" ? <Badge tone="danger">{t("conversations.feedback.down")}</Badge> : null}
              {turn.verdict === "up" ? <Badge tone="success">{t("conversations.feedback.up")}</Badge> : null}
              <Button size="sm" onClick={() => copy(turn)}>
                {t("conversations.copyAsTest")}
              </Button>
            </div>
            <p className="font-semibold">{turn.question}</p>
            <p className="whitespace-pre-wrap">{turn.answer}</p>
            {turn.error ? <Alert tone="danger">{turn.error.detail ?? turn.error.title}</Alert> : null}
            <Steps steps={turn.steps} />
          </li>
        ))}
      </ol>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("conversations.eraseTitle")}
        description={t("conversations.eraseHint")}
        confirmLabel={t("conversations.erase")}
        tone="danger"
        pending={erase.isPending}
        onConfirm={() => erase.mutate()}
      >
        {erase.isError ? <Alert tone="danger">{reasonOf(erase.error, t("app.error.generic"))}</Alert> : null}
      </ConfirmDialog>
    </Card>
  );
}

/** The steps of one turn as a timeline: when each started, what it was, and what it cost. */
function Steps({ steps }: { steps: ConversationStep[] }): JSX.Element | null {
  const { t } = useTranslation();
  if (steps.length === 0) return null;
  return (
    <ol aria-label={t("conversations.steps")} className="space-y-1 border-l border-border pl-3 text-caption">
      {steps.map((step, i) => (
        <li key={i}>
          <details>
            <summary className="cursor-pointer">
              <span className="tabular-nums text-fg-muted">+{msText(step.startMs)}</span>{" "}
              <strong>{t(`conversations.kind.${step.kind}`)}</strong> {step.model ?? step.name}
              {step.endpoint ? ` · ${step.endpoint}` : ""} · {msText(step.durationMs)}
              {step.tokensIn !== null ? ` · ${step.tokensIn}/${step.tokensOut ?? 0} tok` : ""}
              {step.kind === "model" ? ` · ${step.costUsd === null ? t("conversations.unknownPrice") : usdText(step.costUsd)}` : ""}
              {step.status === "failed" ? <Badge tone="danger">{t("conversations.failed")}</Badge> : null}
            </summary>
            {step.input ? <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap bg-surface-subtle p-2">{step.input}</pre> : null}
            {step.output ? <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap bg-surface-subtle p-2">{step.output}</pre> : null}
            {step.error ? <p className="text-danger">{step.error}</p> : null}
          </details>
        </li>
      ))}
    </ol>
  );
}
