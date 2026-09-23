import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { LifecycleBadge } from "./status/LifecycleBadge";
import type { Change } from "../api/manifest";
import { Alert, buttonClass } from "./ui";

/**
 * What a write leaves behind: a merge request waiting for an approver, not a saved record, or one
 * approved as it was proposed because the person administers its kind (PF-58).
 */
export function ChangeNotice({
  change,
  project,
}: {
  change: Change;
  project: string;
}): JSX.Element {
  const { t } = useTranslation();
  // Approved already when it is on its way to the branch or there (PF-58); anything else waits.
  const waiting = !["Deploying", "Merged", "Applied"].includes(change.status.phase);
  return (
    <Alert
      role="status"
      tone="info"
      actions={
        <Link
          to="/projects/$project/approvals/$id"
          params={{ project, id: change.metadata.name }}
          className={buttonClass("secondary", "sm")}
        >
          {waiting ? t("changes.review") : t("changes.open")}
        </Link>
      }
    >
      <span className="flex flex-wrap items-center gap-2">
        <span>{waiting ? t("changes.accepted") : t("changes.approvedAsProposed")}</span>
        <span className="font-mono font-medium">{change.metadata.name}</span>
        <LifecycleBadge kind="lane" value={change.status.lane} />
        <LifecycleBadge kind="phase" value={change.status.phase} />
      </span>
    </Alert>
  );
}
