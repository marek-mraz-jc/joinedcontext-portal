/**
 * T-1727: the shared controls the pages were hand-making (UI-01, UI-16, UI-44, PF-50).
 *
 * `ExternalLink` carries `rel` once instead of at each of the thirteen places that need it and
 * refuses an `href` the Portal did not write; `ConfirmDialog` replaces `window.confirm`, which
 * names nothing and cannot be translated; `RadioGroup` makes one choice out of a few a real
 * `radiogroup` the arrow keys walk.
 */
// covers (T-2137, the module gate in gate_modules.test.ts): the cases in this file drive
// src/components/ui/ConfirmDialog.tsx, src/components/ui/ExternalLink.tsx, src/components/ui/RadioGroup.tsx through the page they belong to; each was confirmed by
// making the module throw and watching this file go red.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { ConfirmDialog, ExternalLink, RadioGroup, safeHref } from "../src/components/ui";

const wrap = (node: React.ReactNode) => render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("safeHref", () => {
  it("a_javascript_url_is_not_a_link", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)  ",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "",
      "   ",
    ]) {
      expect(safeHref(bad), bad).toBeUndefined();
    }
    expect(safeHref(undefined)).toBeUndefined();
    expect(safeHref(null)).toBeUndefined();
  });

  it("a_link_that_can_navigate_passes_through_unchanged", () => {
    for (const good of [
      "https://example.org/a?b=c#d",
      "http://127.0.0.1:8080/x",
      "mailto:someone@example.org",
      "/projects/helsinki",
      "./relative",
      "../up",
      "#section",
      "?query=1",
    ]) {
      expect(safeHref(good), good).toBe(good);
    }
  });
});

describe("ExternalLink", () => {
  it("a_javascript_url_renders_as_text", () => {
    wrap(<ExternalLink href="javascript:alert(1)">The feed</ExternalLink>);
    expect(screen.getByText("The feed")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("a_new_tab_link_carries_rel_and_says_it_opens_one", () => {
    wrap(<ExternalLink href="https://example.org/feed">The feed</ExternalLink>);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://example.org/feed");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    // The eye gets the icon, a screen reader gets the words.
    expect(link).toHaveAccessibleName(/The feed.*Opens in a new tab/s);
  });
});

describe("ConfirmDialog", () => {
  function open(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    wrap(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Discard the copy air-quality?"
        description="What it holds goes with it; the project is not touched."
        confirmLabel="Discard"
        onConfirm={onConfirm}
        {...props}
      />,
    );
    return { onConfirm, onOpenChange };
  }

  it("the_confirm_dialog_focuses_cancel", async () => {
    open();
    const dialog = screen.getByRole("dialog");
    // Not the destructive button: a dialog that arrives under a key already going down must not
    // destroy anything.
    await waitFor(() => expect(screen.getByTestId("confirm-cancel")).toHaveFocus());
    expect(within(dialog).getByTestId("confirm-accept")).not.toHaveFocus();
  });

  it("names_what_is_destroyed_and_says_the_verb_not_ok", () => {
    open();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("Discard the copy air-quality?");
    expect(dialog).toHaveAccessibleDescription(/the project is not touched/);
    const accept = screen.getByTestId("confirm-accept");
    expect(accept).toHaveTextContent("Discard");
    expect(accept).not.toHaveTextContent(/^OK$/);
  });

  it("confirming_runs_the_action_once_and_cancelling_never_does", async () => {
    const { onConfirm, onOpenChange } = open();
    await userEvent.click(screen.getByTestId("confirm-cancel"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);

    await userEvent.click(screen.getByTestId("confirm-accept"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("escape_closes_it_without_doing_anything", async () => {
    const { onConfirm, onOpenChange } = open();
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("while_it_runs_neither_button_can_be_pressed_again", () => {
    open({ pending: true });
    expect(screen.getByTestId("confirm-accept")).toBeDisabled();
    expect(screen.getByTestId("confirm-cancel")).toBeDisabled();
  });
});

describe("RadioGroup", () => {
  function group(value?: "git" | "ckan") {
    const onChange = vi.fn();
    wrap(
      <RadioGroup
        name="origin"
        legend="Where it comes from"
        description="The kind of source this reads."
        value={value}
        onChange={onChange}
        options={[
          { value: "git", label: "Git repository" },
          { value: "ckan", label: "CKAN catalogue", description: "A public dataset portal" },
        ]}
      />,
    );
    return onChange;
  }

  it("is_one_radiogroup_with_its_question_read_before_the_answers", () => {
    group("git");
    // `radiogroup`, not a plain `group`: a bare fieldset is read as a group and its radios are
    // not counted out as "1 of 2" (T-1254, UI-15). The legend still names it.
    const fieldset = screen.getByRole("radiogroup", { name: "Where it comes from" });
    expect(fieldset).toHaveAccessibleDescription("The kind of source this reads.");
    expect(within(fieldset).getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: "Git repository" })).toBeChecked();
    expect(screen.getByRole("radio", { name: /CKAN catalogue/ })).not.toBeChecked();
  });

  it("radios_move_with_arrow_keys_and_the_group_is_one_tab_stop", async () => {
    const onChange = group("git");
    await userEvent.tab();
    expect(screen.getByRole("radio", { name: "Git repository" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenCalledWith("ckan");
  });

  it("a_disabled_option_cannot_be_chosen", async () => {
    const onChange = vi.fn();
    wrap(
      <RadioGroup
        name="origin"
        legend="Where it comes from"
        value="git"
        onChange={onChange}
        options={[
          { value: "git", label: "Git repository" },
          { value: "ckan", label: "CKAN catalogue", disabled: true },
        ]}
      />,
    );
    const disabled = screen.getByRole("radio", { name: "CKAN catalogue" });
    expect(disabled).toBeDisabled();
    await userEvent.click(disabled);
    expect(onChange).not.toHaveBeenCalled();
  });
});
