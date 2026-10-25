import { useState } from "react";
import { useTranslation } from "react-i18next";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { pastedSecrets } from "../../api/pastedSecrets";
import type { ManifestSource } from "./types";

export interface YamlEditor<T> {
  text: string;
  setText: (text: string) => void;
  error: string | null;
  issues: string[];
  setIssues: (issues: string[]) => void;
  uploadNote: string | null;
  /** The form the YAML describes, or `null` with the reason on screen. */
  read: () => T | null;
  /** The YAML view opens on the manifest the form holds. */
  showForm: (form: T) => void;
  upload: (file: File) => Promise<void>;
  /** The manifest the YAML view holds, saved as a file (T-3977): references, never values. */
  download: (name: string) => void;
  /** A dialog closed: what the YAML last answered goes with it. */
  reset: () => void;
}

/** The YAML view's text and what reading it answered, for a dialog with a `source`. */
export function useYamlEditor<T>(
  source: ManifestSource<T> | undefined,
  project: string | undefined,
  onChange: ((data: T | undefined) => void) | undefined,
): YamlEditor<T> {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const failed = (err: unknown) =>
    setError(t("form.yamlError", { message: err instanceof Error ? err.message : String(err) }));

  function read(): T | null {
    if (!source) {
      return null;
    }
    try {
      const document: unknown = parseYaml(text);
      if (!document || typeof document !== "object") {
        throw new Error(t("form.yamlNotManifest"));
      }
      setError(null);
      return source.fromManifest(document);
    } catch (err) {
      failed(err);
      return null;
    }
  }

  /**
   * A manifest file read into the YAML view and the form (T-3977). A literal secret is refused
   * before anything is shown; a manifest of another project is moved into this one, said on
   * screen. The form then holds a document no verdict covers, so it is proposed only once
   * Check is green again.
   */
  async function upload(file: File) {
    const content = await file.text();
    setUploadNote(null);
    const secrets = pastedSecrets(content);
    if (secrets.length > 0) {
      setError(t("form.yamlUploadSecret", { keys: secrets.join(", ") }));
      return;
    }
    let document: unknown;
    try {
      document = parseYaml(content);
    } catch (err) {
      failed(err);
      return;
    }
    if (!document || typeof document !== "object" || !source) {
      failed(new Error(t("form.yamlNotManifest")));
      return;
    }
    const metadata = (document as { metadata?: { namespace?: unknown } }).metadata;
    if (project && metadata && typeof metadata.namespace === "string" && metadata.namespace !== project) {
      setUploadNote(t("form.yamlUploadMoved", { from: metadata.namespace, to: project }));
      metadata.namespace = project;
    }
    setText(stringifyYaml(document));
    setError(null);
    setIssues([]);
    onChange?.(source.fromManifest(document));
  }

  function download(name: string) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/yaml" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}.yaml`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return {
    text,
    setText: (next) => {
      setText(next);
      setError(null);
    },
    error,
    issues,
    setIssues,
    uploadNote,
    read,
    showForm: (form) => {
      if (!source) return;
      setText(stringifyYaml(source.toManifest(form)));
      setError(null);
    },
    upload,
    download,
    reset: () => {
      setError(null);
      setIssues([]);
    },
  };
}
