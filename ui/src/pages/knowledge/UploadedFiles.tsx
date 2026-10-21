import { PageFailed } from "../../components/ui/PageState";
import { useState } from "react";
import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Badge,
  Button,
  buttonClass,
  EmptyState,
  FilePicker,
  PermissionGuard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../components/ui";
import { ApiError } from "../../api/client";
import { usePermissions } from "../../api/permissions";
import { reasonOf } from "./KnowledgePage";
import { bytesText, knowledgeKeys, listFiles, removeFile, UPLOAD_ACCEPT, uploadFile } from "./knowledge";
import type { UploadedFile } from "./knowledge";

/** The assistant has not taken the approved source up yet: it answers 404 for about a minute (T-4869). */
function notTakenUp(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * The files of a `source: upload` (T-4185, API/05 §3): uploaded one request each, read into
 * passages at once, and removed with their passages.
 */
export function UploadedFiles({ project, source }: { project: string; source: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const mayPropose = usePermissions(project).can("KnowledgeSource", "propose");
  const [added, setAdded] = useState<UploadedFile[]>([]);
  const files = useQuery({
    queryKey: knowledgeKeys.files(project, source),
    queryFn: () => listFiles(project, source),
    // Asked again until the assistant takes the source up, so the page turns ready by itself.
    refetchInterval: (query) => (notTakenUp(query.state.error) ? 10_000 : false),
  });
  const waiting = files.isError && notTakenUp(files.error);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["projects", project, "knowledge"] });
  // One file after another: each is a request of its own, and a refusal names its file.
  const upload = useMutation({
    mutationFn: async (chosen: File[]) => {
      const done: UploadedFile[] = [];
      for (const file of chosen) {
        try {
          done.push(await uploadFile(project, source, file, file.name));
        } catch (error) {
          setAdded(done);
          if (notTakenUp(error)) throw new Error(t("knowledge.files.notTakenUp"));
          throw new Error(t("knowledge.files.failed", { name: file.name, reason: reasonOf(error, t("app.error.generic")) }));
        }
      }
      return done;
    },
    onMutate: () => setAdded([]),
    onSuccess: setAdded,
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (file: UploadedFile) => removeFile(project, source, file.id),
    onSuccess: refresh,
  });

  const rows = files.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {mayPropose && !upload.isPending && !waiting ? (
          <FilePicker label={t("knowledge.files.choose")} accept={UPLOAD_ACCEPT} multiple onFiles={(chosen) => upload.mutate(chosen)}>
            <span className={buttonClass("primary")}>{t("knowledge.files.upload")}</span>
          </FilePicker>
        ) : (
          // Without `propose`, or while files are sent: the button says why it does nothing.
          <PermissionGuard project={project} kind="KnowledgeSource" verb="propose">
            <Button variant="primary" disabled disabledReason={t(waiting ? "knowledge.files.notTakenUp" : "knowledge.files.uploading")}>
              {t(upload.isPending ? "knowledge.files.uploading" : "knowledge.files.upload")}
            </Button>
          </PermissionGuard>
        )}
        <span className="text-caption text-fg-muted">{t("knowledge.files.accepts")}</span>
      </div>
      {upload.isError ? (
        <Alert role="alert" tone="danger">
          {upload.error.message}
        </Alert>
      ) : null}
      {remove.isError ? (
        <Alert role="alert" tone="danger">
          {reasonOf(remove.error, t("app.error.generic"))}
        </Alert>
      ) : null}
      {added.length > 0 ? (
        <Alert role="status" tone="success">
          {t("knowledge.files.added", {
            count: added.length,
            passages: added.reduce((sum, file) => sum + file.passages, 0),
          })}
        </Alert>
      ) : null}
      {files.isLoading ? (
        <p role="status">{t("app.loading")}</p>
      ) : waiting ? (
        <Alert role="status" tone="info">
          {t("knowledge.files.notTakenUp")}
        </Alert>
      ) : files.isError ? (
        <PageFailed error={files.error} onRetry={() => void files.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("knowledge.files.none")} description={t("knowledge.files.noneHint")} icon="search" />
      ) : (
        <Table data-records="" caption={t("knowledge.files.title")}>
          <TableHead>
            <TableHeaderCell>{t("knowledge.files.name")}</TableHeaderCell>
            <TableHeaderCell align="right" secondary>{t("knowledge.column.size")}</TableHeaderCell>
            <TableHeaderCell>{t("knowledge.column.state")}</TableHeaderCell>
            <TableHeaderCell align="right" secondary>{t("knowledge.column.passages")}</TableHeaderCell>
            <TableHeaderCell align="right">
              <span className="sr-only">{t("approvals.actions")}</span>
            </TableHeaderCell>
          </TableHead>
          <TableBody>
            {rows.map((file) => (
              <TableRow key={file.id}>
                <TableCell>
                  <span className="font-mono [overflow-wrap:anywhere]">{file.name}</span>
                </TableCell>
                <TableCell align="right" secondary>{bytesText(file.bytes, i18n.language)}</TableCell>
                <TableCell>
                  <Badge tone={file.status === "failed" ? "danger" : file.status === "fetched" ? "success" : "neutral"}>
                    {t(`knowledge.status.${file.status}`)}
                  </Badge>
                </TableCell>
                <TableCell align="right" secondary>{file.passages}</TableCell>
                <TableCell align="right">
                  <PermissionGuard project={project} kind="KnowledgeSource" verb="propose">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("knowledge.files.removeOf", { name: file.name })}
                      disabled={remove.isPending}
                      disabledReason={t("knowledge.source.sending")}
                      onClick={() => remove.mutate(file)}
                    >
                      {t("knowledge.files.remove")}
                    </Button>
                  </PermissionGuard>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
