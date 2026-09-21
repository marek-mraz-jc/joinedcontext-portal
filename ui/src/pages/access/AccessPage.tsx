import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { ServiceAccounts } from "./ServiceAccounts";
import { EffectivePermissions } from "./EffectivePermissions";
import { RoleBindings } from "./RoleBindings";
import { Roles } from "./Roles";
import { Groups } from "./Groups";
import { OrganizationDomain } from "./OrganizationDomain";
import { PageHeader } from "../../components/ui/PageHeader";

/** Project → Access: who holds which role here, who is not a person, and what any of us may actually read and write. */
export function AccessPage({ project }: { project: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-8">
      <PageHeader title={t("access.title")} description={t("access.lead")} />
      <RoleBindings project={project} />
      <Roles project={project} />
      <Groups project={project} />
      <OrganizationDomain />
      <ServiceAccounts project={project} />
      <EffectivePermissions project={project} />
    </div>
  );
}
