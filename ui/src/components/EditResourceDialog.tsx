import { Suspense, lazy, useState } from "react";
import { PermissionGuard } from "./ui/PermissionGuard";
import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { api, ApiError, queryKeys, unwrap } from "../api/client";
import { proposeChecked } from "../api/proposal";
import { isChange } from "../api/manifest";
import type { Change } from "../api/manifest";
import { usePermissions } from "../api/permissions";
import { takeEditRequest } from "../assistant/state";
import { ChangeNotice } from "./ChangeNotice";
import { SchemaForm } from "./forms/SchemaForm";
import type { JsonSchema, UiSchema } from "./forms/types";
import type { ResourceTarget } from "./DeleteResourceDialog";
import { Alert, Button, PageFailed, PageLoading } from "./ui";
import { FormFrame, useFormRoute } from "./forms/FormRoute";

const MonacoSourceView = lazy(() => import("../pages/models/MonacoSourceView"));

/** The manifest as it is written: status is the Portal's to compute and never goes back (MF-04). */
function writable(manifest: Record<string, unknown>): string {
  const rest = { ...manifest };
  delete rest.status;
  return stringifyYaml(rest);
}

/**
 * The kind's own form, for editing a resource whose page already has one (T-2278, UI-61).
 *
 * Without this the Edit action opened the manifest as YAML for every kind, including the ones whose
 * create dialog has a form — so a steward who filled in fields to make a context space was handed a
 * text editor to change it, and what they saw first was Monaco's line numbers. The two directions are
 * the same pair the create form uses, so a page passes what it already built.
 */
export interface EditableForm {
  schema: JsonSchema;
  uiSchema?: UiSchema;
  /** The stored manifest as the form's own model. */
  fromManifest: (manifest: unknown) => Record<string, unknown>;
  /**
   * The form's model back as the manifest to propose. `stored` is the manifest the edit started
   * from: whatever the form has no field for (a title, a description, a label) is taken from it,
   * or the edit would propose deleting it (T-2470).
   */
  toManifest: (form: Record<string, unknown>, stored: unknown) => unknown;
}

/**
 * Editing a resource: the kind's form when the page gave one, else its manifest as YAML (AG-77,
 * CC-19), then one `PUT` that opens a change for an approver. The name stays either way; a renamed
 * manifest is a new resource.
 */
