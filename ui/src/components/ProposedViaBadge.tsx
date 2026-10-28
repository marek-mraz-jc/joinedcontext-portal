import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import type { components } from "../api/schema";
import { Badge } from "./ui";

type ProposedVia = components["schemas"]["ProposedVia"];

/**
 * The AI client a change came through, read from its merge request's trailer (AG-137, T-5973):
 * "via Claude Code connector doprava-in-claude" when a connector opened it, else the client alone.
 */
export function ProposedViaBadge({ via }: { via: ProposedVia }): JSX.Element {
  const { t } = useTranslation();
  return (
    <Badge tone="accent" data-testid="change-proposed-via">
      {via.connectorName
        ? t("approvals.proposedVia.badgeConnector", {
            client: via.client,
            connector: via.connectorName,
          })
        : t("approvals.proposedVia.badge", { client: via.client })}
    </Badge>
  );
}

/** The sentence under the author: who confirmed, through which connector, after which plan. */
export function ProposedViaHint({
  via,
  author,
}: {
  via: ProposedVia;
  author: string;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <dd className="mt-1 text-xs text-fg-muted">
        {via.connectorName
          ? t("approvals.proposedVia.hintConnector", {
              client: via.client,
              connector: via.connectorName,
              author,
            })
          : t("approvals.proposedVia.hint", { client: via.client, author })}
      </dd>
      {via.plan ? (
        <dd className="mt-1 text-xs text-fg-muted" data-testid="change-proposed-plan">
          {t("approvals.proposedVia.plan", { plan: via.plan, author })}
        </dd>
      ) : null}
    </>
  );
}
