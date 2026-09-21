import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { HTMLAttributes, JSX, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIsFetching } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Alert, Button, Dialog, Icon, PageHeader, PageLoading } from "../ui";
import type { DialogSize } from "../ui";

/**
 * A bigger form is a page with an address of its own, not a popup (T-2474, UI-27).
 *
 * `/projects/{project}/{plural}/new` opens a kind's create form and
 * `/projects/{project}/{plural}/{name}/edit` its edit form, in the content area under the sidebar
 * and the header. Reloading lands on the same form, the link can be shared, and the browser's
 * back button returns to the list. The addresses carry identifiers only: what the form holds is
 * the person's draft, never the URL.
 *
 * The list pages keep their forms: a page renders its list and its form component as before, and
 * the route around it decides where the form goes. Inside a `FormRouteHost` the form is drawn
 * into the host's slot in place of the list; anywhere else (a component rendered on its own) it
 * stays the dialog it was.
 */
export type FormTarget = { mode: "new" } | { mode: "edit"; name: string };

interface FormRouteValue {
  /** The form the address names, or `null` on the list itself. */
  form: FormTarget | null;
  openNew: () => void;
  openEdit: (name: string) => void;
  /** Back to the list, the way the list was left. */
  close: () => void;
  /**
   * The form saved and is about to close: what the save answered (the change it opened) is shown
   * above the list it goes back to, the way the list pages show their own (UI-23).
   */
  leave: (notice: ReactNode) => void;
  /** Where an open form is drawn. */
  slot: HTMLElement | null;
  /** An open form says so, so the host hides the list while it is there. */
  register: () => () => void;
}

const FormRouteContext = createContext<FormRouteValue | null>(null);

/** The routed form of the page this renders in, or `null` outside a `FormRouteHost`. */
export function useFormRoute(): FormRouteValue | null {
  return useContext(FormRouteContext);
}

/**
 * Whether the kind's create form is open, and the way to open or close it: the address when the
 * page is routed, the component's own state when it is not.
 */
export function useCreateForm(): [boolean, (open: boolean) => void] {
  const route = useFormRoute();
  const [own, setOwn] = useState(false);
  if (!route) {
    return [own, setOwn];
  }
  return [
    route.form?.mode === "new",
    (open) => {
      if (open) {
        route.openNew();
      } else if (route.form !== null) {
        route.close();
      }
    },
  ];
}

/**
 * The edit form of one named resource: open when the address names it. `null` outside a routed
 * page, where the caller keeps its own state.
 */
export function useEditForm(name: string): [boolean, (open: boolean) => void] | null {
  const route = useFormRoute();
  if (!route) {
    return null;
  }
  return [
    route.form?.mode === "edit" && route.form.name === name,
    (open) => {
      if (open) {
        route.openEdit(name);
      } else if (route.form !== null) {
        route.close();
      }
    },
  ];
}

/**
 * For a page that opens its own editor (a data source, a pipeline): the editor the address names,
 * opened once the page's list has answered, since an edit needs the stored resource. A name the
 * list does not hold opens nothing, and the host says so.
 */
export function useOpenFromAddress<T>(
  items: T[] | undefined,
  nameOf: (item: T) => string,
  open: { create: () => void; edit: (item: T) => void },
): void {
  const route = useFormRoute();
  const form = route?.form ?? null;
  // Which address was opened: the list stays mounted while its forms come and go, so the next
  // address opens its own editor.
  const done = useRef<string | null>(null);
  const latest = useRef({ nameOf, open });
  // The page's own callbacks change on every render; the effect below reads the newest ones.
  useEffect(() => {
    latest.current = { nameOf, open };
  });
  const key = form === null ? null : form.mode === "new" ? "new" : `edit:${form.name}`;
  useEffect(() => {
    if (key === null) {
      done.current = null;
      return;
    }
    if (done.current === key || form === null || items === undefined) {
      return;
    }
    if (form.mode === "new") {
      done.current = key;
      latest.current.open.create();
      return;
    }
    const found = items.find((item) => latest.current.nameOf(item) === form.name);
    if (found !== undefined) {
      done.current = key;
      latest.current.open.edit(found);
    }
  }, [key, form, items]);
}

/** Whether a form is drawn as a page, under the page's own `h1`, rather than in a dialog. */
const FormPageContext = createContext(false);

/**
 * A section heading inside a form: one level under the form's title wherever the form is drawn,
 * an `h2` under a page's `h1` and an `h3` under a dialog's `h2`, so the outline has no gap in
 * either (WCAG 1.3.1). `sub` is a heading one level further in.
 */
export function FormHeading({
  sub = false,
  ...props
}: { sub?: boolean } & HTMLAttributes<HTMLHeadingElement>): JSX.Element {
  const page = useContext(FormPageContext);
  const level = (page ? 2 : 3) + (sub ? 1 : 0);
  const Heading = level === 2 ? "h2" : level === 3 ? "h3" : "h4";
  return <Heading {...props} />;
}

export interface FormFrameProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  /** The dialog's width, when the form is drawn as one. */
  size?: DialogSize;
  /** The dialog's close control, when the form is drawn as one. */
  closeLabel: string;
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * The frame of a bigger form: a page in the routed slot, or the dialog it has always been where
 * no route hosts it. Closing the page goes back to the list's own address (the host does that).
 */
