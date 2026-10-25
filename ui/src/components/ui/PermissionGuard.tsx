import { cloneElement } from "react";
import type { JSX, ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../../api/permissions";
import type { Verb } from "../../api/permissions";
import { ORG_NAMESPACE } from "../../api/manifest";
import { kindPlural } from "../../kindWords";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Why a control is refused. At organization scope it names who may, in words (T-4831): "Only an
 * organization administrator can add or change agent profiles.", never the verb and the kind's
 * code name the raw sentence quoted to an administrator on Agent profiles.
 */
export function deniedReason(t: Translate, project: string, verb: Verb, kind: string): string {
  return project === ORG_NAMESPACE
    ? t("permissions.deniedOrganization", {
        action: t(`permissions.action.${verb}`, { defaultValue: verb }),
        kinds: kindPlural(kind, t),
      })
    : t("permissions.denied", { verb, kind });
}

/**
 * Disabled with a reason (T-0603, UI-44, PF-50, PF-51): a control whose verb the caller's
 * effective permissions deny stays where it is, disabled, and says which verb on which kind the
 * role lacks. The guard reflects `permissions/me` and decides nothing: the same request sent
 * directly is the API's 403. While the document has not arrived, and for a bootstrap
 * administrator, the control renders as it is.
 *
 * It hands the reason to the control rather than wrapping it. `Button` carries `disabledReason`
 * for exactly this: it makes itself `aria-disabled` instead of `disabled`, so it keeps its place
 * in the tab order and can be reached and read, and refuses the click all the same. The wrapper
 * this used to render — a bare `tabIndex={0}` span with no role, no name and no focus ring —
 * existed only because the guard had hard-disabled the button out of the tab order first.
 */
export function PermissionGuard({
  project,
  kind,
  verb,
  children,
}: {
  project: string;
  kind: string;
  verb: Verb;
  /** One `Button`; it is given the reason and disables itself with it. */
  children: ReactElement<{ disabled?: boolean; disabledReason?: string }>;
}): JSX.Element {
  const { t } = useTranslation();
  const { can } = usePermissions(project);
  if (can(kind, verb)) {
    return children;
  }
  return cloneElement(children, {
    disabled: true,
    disabledReason: deniedReason(t, project, verb, kind),
  });
}

/**
 * The reason, said where one sees it (T-4263, UI-44): the guard's reason sits in a tooltip and
 * screen-reader text only, so a viewer before a row of greyed create buttons read nothing on why.
 * One line under the header names it once, for the kinds the page creates, when the document says
 * the role may propose none of them. Nothing while the document is unknown, as with the guard.
 */
export function MayNotCreate({
  project,
  kinds,
  message = "form.mayNotCreate",
}: {
  project: string;
  kinds: string[];
  /** The line's key, for a page whose refused controls change a resource rather than create one. */
  message?: string;
}): JSX.Element | null {
  const { t } = useTranslation();
  const { data, can } = usePermissions(project);
  if (data === undefined || kinds.some((kind) => can(kind, "propose"))) {
    return null;
  }
  return <p className="mt-1 max-w-prose text-caption text-fg-muted">{t(message)}</p>;
}
