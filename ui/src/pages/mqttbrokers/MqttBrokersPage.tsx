import { useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { api, forPeople, unwrap } from "../../api/client";
import { asManifests } from "../../api/manifest";
import type { Manifest } from "../../api/manifest";
import { useReadableList } from "../../api/permissions";
import type { components } from "../../api/schema";
import { RecordLink, RECORD_LINK_STYLE } from "../../components/RecordLink";
import { CopyUrlButton } from "../../components/endpoints/links";
import { LifecycleBadge } from "../../components/status/LifecycleBadge";
import { CodeBlock,
  Alert,
  Badge,
  Button,
  Card,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../components/ui";
import { KindList } from "../../routes/ResourceListPage";
import { durationWords } from "../../schemas/mqttbroker";
import { useMqttAllowance } from "./allowance";
import { connectionsOf } from "./connections";
import { TestPublishDialog } from "./TestPublish";
import type { Edge } from "./connections";

/**
 * The project's MQTT brokers (T-3839, MF-54, ADR-N-048): the list with its create and edit forms,
 * each broker's topic access by role and how a device connects, and who talks to whom from a
 * device to the Policy that guards the write. A broker holds no secret, so nothing here shows one.
 */
export function MqttBrokersPage({ project }: { project: string }): JSX.Element {
  const brokers = useReadableList(project, "mqttbrokers", "MqttBroker");
  const items = asManifests(brokers.data?.items ?? []);
  return (
    <div className="flex flex-col gap-section">
      <AllowancePanel project={project} />
      <KindList project={project} plural="mqttbrokers" />
      {items.map((broker) => (
        <BrokerCard key={broker.metadata.name} project={project} broker={broker} />
      ))}
      {items.length > 0 ? <Connections project={project} brokers={items} /> : null}
    </div>
  );
}

type Measured = components["schemas"]["Measured"];

interface Role {
  name?: string;
  serviceAccounts?: string[];
  publish?: string[];
  subscribe?: string[];
}

/**
 * Where a device reaches the broker from outside: TLS on 8883 at `<name>.<project>.mqtt.<domain>`,
 * or a dedicated port (ADR-N-048 §5). The domain is the one the Portal is served under
 * (`portal.<domain>`); on any other host it is not known and no address is shown.
 */
export function brokerAddress(name: string, project: string, hostname: string, port?: number): string | undefined {
  if (!hostname.startsWith("portal.")) return undefined;
  const domain = hostname.slice("portal.".length);
  return `${name}.${project}.mqtt.${domain}:${port ?? 8883}`;
}

function BrokerCard({ project, broker }: { project: string; broker: Manifest }): JSX.Element {
  const { t, i18n } = useTranslation();
  const name = broker.metadata.name;
  const spec = (broker.spec ?? {}) as {
    roles?: Role[];
    port?: number;
    mode?: string;
    capture?: { messagesPerTopic?: number; window?: string };
  };
  const mode = spec.mode ?? "ingest";
  const roles = spec.roles ?? [];
  const address = brokerAddress(name, project, window.location.hostname, spec.port);
  const devices = [...new Set(roles.flatMap((role) => role.serviceAccounts ?? []))];
  const caption = t("mqttbrokers.acl.caption", { broker: name });
  const [testing, setTesting] = useState(false);
  const measured = useQuery({
    queryKey: ["mqttBrokerMeasured", project, name],
    refetchInterval: 15_000,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/mqttbrokers/{name}/measured", {
          params: { path: { project, name } },
        }),
      ),
  });
  return (
    <Card>
      <section aria-labelledby={`broker-${name}`} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={`broker-${name}`} className="text-title font-semibold text-fg">
            <RecordLink project={project} plural="mqttbrokers" name={name} />
          </h2>
          <LifecycleBadge kind="phase" value={broker.status?.phase} />
          <Badge tone="info" data-mode={mode}>
            {t(`mqttAllowance.mode.${mode}`, { defaultValue: mode })}
          </Badge>
        </div>
        {mode === "capture" ? (
          <p className="text-body text-fg-muted">
            {t("mqttbrokers.capture.kept", {
              count: spec.capture?.messagesPerTopic ?? 20,
              window: durationWords(spec.capture?.window ?? "PT1H", i18n.resolvedLanguage ?? i18n.language ?? "en"),
            })}
          </p>
        ) : null}
        <Table caption={caption}>
          <TableHead>
            <TableHeaderCell>{t("mqttbrokers.acl.role")}</TableHeaderCell>
            <TableHeaderCell>{t("mqttbrokers.acl.accounts")}</TableHeaderCell>
            <TableHeaderCell>{t("mqttbrokers.acl.publish")}</TableHeaderCell>
            <TableHeaderCell>{t("mqttbrokers.acl.subscribe")}</TableHeaderCell>
            <TableHeaderCell>{t("mqttbrokers.measured.connected")}</TableHeaderCell>
          </TableHead>
          <TableBody>
            {roles.map((role) => (
              <TableRow key={role.name}>
                <TableCell primary>{role.name}</TableCell>
                <TableCell>{(role.serviceAccounts ?? []).join(", ")}</TableCell>
                <TableCell>
                  <Filters filters={role.publish} />
                </TableCell>
                <TableCell>
                  <Filters filters={role.subscribe} />
                </TableCell>
                <TableCell>
                  <Connected accounts={role.serviceAccounts ?? []} measured={measured.data} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-1 text-body sm:grid-cols-[max-content_minmax(0,1fr)]">
          <dt className="text-fg-muted">{t("mqttbrokers.measured.title")}</dt>
          <dd>
            <Measurement measured={measured.data} failed={measured.isError} />
          </dd>
          <dt className="text-fg-muted">{t("mqttbrokers.connect.address")}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {address ? (
              <>
                <code className="min-w-0 break-all font-mono">{address}</code>
                <Badge tone="neutral">TLS</Badge>
                <CopyUrlButton url={address} label={t("mqttbrokers.connect.copy")} />
              </>
            ) : (
              t("mqttbrokers.connect.noAddress")
            )}
          </dd>
          <dt className="text-fg-muted">{t("mqttbrokers.connect.certificate")}</dt>
          <dd className="break-words">{address ? t("mqttbrokers.connect.certificateIssued", { host: address.split(":")[0] }) : "—"}</dd>
          <dt className="text-fg-muted">{t("mqttbrokers.connect.client")}</dt>
          <dd>
            {devices.length > 0
              ? devices.map((account) => (
                  <code key={account} className="mr-2 font-mono">
                    {`${project}-${account}`}
                  </code>
                ))
              : "—"}
          </dd>
          <dt className="text-fg-muted">{t("mqttbrokers.connect.password")}</dt>
          <dd>{t("mqttbrokers.connect.token")}</dd>
          {address && devices.length > 0 ? (
            <>
              <dt className="text-fg-muted">{t("mqttbrokers.connect.example")}</dt>
              <dd className="flex min-w-0 flex-col items-start gap-2">
                <CodeBlock label={t("mqttbrokers.connect.example")} className="max-w-full overflow-x-auto rounded-md bg-surface-subtle p-2 font-mono text-caption">
                  {publishExample(address, `${project}-${devices[0]}`, publishTopic(roles))}
                </CodeBlock>
                <CopyUrlButton
                  url={publishExample(address, `${project}-${devices[0]}`, publishTopic(roles))}
                  label={t("mqttbrokers.connect.copyExample")}
                />
                <span className="text-caption text-fg-muted">{t("mqttbrokers.connect.exampleHint")}</span>
              </dd>
            </>
          ) : null}
          <dt className="text-fg-muted">{t("mqttbrokers.connect.pipeline")}</dt>
          <dd>{t("mqttbrokers.connect.brokerRef", { broker: name })}</dd>
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setTesting(true)}>{t("mqttbrokers.test.open")}</Button>
          <span className="text-caption text-fg-muted">{t("mqttbrokers.test.openHint")}</span>
        </div>
        {testing ? (
          <TestPublishDialog project={project} broker={name} roles={roles} open={testing} onOpenChange={setTesting} />
        ) : null}
      </section>
    </Card>
  );
}

/** The first topic a device may publish to, with `${clientid}` left for the shell to keep as typed. */
export function publishTopic(roles: Role[]): string {
  const filter = roles.flatMap((role) => role.publish ?? [])[0] ?? "devices/${clientid}/data";
  return filter.replace(/\/#$/, "/data").replace(/\+/g, "1");
}

/**
 * A mosquitto_pub line a device owner copies (T-4860): TLS with the system CA store, the client
 * id as user name and `$TOKEN` where the device's access token goes. No token is ever filled in.
 */
export function publishExample(address: string, client: string, topic: string): string {
  const [host, port] = address.split(":");
  return [
    `mosquitto_pub -h ${host} -p ${port}`,
    `  --capath /etc/ssl/certs -i ${client} -u ${client} -P "$TOKEN"`,
    `  -t ${shellQuoted(topic.replaceAll("${clientid}", client))} -m '{"temperature": 21.5}'`,
  ].join(" \\\n");
}

/** One shell word: single quotes, each ' inside closed, escaped and reopened. */
export function shellQuoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * What the project may still add (T-4860, API/01 §47): off with who can turn it on, or the
 * brokers, connections and message rate left, the modes and the addresses it may use.
 */
function AllowancePanel({ project }: { project: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const allowance = useMqttAllowance(project);
  if (allowance.isPending) {
    return (
      <Card aria-busy="true" data-allowance="loading">
        <span className="sr-only">{t("app.loading")}</span>
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="mt-3 h-4 w-2/3" />
      </Card>
    );
  }
  if (allowance.isError) {
    return (
      <Alert role="alert" tone="danger" title={t("mqttAllowance.project.errorTitle")} data-allowance="error">
        {allowance.error instanceof Error ? forPeople(allowance.error.message) : t("mqttAllowance.project.error")}
      </Alert>
    );
  }
  const data = allowance.data;
  if (!data.enabled) {
    return (
      <Alert tone="info" title={t("mqttAllowance.project.offTitle")} data-allowance="off">
        {t("mqttAllowance.project.off", { project })}
      </Alert>
    );
  }
  const number = new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language ?? "en");
  const full = data.brokers.left === 0;
  return (
    <Card>
      <section aria-labelledby="mqtt-allowance" className="flex flex-col gap-3" data-allowance="on">
        <h2 id="mqtt-allowance" className="text-title font-semibold text-fg">
          {t("mqttAllowance.project.title")}
        </h2>
        <p className="text-body text-fg" data-allowance-left="">
          {t("mqttAllowance.project.left", {
            used: data.brokers.used,
            limit: data.brokers.limit,
            connections: number.format(data.connections.left),
            connectionsLimit: number.format(data.connections.limit),
            rate: number.format(data.messagesPerSecond.left),
          })}
        </p>
        <ul className="flex flex-wrap gap-2" aria-label={t("mqttAllowance.project.modes")}>
          {data.modes.map((mode) => (
            <li key={mode}>
              <Badge tone="neutral">{t(`mqttAllowance.modeLong.${mode}`, { defaultValue: mode })}</Badge>
            </li>
          ))}
        </ul>
        <p className="text-caption text-fg-muted">
          {t("mqttAllowance.project.addresses", {
            addresses: data.addresses.map((address) => t(`mqttAllowance.address.${address}`, { defaultValue: address })).join(", "),
          })}
          {data.ports.length > 0 ? ` ${t("mqttAllowance.project.ports", { ports: data.ports.join(", ") })}` : ""}
        </p>
        {full ? (
          <Alert tone="warning" data-allowance="full">
            {t("mqttAllowance.project.full", { limit: data.brokers.limit })}
          </Alert>
        ) : null}
      </section>
    </Card>
  );
}

/**
 * What the broker measures (T-4043, API/01 §44): publishers connected and messages per second,
 * read by the Portal from the broker itself. A broker that did not answer is "not measured" with
 * the reason, never a zero.
 */
function Measurement({ measured, failed }: { measured?: Measured; failed: boolean }): JSX.Element {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language ?? "en", { maximumFractionDigits: 1 });
  if (!measured) return <>{failed ? t("mqttbrokers.measured.not") : t("app.loading")}</>;
  if (!measured.measured) {
    return (
      <span className="flex flex-wrap items-center gap-2" data-measured="no">
        <Badge tone="neutral">{t("mqttbrokers.measured.not")}</Badge>
        {measured.reason ? <span className="text-caption text-fg-muted">{measured.reason}</span> : null}
      </span>
    );
  }
  return (
    <span data-measured="yes">
      {t("mqttbrokers.measured.summary", {
        publishers: measured.publishers ?? 0,
        rate: measured.messagesPerSecond == null ? "—" : number.format(measured.messagesPerSecond),
      })}
    </span>
  );
}

/** The connected clients of a role's accounts, each with the time the newest one connected. */
function Connected({ accounts, measured }: { accounts: string[]; measured?: Measured }): JSX.Element {
  const { t, i18n } = useTranslation();
  if (!measured?.measured) return <>—</>;
  const time = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language ?? "en", {
    dateStyle: "short",
    timeStyle: "short",
  });
  return (
    <ul className="flex flex-col gap-0.5">
      {accounts.map((account) => {
        const seen = measured.accounts.find((entry) => entry.serviceAccount === account);
        const count = seen?.connected ?? 0;
        return (
          <li key={account} data-account={account}>
            {count > 0 && seen?.since
              ? t("mqttbrokers.measured.since", { account, count, since: time.format(new Date(seen.since)) })
              : t("mqttbrokers.measured.count", { account, count })}
          </li>
        );
      })}
    </ul>
  );
}

