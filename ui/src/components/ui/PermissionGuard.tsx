import { cloneElement } from "react";
import type { JSX, ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../../api/permissions";
import type { Verb } from "../../api/permissions";

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
    disabledReason: t("permissions.denied", { verb, kind }),
  });
}