export function FormFrame({
  open,
  onOpenChange,
  title,
  description,
  size,
  closeLabel,
  footer,
  children,
}: FormFrameProps): JSX.Element | null {
  const { t } = useTranslation();
  const route = useFormRoute();

  // The address left the form (the browser's back button, a link in the sidebar's section): the
  // form closes with it instead of staying over the list.
  const addressed = route ? route.form !== null : false;
  const wasAddressed = useRef(addressed);
  useEffect(() => {
    if (wasAddressed.current && !addressed && open) {
      onOpenChange(false);
    }
    wasAddressed.current = addressed;
  }, [addressed, open, onOpenChange]);

  const register = route?.register;
  useEffect(() => {
    if (register && open) {
      return register();
    }
    return undefined;
  }, [register, open]);

  // The page takes the focus the way a dialog does, so a keyboard or a screen reader lands on the
  // form it opened and not on the hidden button that opened it.
  const page = useRef<HTMLElement>(null);
  const shown = route !== null && open && route.slot !== null;
  useEffect(() => {
    if (shown) {
      page.current?.focus();
    }
  }, [shown]);

  if (!route) {
    return (
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        description={description}
        size={size}
        closeLabel={closeLabel}
        footer={footer}
      >
        {children}
      </Dialog>
    );
  }
  if (!open || !route.slot) {
    return null;
  }
  return createPortal(
    <section
      ref={page}
      tabIndex={-1}
      data-testid="form-page"
      aria-label={title}
      className="flex flex-col gap-6 focus:outline-none"
      // Escape leaves the form as it left the dialog (UI-47), with whatever question the form
      // asks first. A menu or a list box drawn in a portal handles its own Escape: it is not
      // inside this section, so it closes itself and not the form.
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          event.currentTarget.contains(event.target as Node)
        ) {
          event.preventDefault();
          onOpenChange(false);
        }
      }}
    >
      <div>
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          <Icon name="chevronLeft" className="size-4" />
          {t("form.backToList")}
        </Button>
      </div>
      <PageHeader title={title} description={description} />
      <div className="rounded-xl border border-border bg-surface p-6">
        <FormPageContext.Provider value>{children}</FormPageContext.Provider>
      </div>
      {footer ? <div className="flex flex-wrap items-center justify-end gap-2">{footer}</div> : null}
    </section>,
    route.slot,
  );
}

/**
 * The list page and the slot its forms are drawn in. With a form in the address the list is
 * hidden (and out of the accessibility tree) while the form stands in its place; with a form in
 * the address that nothing opened (a name that is not there, a kind with no such form, an edit
 * the person may not make) the page says so once the page's reads have answered.
 */
export function FormRouteHost({
  project,
  plural,
  form,
  children,
}: {
  project: string;
  plural: string;
  form: FormTarget | null;
  children: ReactNode;
}): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(0);
  const [notice, setNotice] = useState<ReactNode>(null);
  const fetching = useIsFetching();
  // What had the focus when a form opened over the list, given it back once the list is shown.
  // Taken as the form is asked for, while the control that asked still holds the focus: once
  // the list is hidden a browser moves the focus off it.
  const returnTo = useRef<HTMLElement | null>(null);
  const remember = () => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };

  const value = useMemo<FormRouteValue>(
    () => ({
      form,
      openNew: () => {
        remember();
        setNotice(null);
        void navigate({ to: "/projects/$project/$plural/new", params: { project, plural } });
      },
      openEdit: (name) => {
        remember();
        setNotice(null);
        void navigate({
          to: "/projects/$project/$plural/$name/edit",
          params: { project, plural, name },
        });
      },
      close: () => {
        void navigate({ to: "/projects/$project/$plural", params: { project, plural } });
      },
      leave: setNotice,
      slot,
      register: () => {
        setOpen((count) => count + 1);
        return () => setOpen((count) => count - 1);
      },
    }),
    [form, navigate, project, plural, slot],
  );

  const showing = open > 0;
  // The last form closed, by its back control, its Cancel, a saved proposal or a page that
  // dropped its editor: the address leaves the form too, so a reload or the back button does
  // not land on a form that is no longer there. (The browser's back button leaves the address
  // first, and there is nothing left to leave.)
  const wasShowing = useRef(false);
  const addressed = form !== null;
  const close = value.close;
  useEffect(() => {
    const closed = wasShowing.current && !showing;
    wasShowing.current = showing;
    if (!closed) {
      return;
    }
    if (addressed) {
      close();
    }
    const back = returnTo.current;
    returnTo.current = null;
    if (back !== null && back.isConnected && back !== document.body) {
      back.focus();
    }
  }, [showing, addressed, close]);
  return (
    <FormRouteContext.Provider value={value}>
      {/* One block of the page's column, whatever it shows: the column spaces its children, so an
          empty slot beside the list would push the page down by a gap (T-2489). */}
      <div>
        {notice !== null && form === null && !showing ? <div className="mb-4">{notice}</div> : null}
        <div hidden={showing || form !== null}>{children}</div>
        <div ref={setSlot} />
        {form !== null && !showing ? (
          fetching > 0 ? (
            <PageLoading label={t("form.opening")} lines={2} />
          ) : (
            <div className="flex flex-col gap-4">
              <Alert tone="warning" role="alert">
                {t("form.notOpen", { name: form.mode === "edit" ? form.name : plural })}
              </Alert>
              <div>
                <Button onClick={value.close}>{t("form.backToList")}</Button>
              </div>
            </div>
          )
        ) : null}
      </div>
    </FormRouteContext.Provider>
  );
}