function Filters({ filters }: { filters?: string[] }): JSX.Element {
  return filters && filters.length > 0 ? (
    <ul className="flex flex-col gap-0.5">
      {filters.map((filter) => (
        <li key={filter}>
          <code className="font-mono text-caption">{filter}</code>
        </li>
      ))}
    </ul>
  ) : (
    <>—</>
  );
}

/** Device → broker → data source → pipeline → Endpoint → Policy, one row per edge. */
function Connections({ project, brokers }: { project: string; brokers: Manifest[] }): JSX.Element {
  const { t } = useTranslation();
  const dataSources = useReadableList(project, "datasources", "DataSource");
  const pipelines = useReadableList(project, "pipelines", "Pipeline");
  const endpoints = useReadableList(project, "endpoints", "Endpoint");
  const policies = useReadableList(project, "policies", "Policy");
  const accounts = useReadableList(project, "serviceaccounts", "ServiceAccount");
  const lists = [dataSources, pipelines, endpoints, policies, accounts];
  const of = (query: (typeof lists)[number]) => asManifests(query.data?.items ?? []);
  const edges = lists.some((query) => query.isPending)
    ? []
    : connectionsOf({
        project,
        brokers,
        dataSources: of(dataSources),
        pipelines: of(pipelines),
        endpoints: of(endpoints),
        policies: of(policies),
        accounts: of(accounts),
      });
  const hidden = lists.some((query) => query.hidden);
  return (
    <section aria-labelledby="mqtt-connections" className="flex flex-col gap-3">
      <h2 id="mqtt-connections" className="text-title font-semibold text-fg">
        {t("mqttbrokers.connections.title")}
      </h2>
      <p className="text-body text-fg-muted">
        {t("mqttbrokers.connections.lead")}
        {hidden ? ` ${t("mqttbrokers.connections.partial")}` : ""}
      </p>
      <Table caption={t("mqttbrokers.connections.title")}>
        <TableHead>
          <TableHeaderCell>{t("mqttbrokers.connections.edge")}</TableHeaderCell>
          <TableHeaderCell>{t("mqttbrokers.connections.from")}</TableHeaderCell>
          <TableHeaderCell>{t("mqttbrokers.connections.to")}</TableHeaderCell>
          <TableHeaderCell>{t("mqttbrokers.connections.allowedBy")}</TableHeaderCell>
          <TableHeaderCell>{t("mqttbrokers.connections.state")}</TableHeaderCell>
        </TableHead>
        <TableBody>
          {edges.map((edge, index) => (
            <EdgeRow key={`${edge.kind}-${edge.from}-${edge.to}-${index}`} project={project} edge={edge} />
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function EdgeRow({ project, edge }: { project: string; edge: Edge }): JSX.Element {
  const { t } = useTranslation();
  return (
    <TableRow data-edge={edge.problem ? "red" : "green"}>
      <TableCell>{t(`mqttbrokers.connections.kind.${edge.kind}`)}</TableCell>
      <TableCell primary>{edge.from}</TableCell>
      <TableCell>{edge.to || "—"}</TableCell>
      <TableCell>{t(edge.allowedBy.key, edge.allowedBy.values)}</TableCell>
      <TableCell>
        {edge.problem ? (
          <span className="flex flex-col gap-1">
            <Badge tone="danger">{t(edge.problem.key, edge.problem.values)}</Badge>
            {edge.fix ? (
              edge.fix.name ? (
                <RecordLink project={project} plural={edge.fix.plural} name={edge.fix.name}>
                  {t("mqttbrokers.connections.fix")}
                </RecordLink>
              ) : (
                <Link
                  to="/projects/$project/$plural"
                  params={{ project, plural: edge.fix.plural }}
                  className={RECORD_LINK_STYLE}
                >
                  {t("mqttbrokers.connections.fix")}
                </Link>
              )
            ) : null}
          </span>
        ) : (
          <Badge tone="success">{t("mqttbrokers.connections.ok")}</Badge>
        )}
      </TableCell>
    </TableRow>
  );
}
