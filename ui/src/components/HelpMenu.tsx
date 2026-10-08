import { useState } from "react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { WHATS_NEW, isUnread, lastSeen, markSeen } from "../whatsNew";
import { Badge, Button, Dialog, Icon, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, safeHref } from "./ui";

/**
 * Help in the header (T-3271): what changed for the people who use the Portal, with a dot until
 * it is read, and the glossary. The dot is this browser's: it remembers the newest entry read.
 */
export function HelpMenu(): JSX.Element {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  // The dot follows what was read; the list marks what was new when it was opened.
  const [seen, setSeen] = useState(lastSeen);
  const [readBefore, setReadBefore] = useState<string | undefined>();
  const unread = WHATS_NEW.filter((entry) => isUnread(entry, seen)).length;
  const day = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language ?? "sk", { dateStyle: "medium" });

  const read = () => {
    setReadBefore(lastSeen());
    markSeen();
    setSeen(lastSeen());
    setOpen(true);
  };

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button variant="ghost" className="relative px-1.5" aria-label={t("help.label", { count: unread })}>
            <Icon name="info" className="size-5" />
            {unread > 0 ? (
              <span aria-hidden="true" className="absolute right-0.5 top-0.5 size-2 rounded-full bg-primary" />
            ) : null}
          </Button>
        </MenuTrigger>
        <MenuContent align="end" className="min-w-52">
          <MenuLabel>{t("help.title")}</MenuLabel>
          <MenuItem onSelect={read}>
            <Icon name="inbox" className="size-4" />
            {unread > 0 ? t("whatsNew.menuUnread", { count: unread }) : t("whatsNew.menu")}
          </MenuItem>
          <MenuItem asChild>
            <a href="/glossary">
              <Icon name="info" className="size-4" />
              {t("glossary.page.title")}
            </a>
          </MenuItem>
        </MenuContent>
      </Menu>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t("whatsNew.title")}
        description={t("whatsNew.lead")}
        closeLabel={t("whatsNew.close")}
      >
        <ol className="flex flex-col gap-4">
          {WHATS_NEW.map((entry) => (
            <li key={entry.key} className="flex flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2 text-caption text-fg-muted">
                <time dateTime={entry.date}>{day.format(new Date(`${entry.date}T12:00:00Z`))}</time>
                {isUnread(entry, readBefore) ? <Badge tone="info">{t("whatsNew.new")}</Badge> : null}
              </span>
              <h3 className="text-body font-semibold text-fg">{t(`whatsNew.entries.${entry.key}.title`)}</h3>
              <p className="text-body text-fg-muted">{t(`whatsNew.entries.${entry.key}.body`)}</p>
              {safeHref(entry.href) ? (
                <a href={safeHref(entry.href)} className="focus-ring w-fit rounded-sm text-body text-primary-soft-fg underline hover:no-underline">
                  {t("whatsNew.open")}
                </a>
              ) : null}
            </li>
          ))}
        </ol>
      </Dialog>
    </>
  );
}
