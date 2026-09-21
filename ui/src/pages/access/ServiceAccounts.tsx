import { useState } from "react";
import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap } from "../../api/client";
import { asManifests, isChange, localized, storedMetadata } from "../../api/manifest";
import { usePermissions } from "../../api/permissions";
import { useIdentity } from "../../auth/AuthProvider";
import { DeleteResourceAction } from "../../components/DeleteResourceDialog";
import { EditResourceAction } from "../../components/EditResourceDialog";
import { ChangeNotice } from "../../components/ChangeNotice";
import { ResourceFormDialog } from "../../components/ResourceFormDialog";
import { PermissionGuard } from "../../components/ui/PermissionGuard";
import { proposeChecked } from "../../api/proposal";
import {
  ROLE_SCOPE_LEVELS,
  serviceAccountSchema,
  serviceAccountUiSchema,
} from "../../schemas/kinds";
import {
  Alert,
  Button,
  Card,
  Dialog,
  Field,
  Icon,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  Skeleton,
  TableRow,
  TableSkeleton,
} from "../../components/ui";
import type { Identity } from "../../auth/AuthProvider";
import type { Change, Manifest } from "../../api/manifest";
import type { components } from "../../api/schema";

type KeyInfo = components["schemas"]["KeyInfo"];
type MintedKey = components["schemas"]["MintedKey"];

interface Credential {
  kind?: string;
  name?: string;
  expiresAt?: string;
}

interface ServiceAccountSpec {
  owner?: { user?: string };
  purpose?: string;
  roles?: { role?: string; scope?: Record<string, string>; types?: string[] }[];
  credentials?: Credential[];
}

/** One grant as the form holds it: the scope is a level and a name, not three optional boxes. */
export interface ServiceAccountGrant {
  role: string;
  scope: { level: (typeof ROLE_SCOPE_LEVELS)[number]; name: string };
  operations?: string[];
  types?: string[];
}

export interface ServiceAccountForm {
  name: string;
  purpose: string;
  owner: { user: string };
  roles: ServiceAccountGrant[];
  credentials: { kind: string; name: string; expiresAt?: string; ipAllowList?: string[] }[];
  limits?: { requestsPerMinute?: number };
  workload?: { kubernetes?: { namespace?: string; serviceAccount?: string } };
}

/** A list without blank entries, or nothing: the manifest reads as what it grants. */
function filled(values: string[] | undefined): string[] | undefined {
  const kept = (values ?? []).map((value) => value.trim()).filter((value) => value !== "");
  return kept.length > 0 ? kept : undefined;
}

/**
 * The form as the manifest the API stores. `stored` is the manifest an edit started from; its
 * title, description and labels travel on, because the form has no field for them.
 */
export function toServiceAccountEnvelope(
  project: string,
  form: ServiceAccountForm,
  stored?: unknown,
): unknown {
  const kubernetes = form.workload?.kubernetes;
  const perMinute = form.limits?.requestsPerMinute;
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "ServiceAccount",
    metadata: { ...storedMetadata(stored), name: form.name, namespace: project },
    spec: {
      owner: { user: form.owner.user.trim() },
      purpose: form.purpose.trim(),
      roles: form.roles.map((grant) => {
        const operations = filled(grant.operations);
        const types = filled(grant.types);
        return {
          role: grant.role,
          scope: { [grant.scope.level]: grant.scope.name },
          ...(operations ? { operations } : {}),
          ...(types ? { types } : {}),
        };
      }),
      credentials: form.credentials.map((credential) => {
        const ipAllowList = filled(credential.ipAllowList);
        return {
          kind: credential.kind,
          name: credential.name,
          ...(credential.expiresAt?.trim() ? { expiresAt: credential.expiresAt.trim() } : {}),
          ...(ipAllowList ? { ipAllowList } : {}),
        };
      }),
      ...(perMinute !== undefined ? { limits: { requestsPerMinute: perMinute } } : {}),
      ...(kubernetes?.namespace && kubernetes.serviceAccount
        ? {
            workload: {
              kubernetes: {
                namespace: kubernetes.namespace,
                serviceAccount: kubernetes.serviceAccount,
              },
            },
          }
        : {}),
    },
  };
}

