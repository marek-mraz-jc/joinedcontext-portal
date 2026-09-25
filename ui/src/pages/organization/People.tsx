import { useId, useState } from "react";
import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap } from "../../api/client";
import { ORG_NAMESPACE } from "../../api/manifest";
import type { Change } from "../../api/manifest";
import { mayRead, usePermissions } from "../../api/permissions";
import type { Verb } from "../../api/permissions";
import type { components } from "../../api/schema";
import { ChangeNotice } from "../../components/ChangeNotice";
import { FormFrame, useCreateForm } from "../../components/forms/FormRoute";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableSkeleton,
} from "../../components/ui";
import { PermissionGuard } from "../../components/ui/PermissionGuard";
import { asUser } from "../apps/RolesAndMembers";

type Person = components["schemas"]["Person"];
type PersonDetail = components["schemas"]["PersonDetail"];

/** The languages a person may be given, the ones the Portal speaks (UI-09). */
const LOCALES = ["en", "sk", "cs", "de"] as const;
const PAGE = 50;

/** What a failed request says, in the server's words when it gave any. */
function reasonOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.problem?.detail ?? error.message) : fallback;
}

function fullName(person: Person): string {
  return `${person.firstName} ${person.lastName}`.trim() || person.email;
}

function when(iso: string | null | undefined, locale: string): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? null
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
}

/**
 * The people a group's member field offers (T-2685): the first page of the realm, for a caller
 * who may read people at all. Typing an address stays possible; the list is a choice, not a wall.
 */
export function usePeopleChoices(): string[] {
  const permissions = usePermissions(ORG_NAMESPACE);
  const reads = mayRead(permissions.data, "Person") === true;
  const people = useQuery({
    queryKey: queryKeys.peoplePage("", 0),
    enabled: reads,
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/organization/people", { params: { query: { max: 100 } } })),
  });
  return (people.data?.items ?? []).filter((person) => person.enabled).map((person) => person.email);
}

/**
 * The one-time temporary password (PF-92): shown once, in a field to copy, with the warning that
 * nobody can show it again. It lives in this dialog's props and nowhere else — no storage, no
 * address, no console — and closing the dialog drops it from the page.
 */
export function OneTimePassword({
  secret,
  onClose,
}: {
  secret: { email: string; password: string } | null;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const field = useId();
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      open={secret !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onClose();
        }
      }}
      title={t("organization.people.password.title")}
      description={secret ? t("organization.people.password.lead", { email: secret.email }) : undefined}
      closeLabel={t("app.close")}
      footer={
        <Button
          onClick={() => {
            setCopied(false);
            onClose();
          }}
        >
          {t("organization.people.password.done")}
        </Button>
      }
    >
      {secret ? (
        <div className="space-y-3">
          <Alert tone="warning">{t("organization.people.password.warning")}</Alert>
          <Field id={field} label={t("organization.people.password.label")}>
            <Input
              id={field}
              readOnly
              value={secret.password}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              onFocus={(event) => event.currentTarget.select()}
            />
          </Field>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(secret.password).then(() => setCopied(true));
            }}
          >
            {t("organization.people.password.copy")}
          </Button>
          <p role="status" className="text-caption text-fg-muted">
            {copied ? t("organization.people.password.copied") : ""}
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}

interface PersonForm {
  email: string;
  firstName: string;
  lastName: string;
  locale: string;
}

type FormErrors = Partial<Record<keyof PersonForm, string>>;

function validate(form: PersonForm, t: (key: string) => string): FormErrors {
  const errors: FormErrors = {};
  if (asUser(form.email) === null) errors.email = t("organization.people.form.emailInvalid");
  if (form.firstName.trim() === "") errors.firstName = t("organization.people.form.required");
  if (form.lastName.trim() === "") errors.lastName = t("organization.people.form.required");
  return errors;
}

