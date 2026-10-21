import { useState } from "react";
import type { JSX } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, unwrap } from "../../api/client";
import { Alert, Button, ConfirmDialog, Field, Input, PermissionGuard } from "../../components/ui";

/** The server's limits (src/erasure.rs MAX_SUBJECT, MAX_REASON). */
const MAX_SUBJECT = 256;
const MAX_REASON = 500;

interface Preview {
  entities: number;
  groups: { class: string; entities: string[]; attrs?: string[] | null }[];
}

interface Erasure {
  id: string;
  state: "open" | "done" | "failed";
  requestedAt: string;
  completedAt?: string | null;
  entities: number;
  stores: Record<string, { state: string; count: number; versions?: number; error?: string }>;
}

/** What the server would refuse about the subject (erasure::subject_refusal); `null` when fine. */
function subjectProblem(subject: string): "required" | "tooLong" | "characters" | null {
  const trimmed = subject.trim();
  if (trimmed === "") return "required";
  if ([...trimmed].length > MAX_SUBJECT) return "tooLong";
  // The server refuses quotes, backslashes and control characters (erasure::subject_refusal).
  return [...trimmed].some((c) => c === '"' || c === "\\" || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    ? "characters"
    : null;
}

function reasonProblem(reason: string): "required" | "tooLong" | null {
  const trimmed = reason.trim();
  if (trimmed === "") return "required";
  return [...trimmed].length > MAX_REASON ? "tooLong" : null;
}

/**
 * A data subject's rights in a space (DM-124, DM-126, DM-127, API/01 §46): an owner of the space
 * exports what the space holds about one person, or erases it after a preview of what goes. The
 * person's value travels in the request body only; every call is audited with its reason. Others
 * see the section and why its buttons are off, and the server refuses them again.
 */
export function SpacePersonalData({ project, space }: { project: string; space: string }): JSX.Element {
  const { t } = useTranslation();
  const [subject, setSubject] = useState("");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [exported, setExported] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [erasureId, setErasureId] = useState<string | null>(null);

  const path = { project, space };
  const body = () => ({ subject: subject.trim(), reason: reason.trim() });
  const said = (error: unknown) =>
    error instanceof ApiError ? (error.problem?.detail ?? error.message) : String(error);
  const subjectError = touched ? subjectProblem(subject) : null;
  const reasonError = touched ? reasonProblem(reason) : null;

  /** Runs `then` when both fields hold what the server accepts; marks them otherwise. */
  const valid = (then: () => void) => {
    setTouched(true);
    setProblem(null);
    setExported(null);
    if (subjectProblem(subject) === null && reasonProblem(reason) === null) then();
  };

  const exportRecords = useMutation({
    mutationFn: async () =>
      (await unwrap(
        await api.POST("/api/v1/projects/{project}/spaces/{space}/subjects/export", {
          params: { path },
          body: body(),
        }),
      )) as { entities?: unknown[] },
    onSuccess: (answer) => {
      // The file exists only in this browser: the Portal keeps no export (DM-126).
      const url = URL.createObjectURL(new Blob([JSON.stringify(answer, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `personal-data-${space}-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setExported(answer.entities?.length ?? 0);
    },
    onError: (error) => setProblem(said(error)),
  });

  const dryRun = useMutation({
    mutationFn: async () =>
      (await unwrap(
        await api.POST("/api/v1/projects/{project}/spaces/{space}/erasures", {
          params: { path, query: { dryRun: "All" } },
          body: body(),
        }),
      )) as Preview,
    onSuccess: setPreview,
    onError: (error) => setProblem(said(error)),
  });

  const erase = useMutation({
    mutationFn: async () =>
      (await unwrap(
        await api.POST("/api/v1/projects/{project}/spaces/{space}/erasures", {
          params: { path },
          body: body(),
        }),
      )) as Erasure,
    onSuccess: (started) => {
      setPreview(null);
      setErasureId(started.id);
      // The value leaves the page once it is erased: nothing keeps it on screen.
      setSubject("");
      setTouched(false);
    },
    onError: (error) => {
      setPreview(null);
      setProblem(said(error));
    },
  });

  // An erasure stays open until every store reports done (API/01 §46): asked again while open.
  const erasure = useQuery({
    queryKey: ["projects", project, "spaces", space, "erasures", erasureId],
    enabled: erasureId !== null,
    retry: false,
    refetchInterval: (query) => (query.state.data?.state === "open" ? 5_000 : false),
    queryFn: async () =>
      (await unwrap(
        await api.GET("/api/v1/projects/{project}/spaces/{space}/erasures/{id}", {
          params: { path: { project, space, id: erasureId ?? "" } },
        }),
      )) as Erasure,
  });
  const shown = erasure.data ?? (erase.data?.id === erasureId ? erase.data : undefined);

  return (
    <div className="space-y-4">
      <p className="text-body text-fg-muted">{t("spaces.personal.lead")}</p>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id="personal-subject"
          label={t("spaces.personal.subject")}
          required
          help={t("spaces.personal.hint.subject")}
          errors={subjectError ? [t(`spaces.personal.subjectError.${subjectError}`, { max: MAX_SUBJECT })] : undefined}
        >
          <Input
            id="personal-subject"
            value={subject}
            autoComplete="off"
            maxLength={MAX_SUBJECT}
            onChange={(event) => setSubject(event.target.value)}
          />
        </Field>
        <Field
          id="personal-reason"
          label={t("spaces.personal.reason")}
          required
          help={t("spaces.personal.hint.reason")}
          errors={reasonError ? [t(`spaces.personal.reasonError.${reasonError}`, { max: MAX_REASON })] : undefined}
        >
          <Input
            id="personal-reason"
            value={reason}
            maxLength={MAX_REASON}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </div>
      <span className="flex flex-wrap gap-2">
        <PermissionGuard project={project} kind="ContextSpace" verb="approve">
          <Button
            variant="secondary"
            loading={exportRecords.isPending}
            onClick={() => valid(() => exportRecords.mutate())}
          >
            {t("spaces.personal.export")}
          </Button>
        </PermissionGuard>
        <PermissionGuard project={project} kind="ContextSpace" verb="approve">
          <Button variant="danger" loading={dryRun.isPending} onClick={() => valid(() => dryRun.mutate())}>
            {t("spaces.personal.erase")}
          </Button>
        </PermissionGuard>
      </span>
      {problem !== null && <Alert tone="danger">{problem}</Alert>}
      {exported !== null && (
        <Alert tone="success">{t("spaces.personal.exported", { count: exported })}</Alert>
      )}
      {shown !== undefined && (
        <Alert tone={shown.state === "failed" ? "danger" : shown.state === "done" ? "success" : "info"}>
          <p>{t(`spaces.personal.state.${shown.state}`, { id: shown.id, count: shown.entities })}</p>
          <ul className="mt-2 list-disc pl-5">
            {Object.entries(shown.stores).map(([store, held]) => (
              <li key={store}>
                {t("spaces.personal.store", {
                  store: t(`spaces.personal.stores.${store}`, { defaultValue: store }),
                  state: t(`spaces.personal.storeState.${held.state}`, { defaultValue: held.state }),
                  count: held.count,
                })}
                {held.error ? ` ${held.error}` : ""}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {erasure.isError && <Alert tone="danger">{said(erasure.error)}</Alert>}
      <ConfirmDialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        title={t("spaces.personal.confirmTitle", { space })}
        description={t("spaces.personal.confirmLead")}
        confirmLabel={t("spaces.personal.confirm")}
        pending={erase.isPending}
        onConfirm={() => erase.mutate()}
      >
        {preview !== null && preview.entities === 0 ? (
          <p className="text-body">{t("spaces.personal.nothing")}</p>
        ) : (
          <ul className="list-disc pl-5 text-body">
            {(preview?.groups ?? []).map((group) => (
              <li key={group.class}>
                {group.attrs
                  ? t("spaces.personal.wouldErase.attrs", {
                      count: group.entities.length,
                      type: group.class,
                      attrs: group.attrs.join(", "),
                    })
                  : t("spaces.personal.wouldErase.entity", { count: group.entities.length, type: group.class })}
              </li>
            ))}
          </ul>
        )}
      </ConfirmDialog>
    </div>
  );
}