/** The stored manifest back as the form: the same pair, so the YAML view and the fields agree. */
export function fromServiceAccountEnvelope(manifest: unknown): ServiceAccountForm {
  const envelope = (manifest ?? {}) as { metadata?: { name?: string }; spec?: Record<string, unknown> };
  const spec = envelope.spec ?? {};
  const roles = (spec.roles as Record<string, unknown>[] | undefined) ?? [];
  return {
    name: envelope.metadata?.name ?? "",
    purpose: (spec.purpose as string | undefined) ?? "",
    owner: { user: ((spec.owner as { user?: string } | undefined)?.user) ?? "" },
    roles: roles.map((grant) => {
      const scope = (grant.scope as Record<string, string | null | undefined> | undefined) ?? {};
      // jc-core admits exactly one level, so the first one written is the one there is.
      const level = ROLE_SCOPE_LEVELS.find((candidate) => scope[candidate]) ?? "project";
      return {
        role: (grant.role as string | undefined) ?? "",
        scope: { level, name: scope[level] ?? "" },
        ...(grant.operations ? { operations: grant.operations as string[] } : {}),
        ...(grant.types ? { types: grant.types as string[] } : {}),
      };
    }),
    credentials: ((spec.credentials as ServiceAccountForm["credentials"] | undefined) ?? []).map(
      (credential) => ({ ...credential }),
    ),
    ...(spec.limits ? { limits: spec.limits as ServiceAccountForm["limits"] } : {}),
    ...(spec.workload ? { workload: spec.workload as ServiceAccountForm["workload"] } : {}),
  };
}

/** `api-key` credentials only: an `oauth-client` lives in Keycloak and has no key here. */
function apiKeyCredentials(spec: ServiceAccountSpec): Credential[] {
  return (spec.credentials ?? []).filter((credential) => credential.kind === "api-key");
}

/** The account is the caller's own: its owner is their username or their email. */
function ownedBy(spec: ServiceAccountSpec, identity: Identity | null): boolean {
  const owner = spec.owner?.user ?? "";
  return owner !== "" && identity !== null && (owner === identity.username || owner === identity.email);
}

function formatDate(value: string | null | undefined, locale: string): string {
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString(locale);
}

/**
 * The raw token, once. Everything about this dialog is built so that a person who closes it
 * without copying has lost the secret: there is no second read, and the Portal never had it
 * after the answer (PF-36).
 */
function TokenDialog({
  minted,
  onClose,
}: {
  minted: MintedKey | null;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  return (
    <Dialog
      open={minted !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onClose();
        }
      }}
      title={t("access.keys.newTitle")}
      description={t("access.keys.newHint")}
      size="lg"
      closeLabel={t("access.keys.done")}
    >
      <div className="flex flex-col gap-4">
        <Alert role="alert" tone="danger">
          {t("access.keys.onceWarning")}
        </Alert>

        <Field id="minted-token" label={t("access.keys.token")}>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="minted-token"
              readOnly
              value={minted?.token ?? ""}
              onFocus={(event) => event.currentTarget.select()}
              className="flex-1 font-mono text-caption"
            />
            <Button
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(minted?.token ?? "")
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? t("endpoints.copied") : t("access.keys.copy")}
            </Button>
          </div>
        </Field>
      </div>
    </Dialog>
  );
}

