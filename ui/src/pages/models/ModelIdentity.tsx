import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isMap, isScalar, type Document } from "yaml";
import { Button, Field, Icon, Input } from "../../components/ui";

/**
 * The name line under the editor's title (T-6162, owner review v2): the model's name, which a
 * pencil renames, then its id and file name, both locked. A rename writes the LinkML `title`
 * and nothing else, so the manifest name, the file path and every reference stay as they are.
 */
export interface ModelIdentityProps {
  /** What people read: the model's English title, or the name typed for a new model. */
  name: string;
  /** The manifest name; undefined while a new model has no name to derive it from. */
  id: string | undefined;
  /** A new model: its id still follows the name, until the first save fixes it. */
  creating: boolean;
  /** The published version this edit started from. */
  version?: string;
  readOnly?: boolean;
  onRename: (name: string) => void;
}

export function ModelIdentity({ name, id, creating, version, readOnly, onRename }: ModelIdentityProps): React.JSX.Element {
  const { t } = useTranslation();
  const inputId = useId();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [empty, setEmpty] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // The pencil the person pressed is gone: the field it opened takes the focus in its place.
  const renaming = draft !== undefined;
  useEffect(() => {
    if (renaming) field.current?.focus();
  }, [renaming]);

  const commit = () => {
    const value = (draft ?? "").trim();
    if (value === "") {
      setEmpty(true);
      field.current?.focus();
      return;
    }
    onRename(value);
    setDraft(undefined);
    setEmpty(false);
  };

  return (
    <div className="mt-2 flex flex-col gap-1 text-body">
      {creating && !readOnly ? (
        // A new model is named as it is typed: the id below follows, and Save waits for it.
        <Field id={inputId} label={t("models.identity.name")} help={t("models.identity.nameHintNew")}>
          <Input
            id={inputId}
            className="w-64 max-w-full"
            value={name}
            onChange={(event) => onRename(event.target.value)}
          />
        </Field>
      ) : draft === undefined ? (
        <span className="flex items-center gap-1">
          {/* A model without a title says so, rather than repeating its id (T-6162 judge). */}
          <span className={name ? "text-heading font-semibold" : "text-heading text-fg-muted"}>
            {name || t("models.identity.unnamed")}
          </span>
          {readOnly ? null : (
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("models.identity.rename", { name: name || t("models.identity.unnamed") })}
              onClick={() => setDraft(name)}
            >
              <Icon name="pencil" className="size-4" />
              <span aria-hidden>{t("models.identity.renameShort")}</span>
            </Button>
          )}
        </span>
      ) : (
        <form
          className="flex flex-wrap items-start gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            commit();
          }}
        >
          <Field
            id={inputId}
            label={t("models.identity.name")}
            help={t("models.identity.nameHint")}
            errors={empty ? [t("models.identity.nameEmpty")] : undefined}
          >
            <Input
              id={inputId}
              className="w-64 max-w-full"
              ref={field}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setEmpty(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setDraft(undefined);
                }
              }}
            />
          </Field>
          <div className="flex gap-2 sm:mt-6">
            <Button size="sm" type="submit" variant="primary">
              {t("models.identity.done")}
            </Button>
            <Button size="sm" onClick={() => setDraft(undefined)}>
              {t("app.cancel")}
            </Button>
          </div>
        </form>
      )}
      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-fg-muted">
        <div className="flex items-center gap-1" title={t(creating ? "models.identity.idNew" : "models.identity.idFixed")}>
          <Icon name="lock" className="size-3.5" />
          <dt>{t("models.identity.id")}</dt>
          <dd className="font-mono text-fg">{id ?? t("models.identity.noId")}</dd>
        </div>
        {id ? (
          <div className="flex items-center gap-1" title={t("models.identity.fileFixed")}>
            <Icon name="lock" className="size-3.5" />
            <dt>{t("models.identity.file")}</dt>
            <dd className="font-mono text-fg">{id}.linkml.yaml</dd>
          </div>
        ) : null}
        {version ? (
          <div className="flex items-center gap-1">
            <dt>{t("models.identity.version")}</dt>
            <dd className="font-mono text-fg">{version}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

/** The model's English title in a LinkML document: a language map keeps its other languages. */
export function setModelTitle(document: Document, name: string): void {
  const title = document.get("title", true);
  if (isMap(title)) {
    document.setIn(["title", "en"], name);
  } else if (isScalar(title) || title === undefined) {
    document.set("title", document.createNode({ en: name }));
  }
}
