/**
 * T-3269: help for the page a person is on. Every main page says what it is for and its three main
 * steps in every locale, leads to its User Guide page when the installation serves the guide, and
 * hands the assistant a question about the page for the person to send.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import sk from "../src/locales/sk.json";
import cs from "../src/locales/cs.json";
import de from "../src/locales/de.json";
import { HelpMenu } from "../src/components/HelpMenu";
import { onAskRequest } from "../src/assistant/state";
import { HELPED, helpFor } from "../src/pageHelp";
import { expectNoViolations } from "./checks";
import { OTHER_BRAND, renderPage } from "./page_contract";

type Help = Record<string, Record<string, string>>;

describe("help for this page (T-3269)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("knows each main page by its address, and no page it has no help for", () => {
    expect(helpFor("/")?.key).toBe("home");
    expect(helpFor("/organization/people")?.key).toBe("organization");
    expect(helpFor("/projects/helsinki/spaces")?.key).toBe("spaces");
    expect(helpFor("/projects/helsinki/spaces/air/")?.key).toBe("spaces");
    expect(helpFor("/projects/helsinki/pipelines/new")?.guide).toBe("User-Guide/04-pipelines");
    expect(helpFor("/projects/helsinki/unknown")).toBeUndefined();
    expect(helpFor("/glossary")).toBeUndefined();
    expect(helpFor("/projects/helsinki")).toBeUndefined();
  });

  it("every main page says what it is for and its three steps, in every locale", () => {
    for (const [name, locale] of [["en", en], ["sk", sk], ["cs", cs], ["de", de]] as const) {
      const help = (locale as unknown as { pageHelp: Help }).pageHelp;
      for (const key of HELPED) {
        for (const part of ["title", "purpose", "one", "two", "three"]) {
          expect(help[key]?.[part], `${name} ${key}.${part}`).toBeTruthy();
          // A title may be the same word in two languages ("Pipelines", "Dashboards"); the words are not.
          if (name !== "en" && part !== "title") {
            expect(help[key][part], `${name} ${key}.${part} is translated`).not.toBe((en.pageHelp as unknown as Help)[key][part]);
          }
        }
      }
    }
  });

  it("opens the page's help, leads to its guide page, and hands the assistant a question about it", async () => {
    const asked: string[] = [];
    const stop = onAskRequest((question) => asked.push(question));
    const { container } = renderPage(<HelpMenu />, {
      answer: () => undefined,
      path: "/projects/helsinki/pipelines",
      branding: { ...OTHER_BRAND, documentationBaseUrl: "https://docs.example.org/" },
    });
    await userEvent.click(await screen.findByRole("button", { name: /^Help/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: en.pageHelp.menu }));
    const dialog = await screen.findByRole("dialog", { name: en.pageHelp.pipelines.title });
    expect(within(dialog).getByText(en.pageHelp.pipelines.purpose)).toBeInTheDocument();
    expect(within(dialog).getAllByRole("listitem").map((step) => step.textContent)).toEqual([
      en.pageHelp.pipelines.one,
      en.pageHelp.pipelines.two,
      en.pageHelp.pipelines.three,
    ]);
    expect(within(dialog).getByRole("link", { name: new RegExp(en.pageHelp.guide) })).toHaveAttribute(
      "href",
      "https://docs.example.org/User-Guide/04-pipelines",
    );
    await expectNoViolations(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: en.pageHelp.askButton }));
    expect(asked).toEqual(["Help me with the Pipelines page: what is it for, and what comes first?"]);
    expect(container.ownerDocument.querySelector('[role="dialog"]')).toBeNull();
    stop();
  });

  it("offers no page help where there is none, and no guide link where the installation serves no guide", async () => {
    renderPage(<HelpMenu />, { answer: () => undefined, path: "/glossary" });
    await userEvent.click(await screen.findByRole("button", { name: /^Help/ }));
    expect(await screen.findByRole("menuitem", { name: /^What's new/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: en.pageHelp.menu })).toBeNull();
  });
});