/** The keys of one account: what exists, when it stops working, and the three actions on it. */
function KeyTable({
  project,
  account,
  credentials,
  onMinted,
  onError,
}: {
  project: string;
  account: string;
  credentials: Credential[];
  onMinted: (minted: MintedKey) => void;
  onError: (message: string | null) => void;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "sk";
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);

  const keysKey = [...queryKeys.resource(project, "serviceaccounts", account), "keys"];
  const keys = useQuery({
    queryKey: keysKey,
    retry: false,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/serviceaccounts/{name}/keys", {
          params: { path: { project, name: account } },
        }),
      ),
  });

  const failed = (err: unknown) => {
    onError(
      err instanceof ApiError ? (err.problem?.detail ?? err.message) : t("app.error.generic"),
    );
  };
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keysKey });
  };

  const create = useMutation({
    mutationFn: async (credential: string) => {
      onError(null);
      return unwrap(
        await api.POST("/api/v1/projects/{project}/serviceaccounts/{name}/keys", {
          params: { path: { project, name: account } },
          body: { credential },
        }),
      );
    },
    onSuccess: (minted) => {
      onMinted(minted);
      refresh();
    },
    onError: failed,
  });

  const rotate = useMutation({
    mutationFn: async (keyId: string) => {
      onError(null);
      return unwrap(
        await api.POST(
          "/api/v1/projects/{project}/serviceaccounts/{name}/keys/{keyId}/rotate",
          { params: { path: { project, name: account, keyId } }, body: {} },
        ),
      );
    },
    onSuccess: (minted) => {
      onMinted(minted);
      refresh();
    },
    onError: failed,
  });

  const revoke = useMutation({
    mutationFn: async (keyId: string) => {
      onError(null);
      const result = await api.DELETE(
        "/api/v1/projects/{project}/serviceaccounts/{name}/keys/{keyId}",
        { params: { path: { project, name: account, keyId } } },
      );
      if (result.error) {
        await unwrap(result as { error?: unknown; response: Response });
      }
      return keyId;
    },
    onSuccess: () => {
      setConfirming(null);
      refresh();
    },
    onError: failed,
  });

  const items: KeyInfo[] = keys.data?.items ?? [];
  const busy = create.isPending || rotate.isPending || revoke.isPending;

  return (
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {credentials.length === 0 ? (
          <p className="text-body text-fg-muted">{t("access.keys.noCredential")}</p>
        ) : (
          credentials.map((credential) => (
            <Button
              key={credential.name}
              disabled={busy}
              variant="primary"
              onClick={() => create.mutate(credential.name ?? "")}
            >
              {t("access.keys.create", { credential: credential.name })}
            </Button>
          ))
        )}
      </div>

      {/* A key list that could not be read is not "this account has no keys" (T-1763): one of
          the two means somebody has to rotate a credential and the other does not. */}
      {keys.isError ? (
        <Alert
          role="alert"
          tone="danger"
          actions={
            <Button size="sm" onClick={() => void keys.refetch()}>
              {t("app.error.retry")}
            </Button>
          }
        >
          {keys.error instanceof ApiError && keys.error.status === 503
            ? t("access.keys.noStore")
            : keys.error instanceof ApiError
              ? (keys.error.problem?.detail ?? keys.error.message)
              : t("app.error.generic")}
        </Alert>
      ) : items.length === 0 ? (
        <p className="text-body text-fg-muted">{t("access.keys.empty")}</p>
      ) : (
        <Table caption={t("access.keys.tableCaption", { account })}>
          <TableHead>
            <TableHeaderCell>{t("access.keys.field.keyId")}</TableHeaderCell>
            <TableHeaderCell>{t("access.keys.field.credential")}</TableHeaderCell>
            <TableHeaderCell>{t("access.keys.field.expires")}</TableHeaderCell>
            <TableHeaderCell>{t("access.keys.field.lastUsed")}</TableHeaderCell>
            <TableHeaderCell align="right">{t("approvals.actions")}</TableHeaderCell>
          </TableHead>
          {/* T-1053: the keys table reads like its siblings while it loads — a skeleton rather
              than an empty frame that looks like an account with no keys. */}
          {keys.isPending ? (
            <TableSkeleton columns={5} />
          ) : (
          <TableBody>
            {items.map((key) => (
              <TableRow key={key.keyId}>
                <TableCell primary className="font-mono text-caption">
                  {key.keyId}
                </TableCell>
                <TableCell>{key.credential}</TableCell>
                <TableCell>
                  {key.revokedAt
                    ? t("access.keys.revoked", { date: formatDate(key.revokedAt, locale) })
                    : (formatDate(key.expiresAt, locale) || t("access.keys.never"))}
                </TableCell>
                <TableCell>
                  {formatDate(key.lastUsedAt, locale) || t("access.keys.neverUsed")}
                </TableCell>
                <TableCell align="right">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {key.revokedAt ? null : (
                      <>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => rotate.mutate(key.keyId)}
                          title={t("access.keys.rotateHint")}
                        >
                          {t("access.keys.rotate")}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          onClick={() => setConfirming(key.keyId)}
                        >
                          {t("access.keys.revoke")}
                        </Button>
                      </>
                    )}
                  </div>
                  {confirming === key.keyId ? (
                    <div
                      role="alertdialog"
                      aria-label={t("access.keys.revokeConfirm", { keyId: key.keyId })}
                      className="mt-2 flex flex-wrap items-center justify-end gap-2 rounded border border-danger bg-danger-soft p-2 text-caption"
                    >
                      <span>{t("access.keys.revokeConfirm", { keyId: key.keyId })}</span>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        onClick={() => revoke.mutate(key.keyId)}
                      >
                        {t("access.keys.revokeNow")}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => setConfirming(null)}
                      >
                        {t("form.cancel")}
                      </Button>
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          )}
        </Table>
      )}
    </div>
  );
}

/** Every non-human caller of one project: who owns it, what it may do, and its credentials. */
export function ServiceAccounts({ project }: { project: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "sk";
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<ServiceAccountForm | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [change, setChange] = useState<Change | null>(null);
  const identity = useIdentity();
  const queryClient = useQueryClient();
  // The API answers keys only to the owner or someone who may propose service accounts; the
  // view asks only for those, so nobody else sees a refused request.
  const mayChange = usePermissions(project).can("ServiceAccount", "propose");
  const schema = serviceAccountSchema(t, [project]);

  const create = useMutation({
    mutationFn: async (next: ServiceAccountForm) => {
      setFormError(null);
      return proposeChecked(
        project,
        "serviceaccounts",
        toServiceAccountEnvelope(project, next) as { metadata: { name: string } },
        true,
      );
    },
    onSuccess: (result) => {
      if (isChange(result)) {
        setChange(result);
      }
      setDialogOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.list(project, "serviceaccounts") });
    },
    onError: (err) => {
      setFormError(
        err instanceof ApiError
          ? (err.problem?.detail ?? err.message)
          : err instanceof Error
            ? err.message
            : t("app.error.generic"),
      );
    },
  });

  const addButton = (
    <PermissionGuard project={project} kind="ServiceAccount" verb="propose">
      <Button
        variant="primary"
        icon={<Icon name="plus" className="size-4" />}
        onClick={() => {
          setFormError(null);
          // A new account starts owned by the person creating it, which is who answers for it
          // until somebody else is named (PF-34); a grant on this project is the usual first one.
          setForm({
            name: "",
            purpose: "",
            owner: { user: identity?.email ?? identity?.username ?? "" },
            roles: [{ role: "", scope: { level: "project", name: project } }],
            credentials: [{ kind: "oauth-client", name: "" }],
          });
          setDialogOpen(true);
        }}
      >
        {t("access.accounts.add")}
      </Button>
    </PermissionGuard>
  );

  const list = useQuery({
    queryKey: queryKeys.list(project, "serviceaccounts"),
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project, plural: "serviceaccounts" } },
        }),
      ),
  });

  if (list.isPending) {
    return (
      <div role="status" aria-busy="true" aria-label={t("app.loading")} className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (list.isError) {
    return (
      <Alert
        role="alert"
        tone="danger"
        actions={
          <Button size="sm" onClick={() => void list.refetch()}>
            {t("app.error.retry")}
          </Button>
        }
      >
        {list.error instanceof ApiError
          ? (list.error.problem?.detail ?? list.error.message)
          : t("app.error.generic")}
      </Alert>
    );
  }

  const accounts: Manifest[] = asManifests(list.data.items ?? []);

  return (
    <section className="space-y-4" aria-labelledby="service-accounts-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="service-accounts-heading" className="text-title font-semibold text-fg">
          {t("access.accounts.title")}
        </h2>
        {addButton}
      </div>

      {change ? <ChangeNotice change={change} project={project} /> : null}

      {error ? (
        <Alert role="alert" tone="danger">
          {error}
        </Alert>
      ) : null}

      {accounts.length === 0 ? (
        <p className="text-body text-fg-muted">{t("access.accounts.empty")}</p>
      ) : (
        <ul className="space-y-4">
          {accounts.map((account) => {
            const spec = account.spec as ServiceAccountSpec;
            const accountTarget = {
              project,
              kind: "ServiceAccount",
              plural: "serviceaccounts",
              name: account.metadata.name,
              label: localized(account.metadata.title, locale, account.metadata.name),
            };
            return (
              <li key={account.metadata.name}>
                <Card>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="font-medium text-fg">
                      {localized(account.metadata.title, locale, account.metadata.name)}
                    </h3>
                    {account.metadata.title ? (
                      <span className="font-mono text-caption text-fg-muted">
                        {account.metadata.name}
                      </span>
                    ) : null}
                    <span className="flex items-center gap-1.5">
                      <EditResourceAction
                        target={accountTarget}
                        form={{
                          schema,
                          uiSchema: serviceAccountUiSchema,
                          fromManifest: (manifest) =>
                            fromServiceAccountEnvelope(manifest) as unknown as Record<string, unknown>,
                          toManifest: (edited) =>
                            toServiceAccountEnvelope(
                              project,
                              edited as unknown as ServiceAccountForm,
                              account,
                            ),
                        }}
                      />
                      <DeleteResourceAction target={accountTarget} />
                    </span>
                  </div>
                  <dl className="mt-2 grid gap-x-6 gap-y-1 text-body sm:grid-cols-2">
                    <div className="flex gap-2">
                      <dt className="text-fg-muted">{t("access.accounts.owner")}</dt>
                      <dd className="font-medium text-fg">{spec.owner?.user ?? ""}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-fg-muted">{t("access.accounts.roles")}</dt>
                      <dd className="font-medium text-fg">
                        {(spec.roles ?? [])
                          .map((role) => role.role)
                          .filter(Boolean)
                          .join(", ")}
                      </dd>
                    </div>
                    {spec.purpose ? (
                      <div className="flex gap-2 sm:col-span-2">
                        <dt className="text-fg-muted">{t("access.accounts.purpose")}</dt>
                        <dd className="text-fg">{spec.purpose}</dd>
                      </div>
                    ) : null}
                  </dl>

                  {mayChange || ownedBy(spec, identity) ? (
                    <KeyTable
                      project={project}
                      account={account.metadata.name}
                      credentials={apiKeyCredentials(spec)}
                      onMinted={setMinted}
                      onError={setError}
                    />
                  ) : (
                    <p className="mt-3 text-body text-fg-muted">{t("access.keys.notYours")}</p>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <TokenDialog minted={minted} onClose={() => setMinted(null)} />

      <ResourceFormDialog<ServiceAccountForm>
        kind="ServiceAccount"
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={t("access.accounts.add")}
        description={t("access.accounts.addHint")}
        schema={schema}
        uiSchema={serviceAccountUiSchema}
        formData={form}
        onChange={setForm}
        project={project}
        draftKind="ServiceAccount"
        plural="serviceaccounts"
        source={{
          toManifest: (next) => toServiceAccountEnvelope(project, next),
          fromManifest: (manifest) => fromServiceAccountEnvelope(manifest),
        }}
        submitLabel={t("access.accounts.propose")}
        submitting={create.isPending}
        error={formError}
        onSubmit={(next) => create.mutate(next)}
      />
    </section>
  );
}
