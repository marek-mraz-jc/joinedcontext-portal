import { useState } from "react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { Button, Icon } from "../../components/ui";
import { saveConnectors, toggledStar, useConnectors } from "./connectors";

/**
 * The Endpoint page's star (UI-98): puts the Endpoint in the person's first connector, or a new
 * `favourites`, and takes it out of every connector again. The server refuses an Endpoint the
 * person may not read, and the refusal is shown here.
 */
export function ConnectorStar({ slug }: { slug: string }): JSX.Element {
  const { t } = useTranslation();
  const connectors = useConnectors();
  const [said, setSaid] = useState("");
  const holding = connectors.filter((connector) => connector.select?.endpoints?.includes(slug)).map((connector) => connector.name);
  const toggle = () => {
    setSaid("");
    saveConnectors((current) => toggledStar(current, slug)).catch((error: Error) => setSaid(error.message));
  };
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm" aria-pressed={holding.length > 0} onClick={toggle} icon={<Icon name="star" className={holding.length > 0 ? "size-4 fill-current" : "size-4"} />}>
        {holding.length > 0 ? t("connectors.star.in", { names: holding.join(", ") }) : t("connectors.star.add")}
      </Button>
      <span aria-live="polite" className="text-caption text-danger">
        {said}
      </span>
    </span>
  );
}
