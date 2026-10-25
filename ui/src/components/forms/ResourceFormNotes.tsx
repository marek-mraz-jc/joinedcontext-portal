import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Alert, Badge, Button, ExternalLink } from "../ui";
import { queryKeys } from "../../api/client";
import type { Effective } from "../../api/permissions";
import { proposeStanding } from "../../api/approval";
import type { Draft, Verdict } from "../../api/drafts";
import { askAbout } from "../../assistant/state";
import { kindPlural } from "../../kindWords";
import { findingSentence } from "./resourceForm";

/**
 * Before the click, what proposing leads to: approved at once, or waiting for another approver
 * and why (PF-58, PF-70). It reads the permissions the page already holds and fetches nothing, so
 * opening a form never races its draft's load with a request of its own.
 */
function ProposeStandingNote({ project, kind }: { project: string; kind: string }): JSX.Element | null {
  const { t } = useTranslation();
  const { data } = useQuery<Effective>({ queryKey: queryKeys.permissions(project), enabled: false });
  const standing = proposeStanding(data, kind);
  if (!standing) return null;
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
  /** What the kind is for, from its arrangement (UI-02, T-1608). */
  about?: string;
  guideHref?: string;
  conflict: string | null;
  saveRefused: string | null;
  project?: string;
  draftKind?: string;
  draft: Draft | null;
  strict: boolean;
  verdict: Verdict | null;
  restartsStream: boolean;
}

/** What a form says above its fields: what the kind is, its guide, and the draft's state. */
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

      {/*
        What the kind is for, before the form asks anything (UI-02, T-1608): two sentences from
        the kind's own arrangement, in the person's language. A person who opened this dialog
        without knowing what a Layer or a SyncSource is reads it here and nowhere else.
      */}
      {props.about ? (
        <p data-testid="form-about" className="text-body text-fg-muted">
          {props.about}
        </p>
      ) : null}

      {/*
        One link to the kind's page in the User Guide, and only when this installation serves
        one: `guideUrl` answers nothing without both the base URL and the page, so an instance
        without a guide shows no dead link (UI-02, DP-11, T-2252). It names the page it opens,
        so a screen reader announces where it goes rather than "link".

        `ExternalLink`, not a hand-written anchor: the base half of this address is the
        installation's `documentationBaseUrl`, which arrives from a manifest, and a manifest
        must never be able to put a `javascript:` URL behind something to click (PF-50,
        T-2409). It is also what carries `rel="noopener noreferrer"` and the words that say a
        new tab opens, which the form behind it needs because it may hold typing.
      */}
      {props.guideHref ? (
        <p className="text-body">
          <ExternalLink data-testid="form-guide" href={props.guideHref} className="text-primary-soft-fg underline-offset-2">
            {t("form.guideLink", { kind: kind ? kindPlural(kind, t) : "" })}
          </ExternalLink>
        </p>
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
