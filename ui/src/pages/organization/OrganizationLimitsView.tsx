import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../components/ui";
import { boundText, entryKey, SECTIONS, valueText } from "./limits";
import type { OrganizationLimits } from "./limits";

/** The quota dimensions a manifest count answers (PF-75), in the order a person reads them. */
const COUNTED = ["contextSpaces", "residentPipelines", "publicEndpoints", "apps"] as const;
/** The ones enforced at run time: only their limit is known here. */
const RUNTIME = ["ingestEventsPerSecond", "agentRunsPerDay", "entitiesPerSpace", "requestsPerMinute"] as const;

/**
 * Every policy and limit of the organization, one section per catalog section, each entry with
 * the value in force, the range allowed and a one-line hint; then each readable project's quota
 * with what it uses (PF-99, PF-101, PF-102).
 */
export function OrganizationLimitsView({
  limits,
  publicApps,
  models,
}: {
  limits: OrganizationLimits;
  /** `spec.policies.apps.public`; absent is `allowed`. */
  publicApps?: string;
  /** `spec.policies.agents.models`; absent is every model of the installation. */
  models?: string[];
}): JSX.Element {
  const { t } = useTranslation();
  const quotaCell = (used: number | null | undefined, limit: number | null | undefined) => {
    const allowed = limit === null || limit === undefined ? t("organization.limits.noLimit") : String(limit);
    return used === null || used === undefined ? allowed : t("organization.limits.usedOf", { used, limit: allowed });
  };

  return (
    <div className="space-y-8">
      {SECTIONS.map((section) => {
        const entries = (limits.entries ?? []).filter((entry) => entry.section === section);
        const headingId = `organization-limits-${section}`;
        return (
          <section key={section} className="space-y-3" aria-labelledby={headingId}>
            <h3 id={headingId} className="text-subtitle font-semibold text-fg">
              {t(`organization.limits.section.${section}`)}
            </h3>
            <Table caption={t(`organization.limits.section.${section}`)}>
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col">{t("organization.limits.setting")}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t("organization.limits.inForce")}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t("organization.limits.range")}</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {section === "applications" ? (
                  <TableRow>
                    <TableCell>
                      <span className="font-medium text-fg">{t("organization.policy.publicApps")}</span>
                      <p className="text-caption text-fg-muted">{t("organization.policy.publicAppsHint")}</p>
                    </TableCell>
                    <TableCell>{t(`organization.policy.publicApps_${publicApps === "refused" ? "refused" : "allowed"}`)}</TableCell>
                    <TableCell>—</TableCell>
                  </TableRow>
                ) : null}
                {section === "agents" ? (
                  <TableRow>
                    <TableCell>
                      <span className="font-medium text-fg">{t("organization.policy.models")}</span>
                      <p className="text-caption text-fg-muted">{t("organization.policy.modelsHint")}</p>
                    </TableCell>
                    <TableCell>{models && models.length > 0 ? models.join(", ") : t("organization.policy.everyModel")}</TableCell>
                    <TableCell>—</TableCell>
                  </TableRow>
                ) : null}
                {entries.map((entry) => (
                  <TableRow key={entry.path}>
                    <TableCell>
                      <span className="font-medium text-fg">{t(`organization.limit.${entryKey(entry.path)}.label`)}</span>
                      <p className="text-caption text-fg-muted">{t(`organization.limit.${entryKey(entry.path)}.hint`)}</p>
                    </TableCell>
                    <TableCell>{valueText(t, entry)}</TableCell>
                    <TableCell>{boundText(t, entry)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        );
      })}

      <section className="space-y-3" aria-labelledby="organization-limits-projects-table">
        <h3 id="organization-limits-projects-table" className="text-subtitle font-semibold text-fg">
          {t("organization.limits.perProject")}
        </h3>
        <p className="text-body text-fg-muted">{t("organization.limits.perProjectLead")}</p>
        <Table caption={t("organization.limits.perProject")}>
          <TableHead>
            <TableRow>
              <TableHeaderCell scope="col">{t("organization.limits.project")}</TableHeaderCell>
              <TableHeaderCell scope="col">{t("organization.limits.whose")}</TableHeaderCell>
              {[...COUNTED, ...RUNTIME].map((dimension) => (
                <TableHeaderCell key={dimension} scope="col">
                  {t(`organization.limit.projects.quota.${dimension}.label`)}
                </TableHeaderCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {(limits.projects ?? []).length === 0 ? (
              <TableEmpty columns={2 + COUNTED.length + RUNTIME.length}>{t("organization.limits.noProjects")}</TableEmpty>
            ) : (
              (limits.projects ?? []).map((row) => (
                <TableRow key={row.project}>
                  <TableCell className="font-mono">{row.project}</TableCell>
                  <TableCell>{t(`organization.limits.origin.${row.origin}`)}</TableCell>
                  {[...COUNTED, ...RUNTIME].map((dimension) => (
                    <TableCell key={dimension}>
                      {quotaCell(row.quota[dimension]?.used, row.quota[dimension]?.limit)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
