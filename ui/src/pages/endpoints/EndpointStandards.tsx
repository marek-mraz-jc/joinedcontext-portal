import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, unwrap } from "../../api/client";

/**
 * A public Endpoint's query standards (API/01 §16a, T-4484): the fields each one filters on and
 * queries built from one real entity, each of which answered with data when the Portal read it.
 * Nothing here is typed by hand: the Portal reads it all anonymously through the Endpoint.
 */
export function EndpointStandards({ slug }: { slug: string }): JSX.Element | null {
  const { t } = useTranslation();
  const standards = useQuery({
    queryKey: ["endpoint-standards", slug],
    retry: false,
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/catalogue/endpoints/{slug}/standards", { params: { path: { slug } } })),
  });
  if (standards.isPending) return null;
  if (standards.isError) {
    return (
      <p className="text-body text-fg-muted" role="status">
        {t("endpoints.standards.unavailable")}
      </p>
    );
  }
  return (
    <section aria-labelledby="endpoint-standards" className="flex flex-col gap-3" data-testid="endpoint-standards">
      <h2 id="endpoint-standards" className="text-body font-semibold text-fg">
        {t("endpoints.standards.title")}
      </h2>
      <p className="text-body text-fg-muted">{t("endpoints.standards.lead")}</p>
      {standards.data.standards.map((standard) => (
        <section
          key={standard.representation}
          aria-label={t(`endpoints.representationOption.${standard.representation}`)}
          className="flex flex-col gap-2 rounded-lg border border-border p-3"
        >
          <h3 className="text-body font-semibold text-fg">{t(`endpoints.representationOption.${standard.representation}`)}</h3>
          {standard.fields.length > 0 ? (
            <p className="text-caption text-fg-muted">
              {t("endpoints.standards.fields")} <span className="font-mono text-fg">{standard.fields.join(", ")}</span>
            </p>
          ) : null}
          {standard.examples.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {standard.examples.map((example) => (
                <li key={example.url} className="flex flex-col gap-0.5">
                  <span className="text-caption text-fg-muted">
                    {t(`endpoints.standards.${example.kind === "range" ? "range" : "equality"}`, { field: example.field })} ·{" "}
                    {t("endpoints.standards.answered", { count: example.answered })}
                  </span>
                  <a className="break-all font-mono text-caption text-primary-soft-fg underline" href={example.url}>
                    {example.url}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-caption text-fg-muted">{t("endpoints.standards.none")}</p>
          )}
        </section>
      ))}
    </section>
  );
}