/** The fields of a person, the same in the new-person form and in the edit dialog. */
function PersonFields({
  form,
  errors,
  onChange,
}: {
  form: PersonForm;
  errors: FormErrors;
  onChange: (form: PersonForm) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const id = useId();
  const text = (key: "email" | "firstName" | "lastName", type: string, example: string, auto: string) => (
    <Field
      id={`${id}-${key}`}
      label={t(`organization.people.form.${key}`)}
      description={t(`organization.people.form.${key}Help`)}
      required
      errors={errors[key] ? [errors[key]] : undefined}
    >
      <Input
        id={`${id}-${key}`}
        type={type}
        autoComplete={auto}
        placeholder={example}
        value={form[key]}
        onChange={(event) => onChange({ ...form, [key]: event.target.value })}
      />
    </Field>
  );
  return (
    <div className="space-y-4">
      {text("email", "email", "firstname.lastname@example.org", "off")}
      {text("firstName", "text", "Jana", "off")}
      {text("lastName", "text", "Nováková", "off")}
      <Field
        id={`${id}-locale`}
        label={t("organization.people.form.locale")}
        description={t("organization.people.form.localeHelp")}
      >
        <Select
          id={`${id}-locale`}
          value={form.locale}
          onChange={(event) => onChange({ ...form, locale: event.target.value })}
        >
          <option value="">{t("organization.people.form.localeRealm")}</option>
          {LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {t(`organization.people.language.${locale}`)}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

const EMPTY: PersonForm = { email: "", firstName: "", lastName: "", locale: "" };

/** New person, a routed form (UI-27): the realm e-mails the invitation, or hands a password once. */
function NewPersonForm({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (created: components["schemas"]["CreatedPerson"]) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const formId = useId();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<PersonForm>(EMPTY);
  const [tried, setTried] = useState(false);
  const errors = tried ? validate(form, t) : {};

  const create = useMutation({
    // The answer may carry the temporary password: it is not kept in the mutation cache.
    gcTime: 0,
    mutationFn: async (person: PersonForm) =>
      unwrap(
        await api.POST("/api/v1/organization/people", {
          body: {
            email: person.email.trim(),
            firstName: person.firstName.trim(),
            lastName: person.lastName.trim(),
            ...(person.locale ? { locale: person.locale } : {}),
          },
        }),
      ),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.people() });
      close(false);
      onCreated(created);
    },
  });

  const close = (next: boolean) => {
    if (!next) {
      setForm(EMPTY);
      setTried(false);
      create.reset();
    }
    onOpenChange(next);
  };

  return (
    <FormFrame
      open={open}
      onOpenChange={close}
      title={t("organization.people.newTitle")}
      description={t("organization.people.newLead")}
      closeLabel={t("app.close")}
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)}>
            {t("app.cancel")}
          </Button>
          <Button type="submit" form={formId} disabled={create.isPending}>
            {t("organization.people.create")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (Object.keys(validate(form, t)).length === 0) create.mutate(form);
        }}
      >
        <PersonFields form={form} errors={errors} onChange={setForm} />
        {create.error ? (
          <Alert tone="danger" role="alert">
            {reasonOf(create.error, t("app.error.generic"))}
          </Alert>
        ) : null}
      </form>
    </FormFrame>
  );
}

/**
 * Organization → People (PF-90, UI-75, ADR-N-031): the people of the realm, searched and paged,
 * and the form that invites a new one. A person is not a manifest: these requests go to the
 * realm's admin API through the Portal, each held to its verb on `Person`, and what a person may
 * do stays with the bindings and groups that name them.
 */
