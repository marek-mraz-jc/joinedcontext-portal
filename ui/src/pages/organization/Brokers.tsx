import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, unwrap } from "../../api/client";
import { ORG_NAMESPACE } from "../../api/manifest";
import { administersOrganization, usePermissions } from "../../api/permissions";
import type { components } from "../../api/schema";
import {
  Alert,
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableSkeleton,
} from "../../components/ui";
import type { BadgeTone } from "../../components/ui/Badge";
import { PageFailed } from "../../components/ui/PageState";

type Health = components["schemas"]["Health"];

const TONE: Record<Health, BadgeTone> = { up: "success", down: "danger", unknown: "neutral" };

/**
 * Organization → Brokers (PF-116, ADR-N-046, API/01 §43): every context broker with its version,
 * health, spaces and load. The Portal asks the brokers; the browser never reaches one. Only an
 * administrator of the organization reads it; anyone else is told so and nothing is fetched.
 */
export function Brokers(): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";
  const permissions = usePermissions(ORG_NAMESPACE);
  const administers = administersOrganization(permissions.data);
  const brokers = useQuery({
    queryKey: ["organizationBrokers"],
    enabled: administers,
    queryFn: async () => unwrap(await api.GET("/api/v1/organization/brokers")),
  });

  if (permissions.isLoading) {
    return (
      <p role="status" className="text-body text-fg-muted">
        {t("app.loading")}
      </p>
    );
  }
  const items = brokers.data?.items ?? [];
  const down = items.filter((broker) => broker.health !== "up").length;
  const number = new Intl.NumberFormat(locale);

  return (
    <section className="space-y-4" aria-labelledby="organization-brokers-heading">
      <div>
        <h2 id="organization-brokers-heading" className="text-title font-semibold text-fg">
          {t("organization.brokers.title")}
        </h2>
        <p className="text-body text-fg-muted">{t("organization.brokers.lead")}</p>
      </div>
      {!administers ? (
        <Alert tone="info">{t("organization.brokers.hidden")}</Alert>
      ) : brokers.isError ? (
        <PageFailed error={brokers.error} onRetry={() => void brokers.refetch()} />
      ) : (
        <>
          {brokers.isSuccess && down > 0 ? (
            <Alert tone="danger" role="status">
              {t("organization.brokers.down", { count: down })}
            </Alert>
          ) : null}
          {brokers.isSuccess && items.length === 1 && !items[0].declared ? (
            <Alert tone="info">{t("organization.brokers.implicit")}</Alert>
          ) : null}
          <Table caption={t("organization.brokers.caption")} status={brokers.isPending ? t("app.loading") : undefined}>
            <TableHead>
              <TableHeaderCell>{t("organization.brokers.name")}</TableHeaderCell>
              <TableHeaderCell>{t("organization.brokers.health")}</TableHeaderCell>
              <TableHeaderCell>{t("organization.brokers.version")}</TableHeaderCell>
              <TableHeaderCell>{t("organization.brokers.spaces")}</TableHeaderCell>
              <TableHeaderCell align="right">{t("organization.brokers.entities")}</TableHeaderCell>
            </TableHead>
            {brokers.isPending ? (
              <TableSkeleton columns={5} />
            ) : (
              <TableBody>
                {items.map((broker) => (
                  <TableRow key={broker.name}>
                    <TableCell primary>
                      <span className="font-mono">{broker.name}</span>
                      {broker.default ? (
                        <span className="ml-2">
                          <Badge tone="info">{t("organization.brokers.default")}</Badge>
                        </span>
                      ) : null}
                      {broker.size ? (
                        <span className="block text-caption text-fg-muted">
                          {t("organization.brokers.size", { size: broker.size })}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge tone={TONE[broker.health]}>{t(`organization.brokers.states.${broker.health}`)}</Badge>
                      {broker.reason ? <span className="block text-caption text-fg-muted">{broker.reason}</span> : null}
                    </TableCell>
                    <TableCell>{broker.version ?? "—"}</TableCell>
                    <TableCell>
                      {broker.spaces.length === 0 ? (
                        t("organization.brokers.noSpaces")
                      ) : (
                        <ul className="space-y-1">
                          {broker.spaces.map((space) => (
                            <li key={space} className="font-mono text-caption">
                              {space}
                            </li>
                          ))}
                        </ul>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      {broker.health === "up" ? number.format(broker.entities) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            )}
          </Table>
        </>
      )}
    </section>
  );
}
