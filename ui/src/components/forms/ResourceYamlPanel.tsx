import { Suspense, lazy } from "react";
import type { JSX, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, FilePicker, tabPanelProps } from "../ui";
import type { YamlEditor } from "./useYamlEditor";

// Monaco is loaded when the YAML view is opened and not before: it is the heaviest thing in
// the Portal and a dialog that never shows its manifest would otherwise pay for it.
const MonacoSourceView = lazy(() => import("../../pages/models/MonacoSourceView"));

export interface ResourceYamlPanelProps<T> {
  editor: YamlEditor<T>;
  /** The tab set the panel belongs to. */
  viewsId: string;
  disabled: boolean;
  /** The file name a download is saved under, without `.yaml`. */
  downloadName: string;
  /** The footer under the editor: Cancel, Check, the verdict and the submit. */
  footer: ReactNode;
}

/** The YAML view of a manifest dialog: the editor, its file in and out, and what it answered. */
export function ResourceYamlPanel<T>({ editor, viewsId, disabled, downloadName, footer }: ResourceYamlPanelProps<T>): JSX.Element {
  const { t } = useTranslation();
  return (
    <div {...tabPanelProps(viewsId, "yaml")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption text-fg-muted">{t("form.yamlHint")}</p>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" data-testid="yaml-download" onClick={() => editor.download(downloadName)}>
            {t("form.yamlDownload")}
          </Button>
          {disabled ? null : (
            <FilePicker
              label={t("form.yamlUpload")}
              accept=".yaml,.yml,application/yaml,text/yaml"
              onFile={(file) => void editor.upload(file)}
              className="text-body"
            >
              <span className="rounded-md border border-border px-3 py-1 text-caption">{t("form.yamlUpload")}</span>
            </FilePicker>
          )}
        </div>
      </div>
      {editor.uploadNote ? (
        <p role="status" data-testid="yaml-upload-note" className="text-caption text-fg-muted">
          {editor.uploadNote}
        </p>
      ) : null}
      <div className="overflow-hidden rounded-md border border-border">
        <Suspense fallback={<p className="p-3 text-body">{t("models.loadingEditor")}</p>}>
          <MonacoSourceView value={editor.text} onChange={editor.setText} onMount={() => undefined} height="24rem" />
        </Suspense>
      </div>
      {/* What the YAML answered, right above the button that asked it (T-1395). */}
      {editor.error ? (
        <Alert role="alert" tone="danger">
          {editor.error}
        </Alert>
      ) : null}
      {editor.issues.length > 0 ? (
        <Alert role="alert" tone="danger">
          <p>{t("form.schemaErrors")}</p>
          <ul className="mt-1 list-disc pl-5">
            {editor.issues.map((issue) => (
              <li key={issue} className="font-mono text-caption">
                {issue}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {footer}
    </div>
  );
}
