/**
 * The (i) beside a space's size on the Spaces list (T-6208): when the broker measured it, how
 * often it is measured, and a Recalculate for anyone who may read the space.
 */
import type { JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { recalculateSpaceUsage, spaceUsageQuery, usageRefusal } from "../api/spaceUsage";
import type { SpaceUsage } from "../api/spaceUsage";
import { ToolbarPopover } from "./entities/GridToolbar";
import { Button, InlineError } from "./ui";

/** The (i) once the space's usage has come; nothing while it is on its way or refused. */
export function UsageInfo({ usage, ...rest }: { project: string; space: string; usage: SpaceUsage | undefined; locale: string }): JSX.Element | null {
  return usage ? <SpaceUsageInfo usage={usage} {...rest} /> : null;
}

export function SpaceUsageInfo({ project, space, usage, locale }: { project: string; space: string; usage: SpaceUsage; locale: string }): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const recalculate = useMutation({
    mutationFn: () => recalculateSpaceUsage(project, space),
    onSuccess: (fresh) => queryClient.setQueryData(spaceUsageQuery(project, space).queryKey, fresh),
  });
  // a Portal before T-6208 answers no measuredAt: the time it answered is the best there is
  const at = new Date(usage.measuredAt ?? usage.observedAt);
  const when = Number.isNaN(at.getTime()) ? "—" : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
  return (
    <ToolbarPopover label={t("spaces.usage.info", { space })} icon="info" anchored end>
      <div className="flex flex-col gap-2 text-left">
        <p data-testid="space-measured">{t("spaces.usage.measured", { when })}</p>
        <p className="text-caption text-fg-muted">{t("spaces.usage.hint")}</p>
        <div>
          <Button size="sm" onClick={() => recalculate.mutate()} disabled={recalculate.isPending}>
            {recalculate.isPending ? t("spaces.usage.recalculating") : t("spaces.usage.recalculate")}
          </Button>
        </div>
        {recalculate.isPending ? (
          <p role="status" className="sr-only">
            {t("spaces.usage.recalculating")}
          </p>
        ) : null}
        {recalculate.isError ? <InlineError>{t("spaces.usage.failed", { reason: usageRefusal(recalculate.error) })}</InlineError> : null}
      </div>
    </ToolbarPopover>
  );
}