export function EditResourceDialog({
  target,
  open,
  onOpenChange,
  changed,
  form,
}: {
  target: ResourceTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The manifest with a change already made, e.g. by the assistant; shown in place of the stored one. */
  changed?: Record<string, unknown> | null;
  /** The kind's form, when its page has one: the fields instead of the YAML (T-2278). */
  form?: EditableForm;
}): JSX.Element {
  const { t } = useTranslation();
  const formRoute = useFormRoute();
  const queryClient = useQueryClient();
  const { project, plural, name } = target;
  const home = target.home ?? project;
  const [text, setText] = useState<string | null>(() => (changed ? writable(changed) : null));
  const [edited, setEdited] = useState<Record<string, unknown> | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [change, setChange] = useState<Change | null>(null);

  const current = useQuery({
    queryKey: [...queryKeys.list(home, plural), name],
    enabled: open,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}/{name}", {
          params: { path: { project: home, plural, name } },
        }),
      ),
  });
  const source = text ?? (current.data ? writable(current.data as Record<string, unknown>) : "");

  const propose = useMutation({
    mutationFn: async (body: unknown) =>
      proposeChecked(home, plural, body as { metadata: { name: string } }, false),
    onSuccess: (result) => {
      if (isChange(result)) {
        // Routed, the save goes back to the list and the change is shown there (T-2474).
        if (formRoute) {
          formRoute.leave(<ChangeNotice change={result} project={project} />);
          close(false);
        } else {
          setChange(result);
        }
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.changes(project) });
    },
  });

  /** The name is the resource's path, so a rename is a new resource and not an edit (MF-11). */
  const proposeManifest = (manifest: unknown) => {
    const written = (manifest as { metadata?: { name?: unknown } } | null)?.metadata?.name;
    if (written !== name) {
      setInvalid(t("resourceEdit.renamed", { name }));
      return;
    }
    setInvalid(null);
    propose.mutate(manifest);
  };

  const submit = () => {
    let manifest: unknown;
    try {
      manifest = parseYaml(source);
    } catch (error) {
      setInvalid(error instanceof Error ? error.message : String(error));
      return;
    }
    proposeManifest(manifest);
  };

  // Closing forgets the edit and the answer, so the next opening starts from the stored manifest.
  const close = (next: boolean) => {
    if (!next) {
      setText(null);
      setEdited(null);
      setInvalid(null);
      setChange(null);
      propose.reset();
    }
    onOpenChange(next);
  };

  // What the edit itself was refused for. A manifest that could not be read is its own state
  // below, with the API's sentence and a retry, rather than a red line over a dialog that says
  // "Loading…" for ever (T-1752).
  const failure =
    invalid ??
    (propose.error instanceof ApiError
      ? (propose.error.problem?.detail ?? propose.error.message)
      : propose.error
        ? t("app.error.generic")
        : null);

  return (
    <FormFrame
      open={open}
      onOpenChange={close}
      size="lg"
      title={t("resourceEdit.title", { name: target.label ?? name })}
      description={t("resourceEdit.lead")}
      closeLabel={t("resourceDelete.close")}
      footer={
        change ? (
          <Button onClick={() => close(false)}>{t("resourceDelete.close")}</Button>
        ) : form ? (
          // The form has its own submit, and two would be one too many.
          <Button variant="secondary" onClick={() => close(false)}>
            {t("form.cancel")}
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => close(false)}>
              {t("form.cancel")}
            </Button>
            <Button
              variant="primary"
              loading={propose.isPending}
              disabled={!current.data}
              // Reachable while it is refused, with the reason read out beside it: there is
              // nothing to propose until the stored manifest has arrived (UI-44).
              disabledReason={
                current.data
                  ? undefined
                  : current.isError
                    ? t("resourceEdit.unreadable", { name })
                    : t("resourceEdit.loading", { name })
              }
              onClick={submit}
            >
              {t("resourceEdit.propose")}
            </Button>
          </>
        )
      }
    >
      {change ? (
        <ChangeNotice change={change} project={project} />
      ) : (
        <div className="flex flex-col gap-4">
          {failure ? (
            <Alert tone="danger" role="alert">
              {failure}
            </Alert>
          ) : null}
          {current.isPending ? (
            // The wait and the failure are two states, not one (T-1752). They used to be the
            // same `current.data ? … : "Loading…"` branch, so a GET that failed left the dialog
            // saying "Loading…" for ever beside a red line, with nothing to press and no way out
            // but closing it — and the word was in no live region, so nobody was told at all.
            <PageLoading label={t("resourceEdit.loading", { name })} lines={1} />
          ) : current.isError ? (
            <PageFailed error={current.error} onRetry={() => void current.refetch()} />
          ) : form ? (
            current.data ? (
              <SchemaForm<Record<string, unknown>>
                schema={form.schema}
                // The name is where this manifest lives, so it is read here and changed nowhere.
                uiSchema={{
                  ...form.uiSchema,
                  name: {
                    ...((form.uiSchema?.name as Record<string, unknown> | undefined) ?? {}),
                    "ui:readonly": true,
                  },
                }}
                formData={edited ?? form.fromManifest(current.data)}
                submitLabel={t("resourceEdit.propose")}
                submitting={propose.isPending}
                onChange={(next) => {
                  setEdited((next ?? {}) as Record<string, unknown>);
                  setInvalid(null);
                }}
                onSubmit={(next) => proposeManifest(form.toManifest(next, current.data))}
              />
            ) : null
          ) : (
            <div className="overflow-hidden rounded-md border border-border">
              <Suspense fallback={<PageLoading label={t("models.loadingEditor")} lines={1} className="p-3" />}>
                <MonacoSourceView
                  value={source}
                  onChange={(next) => {
                    setText(next);
                    setInvalid(null);
                  }}
                  onMount={() => undefined}
                  height="24rem"
                />
              </Suspense>
            </div>
          )}
        </div>
      )}
    </FormFrame>
  );
}

/**
 * The Edit action of one row: shown only to a person whose role may propose the kind, the dialog
 * opened on click, or at once when the page was opened with `?edit=<name>`, on the change the
 * assistant made when it made one.
 */
export function EditResourceAction({
  target,
  form,
  open: openedByRow,
  onOpenChange,
  trigger = true,
}: {
  target: ResourceTarget;
  /** The kind's own form, when its page has one to give (T-2278). */
  form?: EditableForm;
  /**
   * The row holds the state instead, because a dialog opened from a menu cannot live inside it: the
   * menu unmounts when it closes and would take the dialog with it (T-2279). With `trigger={false}`
   * this renders the dialog alone and the row's menu item opens it.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const mayPropose = usePermissions(target.home ?? target.project).can(target.kind, "propose");
  const [request] = useState(() => takeEditRequest(target.name));
  const [ownOpen, setOwnOpen] = useState(request !== null);
  // The row may open this, and so may the URL (`?edit=`/`?delete=`) or the assistant's hand-off: both
  // are honoured, and closing clears both, so a page opened on one resource still opens its dialog
  // when the row owns the trigger (T-2287).
  const open = ownOpen || (openedByRow ?? false);
  const setOpen = (next: boolean) => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  return (
    <>
      {trigger ? (
      <PermissionGuard project={target.home ?? target.project} kind={target.kind} verb="propose">
        <Button
          size="sm"
          aria-label={t("resourceEdit.action", { name: target.label ?? target.name })}
          onClick={() => setOpen(true)}
        >
          {t("resourceEdit.button")}
        </Button>
      </PermissionGuard>
      ) : null}
      {mayPropose ? (
        <EditResourceDialog
          target={target}
          open={open}
          onOpenChange={setOpen}
          changed={request?.manifest}
          form={form}
        />
      ) : null}
    </>
  );
}