export function People(): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";
  const permissions = usePermissions(ORG_NAMESPACE);
  const reads = mayRead(permissions.data, "Person");
  const searchField = useId();
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [first, setFirst] = useState(0);
  const [writing, setWriting] = useCreateForm();
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [invited, setInvited] = useState<string | null>(null);

  const people = useQuery({
    queryKey: queryKeys.peoplePage(search, first),
    enabled: reads === true,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/organization/people", {
          params: { query: { ...(search ? { search } : {}), first, max: PAGE } },
        }),
      ),
  });

  if (permissions.isLoading) {
    return (
      <p role="status" className="text-body text-fg-muted">
        {t("app.loading")}
      </p>
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="people-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="people-heading" className="text-title font-semibold text-fg">
            {t("organization.people.title")}
          </h2>
          <p className="text-body text-fg-muted">{t("organization.people.lead")}</p>
        </div>
        <PermissionGuard project={ORG_NAMESPACE} kind="Person" verb="create">
          <Button onClick={() => setWriting(true)}>{t("organization.people.new")}</Button>
        </PermissionGuard>
      </div>

      {invited ? (
        <Alert tone="success" role="status">
          {t("organization.people.invited", { email: invited })}
        </Alert>
      ) : null}

      {reads !== true ? (
        <Alert tone="info">{t("organization.people.hidden")}</Alert>
      ) : (
        <>
          <form
            role="search"
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setFirst(0);
              setSearch(typed.trim());
            }}
          >
            <Field id={searchField} label={t("organization.people.search")}>
              <Input
                id={searchField}
                type="search"
                value={typed}
                placeholder={t("organization.people.searchPlaceholder")}
                onChange={(event) => setTyped(event.target.value)}
              />
            </Field>
            <Button type="submit" variant="secondary" size="sm">
              {t("organization.people.searchButton")}
            </Button>
          </form>

          {people.error ? (
            <Alert tone="danger" role="alert">
              {reasonOf(people.error, t("app.error.generic"))}
            </Alert>
          ) : (
            <Table
              caption={t("organization.people.caption")}
              status={people.isPending ? t("app.loading") : undefined}
            >
              <TableHead>
                <TableHeaderCell>{t("organization.people.name")}</TableHeaderCell>
                <TableHeaderCell>{t("organization.people.email")}</TableHeaderCell>
                <TableHeaderCell>{t("organization.people.state")}</TableHeaderCell>
                <TableHeaderCell>{t("organization.people.lastSeen")}</TableHeaderCell>
              </TableHead>
              {people.isPending ? (
                <TableSkeleton columns={4} />
              ) : (
                <TableBody>
                  {(people.data?.items ?? []).length === 0 ? (
                    <TableEmpty columns={4}>
                      <EmptyState
                        bare
                        title={search ? t("organization.people.noMatch", { search }) : t("organization.people.empty")}
                      />
                    </TableEmpty>
                  ) : (
                    (people.data?.items ?? []).map((person) => (
                      <TableRow key={person.id}>
                        <TableCell primary>
                          <Link
                            to="/organization/$tab/$"
                            params={{ tab: "people", _splat: encodeURIComponent(person.id) }}
                            className="underline"
                          >
                            {fullName(person)}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-caption">{person.email}</span>
                        </TableCell>
                        <TableCell>
                          <PersonState person={person} />
                        </TableCell>
                        <TableCell>
                          {when(person.lastSeen, locale) ?? (
                            <span className="text-fg-subtle">{t("organization.people.noSession")}</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              )}
            </Table>
          )}

          {first > 0 || people.data?.next != null ? (
            <nav aria-label={t("organization.people.pages")} className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={first === 0}
                onClick={() => setFirst(Math.max(0, first - PAGE))}
              >
                {t("organization.people.previous")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={people.data?.next == null}
                onClick={() => setFirst(people.data?.next ?? first)}
              >
                {t("organization.people.next")}
              </Button>
            </nav>
          ) : null}
        </>
      )}

      <NewPersonForm
        open={writing}
        onOpenChange={setWriting}
        onCreated={(created) => {
          if (created.temporaryPassword) {
            setInvited(null);
            setSecret({ email: created.person.email, password: created.temporaryPassword });
          } else {
            setInvited(created.person.email);
          }
        }}
      />
      <OneTimePassword secret={secret} onClose={() => setSecret(null)} />
    </section>
  );
}

function PersonState({ person }: { person: Person }): JSX.Element {
  const { t } = useTranslation();
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge tone={person.enabled ? "success" : "danger"}>
        {person.enabled ? t("organization.people.enabled") : t("organization.people.disabled")}
      </Badge>
      <Badge tone={person.emailVerified ? "neutral" : "warning"}>
        {person.emailVerified ? t("organization.people.verified") : t("organization.people.unverified")}
      </Badge>
      {person.pendingDeletion ? (
        <Badge tone="warning">{t("organization.people.removalPending")}</Badge>
      ) : null}
    </span>
  );
}

/** The lifecycle actions of a person's page, each with the verb on `Person` it needs (PF-91). */
type Action = "disable" | "enable" | "reset-password" | "remove-second-factor" | "sign-out" | "delete";

const NEEDS: Record<Action, Verb> = {
  disable: "disable",
  enable: "disable",
  "reset-password": "update",
  "remove-second-factor": "disable",
  "sign-out": "disable",
  delete: "delete",
};

type Outcome =
  | { action: Action; change?: Change; password?: string; emailSent?: boolean }
  | { action: "deleted" };

async function perform(id: string, action: Action): Promise<Outcome> {
  const path = { params: { path: { id } } };
  switch (action) {
    case "disable":
      await unwrap(await api.POST("/api/v1/organization/people/{id}/disable", path));
      return { action };
    case "enable":
      await unwrap(await api.POST("/api/v1/organization/people/{id}/enable", path));
      return { action };
    case "reset-password": {
      const reset = await unwrap(await api.POST("/api/v1/organization/people/{id}/reset-password", path));
      return { action, emailSent: reset.emailSent, password: reset.temporaryPassword ?? undefined };
    }
    case "remove-second-factor":
      await unwrap(await api.POST("/api/v1/organization/people/{id}/remove-second-factor", path));
      return { action };
    case "sign-out":
      await unwrap(await api.POST("/api/v1/organization/people/{id}/sign-out", path));
      return { action };
    case "delete": {
      const result = await api.DELETE("/api/v1/organization/people/{id}", path);
      const change = await unwrap(result);
      return result.response.status === 204 ? { action: "deleted" } : { action, change: change as Change };
    }
  }
}

/**
 * A person's page (PF-93, PF-94): who they are, where the realm has them, the groups they are
 * in and the roles those give them, and every lifecycle action. Each action asks first, names
 * what it does, and is disabled with the reason when the caller's role does not allow it; the
 * server still refuses anything the caller may not do to this person, and says why.
 */
export function PersonPage({ id }: { id: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState<Action | null>(null);
  const [editing, setEditing] = useState(false);
  const [done, setDone] = useState<{ text?: string; change?: Change } | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);

  const detail = useQuery({
    queryKey: queryKeys.person(id),
    retry: false,
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/organization/people/{id}", { params: { path: { id } } })),
  });

  const act = useMutation({
    // A reset's answer may carry the temporary password: it is not kept in the mutation cache.
    gcTime: 0,
    mutationFn: (action: Action) => perform(id, action),
    onMutate: () => setDone(null),
    onSuccess: (outcome) => {
      setAsking(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.people() });
      if (outcome.action === "deleted") {
        void navigate({ to: "/organization/$tab", params: { tab: "people" } });
        return;
      }
      if (outcome.password && detail.data) {
        setSecret({ email: detail.data.person.email, password: outcome.password });
      } else if (outcome.change) {
        setDone({ change: outcome.change });
        void queryClient.invalidateQueries({ queryKey: queryKeys.changes(ORG_NAMESPACE) });
      } else {
        setDone({ text: t(`organization.people.done.${outcome.action}`) });
      }
      act.reset();
    },
  });

  if (detail.isPending) {
    return (
      <p role="status" className="text-body text-fg-muted">
        {t("app.loading")}
      </p>
    );
  }
  if (detail.error || !detail.data) {
    return (
      <Alert tone="danger" role="alert">
        {detail.error instanceof ApiError && detail.error.status === 404
          ? t("organization.people.notFound")
          : reasonOf(detail.error, t("app.error.generic"))}
      </Alert>
    );
  }

  const { person, groups, platformRoles, appRoles } = detail.data as PersonDetail;
  const name = fullName(person);
  const actions: Action[] = [
    person.enabled ? "disable" : "enable",
    "reset-password",
    "remove-second-factor",
    "sign-out",
    "delete",
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={name}
        description={person.email}
        actions={
          <Link to="/organization/$tab" params={{ tab: "people" }} className="text-body underline">
            {t("organization.people.back")}
          </Link>
        }
      />
      {done?.change ? <ChangeNotice change={done.change} project={ORG_NAMESPACE} /> : null}
      {done?.text ? (
        <Alert tone="success" role="status">
          {done.text}
        </Alert>
      ) : null}
      {act.error ? (
        <Alert tone="danger" role="alert">
          {reasonOf(act.error, t("app.error.generic"))}
        </Alert>
      ) : null}

      <section aria-labelledby="person-account" className="space-y-3 rounded border border-border p-4">
        <h2 id="person-account" className="text-title font-semibold text-fg">
          {t("organization.people.account")}
        </h2>
        <PersonState person={person} />
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-body">
          <dt className="text-fg-muted">{t("organization.people.form.locale")}</dt>
          <dd>{person.locale ? t(`organization.people.language.${person.locale}`) : t("organization.people.form.localeRealm")}</dd>
          <dt className="text-fg-muted">{t("organization.people.created")}</dt>
          <dd>{when(person.createdAt, locale) ?? "—"}</dd>
          <dt className="text-fg-muted">{t("organization.people.lastSeen")}</dt>
          <dd>{when(person.lastSeen, locale) ?? t("organization.people.noSession")}</dd>
          {person.requiredActions.length > 0 ? (
            <>
              <dt className="text-fg-muted">{t("organization.people.pendingSteps")}</dt>
              <dd>
                {person.requiredActions
                  .map((step) => t(`organization.people.step.${step}`, { defaultValue: step }))
                  .join(", ")}
              </dd>
            </>
          ) : null}
        </dl>
        <div className="flex flex-wrap gap-2">
          <PermissionGuard project={ORG_NAMESPACE} kind="Person" verb="update">
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              {t("organization.people.edit")}
            </Button>
          </PermissionGuard>
          {actions.map((action) => (
            <PermissionGuard key={action} project={ORG_NAMESPACE} kind="Person" verb={NEEDS[action]}>
              <Button
                variant={action === "delete" ? "danger" : "secondary"}
                size="sm"
                disabled={act.isPending || (action === "delete" && Boolean(person.pendingDeletion))}
                disabledReason={
                  action === "delete" && person.pendingDeletion
                    ? t("organization.people.removalPending")
                    : undefined
                }
                onClick={() => setAsking(action)}
              >
                {t(`organization.people.action.${action}`)}
              </Button>
            </PermissionGuard>
          ))}
        </div>
      </section>

      <section aria-labelledby="person-groups" className="space-y-3 rounded border border-border p-4">
        <h2 id="person-groups" className="text-title font-semibold text-fg">
          {t("organization.people.groups")}
        </h2>
        {groups.length === 0 ? (
          <p className="text-body text-fg-muted">{t("organization.people.noGroups")}</p>
        ) : (
          <ul className="space-y-1">
            {groups.map((group) => (
              <li key={group.name}>
                <Link
                  to="/organization/$tab/$"
                  params={{ tab: "groups", _splat: encodeURIComponent(group.name) }}
                  className="underline"
                >
                  {group.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="person-platform" className="space-y-3 rounded border border-border p-4">
        <h2 id="person-platform" className="text-title font-semibold text-fg">
          {t("organization.people.platformRoles")}
        </h2>
        {platformRoles.length === 0 ? (
          <p className="text-body text-fg-muted">{t("organization.people.noRoles")}</p>
        ) : (
          <ul className="space-y-1">
            {platformRoles.map((role) => (
              <li key={`${role.binding}/${role.role}`} className="text-body">
                <Link to="/organization/$tab" params={{ tab: "roles" }} className="font-semibold underline">
                  {role.role}
                </Link>{" "}
                <span className="text-fg-muted">
                  {scopeText(role.scope as Scope, t)} · {viaText(role.via as Via, t)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="person-apps" className="space-y-3 rounded border border-border p-4">
        <h2 id="person-apps" className="text-title font-semibold text-fg">
          {t("organization.people.appRoles")}
        </h2>
        {appRoles.length === 0 ? (
          <p className="text-body text-fg-muted">{t("organization.people.noRoles")}</p>
        ) : (
          <ul className="space-y-1">
            {appRoles.map((role) => (
              <li key={`${role.project}/${role.app}/${role.role}`} className="text-body">
                <Link
                  to="/projects/$project/$plural/$name"
                  params={{ project: role.project, plural: "apps", name: role.app }}
                  className="font-semibold underline"
                >
                  {role.app}
                </Link>{" "}
                <span>{role.role}</span>{" "}
                <span className="text-fg-muted">
                  {t("access.roles.project", { name: role.project })} · {viaText(role.via as Via, t)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        title={asking ? t(`organization.people.confirm.${asking}.title`, { name }) : ""}
        description={asking ? t(`organization.people.confirm.${asking}.body`, { name }) : undefined}
        confirmLabel={asking ? t(`organization.people.action.${asking}`) : ""}
        tone={asking === "delete" || asking === "disable" ? "danger" : "primary"}
        pending={act.isPending}
        onConfirm={() => {
          if (asking) act.mutate(asking);
        }}
      />
      {/* Mounted while open, so it starts from the person as they are now. */}
      {editing ? <EditPersonDialog person={person} open onOpenChange={setEditing} /> : null}
      <OneTimePassword secret={secret} onClose={() => setSecret(null)} />
    </div>
  );
}

interface Scope {
  organization?: string;
  project?: string;
  contextSpace?: string;
}

interface Via {
  user?: string;
  group?: string;
}

function scopeText(scope: Scope | undefined, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (scope?.contextSpace) return t("access.roles.space", { name: scope.contextSpace });
  if (scope?.project) return t("access.roles.project", { name: scope.project });
  return t("access.groupPage.organization");
}

function viaText(via: Via | undefined, t: (key: string, options?: Record<string, unknown>) => string): string {
  return via?.group
    ? t("organization.people.viaGroup", { group: via.group })
    : t("organization.people.direct");
}

/** Edit a person's name, e-mail and language; a changed e-mail is verified again (PF-92). */
function EditPersonDialog({
  person,
  open,
  onOpenChange,
}: {
  person: Person;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const formId = useId();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<PersonForm>({
    email: person.email,
    firstName: person.firstName,
    lastName: person.lastName,
    locale: person.locale ?? "",
  });
  const [tried, setTried] = useState(false);
  const errors = tried ? validate(form, t) : {};

  const edit = useMutation({
    mutationFn: async (next: PersonForm) => {
      const body: components["schemas"]["EditPerson"] = {};
      if (next.email.trim().toLowerCase() !== person.email) body.email = next.email.trim();
      if (next.firstName.trim() !== person.firstName) body.firstName = next.firstName.trim();
      if (next.lastName.trim() !== person.lastName) body.lastName = next.lastName.trim();
      if (next.locale && next.locale !== (person.locale ?? "")) body.locale = next.locale;
      return unwrap(
        await api.PATCH("/api/v1/organization/people/{id}", { params: { path: { id: person.id } }, body }),
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.people() });
      close(false);
    },
  });

  const close = (next: boolean) => {
    if (!next) edit.reset();
    onOpenChange(next);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={t("organization.people.editTitle", { name: fullName(person) })}
      description={t("organization.people.editLead")}
      closeLabel={t("app.close")}
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)}>
            {t("app.cancel")}
          </Button>
          <Button type="submit" form={formId} disabled={edit.isPending}>
            {t("organization.people.save")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (Object.keys(validate(form, t)).length === 0) edit.mutate(form);
        }}
      >
        <PersonFields form={form} errors={errors} onChange={setForm} />
        {edit.error ? (
          <Alert tone="danger" role="alert">
            {reasonOf(edit.error, t("app.error.generic"))}
          </Alert>
        ) : null}
      </form>
    </Dialog>
  );
}
