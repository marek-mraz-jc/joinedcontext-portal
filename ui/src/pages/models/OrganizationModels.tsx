/**
 * The organization's data models (DM-75, DM-79), read-only: only a Change to the organization
 * repository edits one, and a project's model uses one by importing it under the name each row
 * shows (DM-76). The list is the server's, which holds none for a person with no binding in the
 * organization. The Data models page of a project shows it below its own models and links to the
 * Organization page's Data models tab, which shows it alone.
 */
import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ListFailed, reasonOf } from "../../components/forms/widgets/ListFailed";
import { useOrganizationModels } from "../../components/pickers/organizationModels";
import { Badge, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "../../components/ui";

/** The name a project's model imports an organization model by (DM-76): `org.{name}.v{major}`. */
export function organizationImportName(name: string, version: string): string {
  return `org.${name}.v${version.split(".")[0]}`;
}

export function OrganizationModels({ inProject = false }: { inProject?: boolean }): JSX.Element {
  const { t } = useTranslation();
  const query = useOrganizationModels();
  const models = (query.data?.items ?? []).filter((model) => model.level === "organization");
  return (
    <section aria-labelledby="models-organization" className="flex flex-col gap-3">
      <div>
        <h2 id="models-organization" className="text-title font-semibold text-fg">
          {t("models.page.organizationSection")}
        </h2>
        <p className="text-body text-fg-muted">{t("models.page.organizationLead")}</p>
        {inProject ? (
          <Link
            to="/organization/$tab"
            params={{ tab: "models" }}
            className="focus-ring text-body text-primary-soft-fg underline hover:no-underline"
          >
            {t("models.page.organizationOpen")}
          </Link>
        ) : null}
      </div>
      {query.isError ? (
        <ListFailed
          what={t("models.page.organizationSection")}
          reason={reasonOf(query.error, t("app.error.generic"))}
          onRetry={() => void query.refetch()}
        />
      ) : query.isPending ? (
        <p role="status" className="text-body text-fg-muted">
          {t("app.loading")}
        </p>
      ) : models.length === 0 ? (
        <p className="text-body text-fg-muted">{t("models.page.organizationEmpty")}</p>
      ) : (
        <Table caption={t("models.page.organizationCaption")}>
          <TableHead>
            <TableHeaderCell>{t("models.field.name")}</TableHeaderCell>
            <TableHeaderCell>{t("models.field.version")}</TableHeaderCell>
            <TableHeaderCell>{t("models.classes")}</TableHeaderCell>
            <TableHeaderCell>{t("models.page.importAs")}</TableHeaderCell>
          </TableHead>
          <TableBody>
            {models.map((model) => (
              <TableRow key={model.name}>
                <TableCell primary>{model.name}</TableCell>
                <TableCell>
                  <span className="font-mono">{model.version}</span>
                  {model.lifecycle !== "published" ? (
                    <Badge className="ml-2">
                      {t(`models.lifecycleOption.${model.lifecycle}`, { defaultValue: model.lifecycle })}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>{model.classes.join(", ") || "—"}</TableCell>
                <TableCell>
                  <code className="font-mono text-caption">{organizationImportName(model.name, model.version)}</code>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
