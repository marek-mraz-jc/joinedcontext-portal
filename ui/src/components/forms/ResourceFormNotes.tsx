import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Alert, Badge, Button, ExternalLink, Icon, safeHref } from "../ui";
import { queryKeys } from "../../api/client";
import type { Effective } from "../../api/permissions";
import { proposeStanding } from "../../api/approval";
import type { Draft, Verdict } from "../../api/drafts";
import { askAbout } from "../../assistant/state";
import { kindPlural } from "../../kindWords";
import { findingSentence } from "./resourceForm";

/**
 * Before the click, whether proposing waits for another approver and why (PF-58, PF-70). A change
 * approved as soon as it is proposed is the normal case and says nothing (T-6105). It reads the permissions the page already holds and fetches nothing, so
 * opening a form never races its draft's load with a request of its own.
 */
function ProposeStandingNote({ project, kind }: { project: string; kind: string }): JSX.Element | null {
  const { t } = useTranslation();
  const { data } = useQuery<Effective>({ queryKey: queryKeys.permissions(project), enabled: false });
  const standing = proposeStanding(data, kind);
  if (!standing || standing === "approvedOnPropose") return null;
  return (
    <p role="status" data-testid="propose-standing" className="text-caption text-fg-muted">
      {t(`changes.${standing}`, { kind: kindPlural(kind, t) })}
    </p>
  );
}

/** The draft's last writer and the strict badge, for a form that keeps a draft. */
function DraftStatus({ draft, strict }: { draft: Draft | null; strict: boolean }): JSX.Element | null {
  const { t } = useTranslation();
  if (!draft && !strict) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {draft ? (
        <span data-testid="draft-status" className="text-caption text-fg-muted">
          {t("drafts.touched", { who: draft.touchedBy, kind: draft.touchedKind, version: draft.version })}
        </span>
      ) : null}
      {strict ? <Badge title={t("drafts.strictHelp")}>{t("drafts.strict")}</Badge> : null}
    </div>
  );
}

const FINDING_TONE: Record<string, string> = { error: "text-danger", warning: "text-warning" };

/** Every finding of the verdict, with its path: one with no field to sit on is read here. */
function Findings({ findings }: { findings: NonNullable<Verdict["findings"]> }): JSX.Element | null {
  const { t } = useTranslation();
  if (findings.length === 0) return null;
  return (
    <div
      data-testid="draft-findings"
      className="flex flex-col gap-1 rounded border border-border bg-surface-subtle p-2 text-caption"
    >
      <span className="font-semibold text-fg">{t("drafts.findings")}</span>
      <ul className="list-disc pl-4 space-y-0.5">
        {findings.map((f, idx) => (
          <li key={idx} className={FINDING_TONE[f.level] ?? "text-fg-muted"}>
            {f.path ? <span className="font-mono">{f.path}: </span> : null}
            <span>{findingSentence(f.message, t)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface ResourceFormNotesProps {
  kind?: string;
  conflict: string | null;
  saveRefused: string | null;
  project?: string;
  draftKind?: string;
  draft: Draft | null;
  strict: boolean;
  verdict: Verdict | null;
  restartsStream: boolean;
}

/**
 * The kind's page in the User Guide as a "?" beside the form's title, and only when this
 * installation serves one (UI-02, DP-11, T-2252, T-6105): the form opens on its first field, with
 * no sentence above it. The label names the page, so a screen reader announces where it goes.
 *
 * The base half of the address is the installation's `documentationBaseUrl`, which arrives from a
 * manifest: an address that is not a place renders nothing (PF-50, T-2409), and `ExternalLink`
 * carries `rel="noopener noreferrer"`, which the form behind it needs because it may hold typing.
 */
export function FormGuideLink({ kind, href }: { kind?: string; href?: string | null }): JSX.Element | null {
  const { t } = useTranslation();
  if (!safeHref(href)) return null;
  const label = `${t("form.guideLink", { kind: kind ? kindPlural(kind, t) : "" })} (${t("app.opensNewTab")})`;
  return (
    <ExternalLink
      data-testid="form-guide"
      href={href}
      hideIcon
      aria-label={label}
      title={label}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted no-underline hover:bg-surface-muted hover:text-fg"
    >
      <Icon name="help" className="size-4" aria-hidden="true" />
    </ExternalLink>
  );
}

/** What a form says above its fields: the draft's state, and only what changes what happens. */
export function ResourceFormNotes(props: ResourceFormNotesProps): JSX.Element {
  const { t } = useTranslation();
  const { kind, draftKind, project } = props;
  return (
    <>
      {kind ? (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => askAbout(t("form.fillFromSentenceQuestion", { kind }))}
          >
            {t("form.fillFromSentence")}
          </Button>
        </div>
      ) : null}

      {props.conflict ? (
        <Alert role="alert" tone="warning">
          {props.conflict}
        </Alert>
      ) : null}
      {props.saveRefused ? (
        <Alert role="alert" tone="danger">
          {t("drafts.saveRefused", { reason: props.saveRefused })}
        </Alert>
      ) : null}

      {draftKind && project ? <ProposeStandingNote project={project} kind={draftKind} /> : null}

      {draftKind ? <DraftStatus draft={props.draft} strict={props.strict} /> : null}

      {draftKind && props.verdict?.findings ? <Findings findings={props.verdict.findings} /> : null}

      {props.restartsStream ? (
        <Alert role="status" tone="warning">
          {t("form.restartsStream")}
        </Alert>
      ) : null}
    </>
  );
}
