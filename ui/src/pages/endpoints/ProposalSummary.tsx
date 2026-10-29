import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "../../components/ui";

/** What the summary reads of the Endpoint form (T-6099). */
export interface SummaryForm {
  name: string;
  title?: string;
  contextSpaceRef: string;
  audience: string;
  enabledRepresentations: string[];
  allowedProjects?: string[];
  publish?: { ckan?: { instanceRef?: string } };
}

/**
 * The proposal in sentences, as a person checks it before "Propose change" (T-6099): what it
 * creates or changes, who may read it, the formats (added and removed ones on an edit), where it
 * is published and that nothing happens before an approval.
 */
export function proposalSentences(
  form: SummaryForm,
  before: SummaryForm | null,
  t: (key: string, values?: Record<string, unknown>) => string,
): string[] {
  const word = (rep: string) => t(`endpoints.representationOption.${rep}`);
  const words = (reps: string[]) => reps.map(word).join(", ");
  const name = form.title?.trim() || form.name;
  // rjsf holds an added, unpicked list item as `undefined`.
  const strings = (values: unknown[] | undefined) =>
    (values ?? []).filter((value): value is string => typeof value === "string" && value.length > 0);
  const projects = strings(form.allowedProjects);
  const formats = strings(form.enabledRepresentations);
  const portal = form.publish?.ckan?.instanceRef?.trim();
  const sentences = [
    before ? t("endpoints.summary.edit", { name }) : t("endpoints.summary.create", { name, space: form.contextSpaceRef }),
    form.audience === "public"
      ? t("endpoints.summary.public")
      : form.audience === "organization"
        ? t("endpoints.summary.organization")
        : projects.length > 0
          ? t("endpoints.summary.projects", { projects: projects.join(", ") })
          : t("endpoints.summary.project"),
  ];
  if (before) {
    const had = strings(before.enabledRepresentations);
    const added = formats.filter((rep) => !had.includes(rep));
    const removed = had.filter((rep) => !formats.includes(rep));
    if (added.length > 0) sentences.push(t("endpoints.summary.added", { formats: words(added) }));
    if (removed.length > 0) sentences.push(t("endpoints.summary.removed", { formats: words(removed) }));
  }
  sentences.push(
    t("endpoints.summary.formats", { formats: words(formats) }),
    portal ? t("endpoints.summary.published", { portal }) : t("endpoints.summary.unpublished"),
    t("endpoints.summary.approval"),
  );
  return sentences;
}

/** The summary card the form shows above its footer. */
export function ProposalSummary({ form, before }: { form: SummaryForm; before: SummaryForm | null }): JSX.Element {
  const { t } = useTranslation();
  return (
    <Card as="section" padding="sm" data-testid="proposal-summary" aria-labelledby="proposal-summary-title">
      <h2 id="proposal-summary-title" className="text-body font-semibold text-fg">
        {t("endpoints.summary.title")}
      </h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-body text-fg-muted">
        {proposalSentences(form, before, t).map((sentence) => (
          <li key={sentence}>{sentence}</li>
        ))}
      </ul>
    </Card>
  );
}
