/**
 * T-3088: at 375 px the data sources and CKAN tables and the KPI pipeline's edit page scrolled
 * sideways as a whole (evidence/worker-2/T-3087/kpi-compute-edit-375.png). Two causes, both in
 * shared components: a header's `sr-only` label is absolutely positioned and escaped the table's
 * scrolling frame, which was not its containing block; an error naming a URL had nowhere to
 * break. jsdom lays nothing out, so this pins the two properties the browser needs.
 */
import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import i18n from "../src/i18n";
import { Alert } from "../src/components/ui/Alert";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "../src/components/ui/Table";

describe("a phone-wide page", () => {
  it("keeps a table's hidden header labels inside the frame that scrolls", () => {
    render(
      <Table caption="Catalogues">
        <TableHead>
          <TableRow>
            <TableHeaderCell>
              <span className="sr-only">Actions</span>
            </TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const frame = screen.getByRole("group", { name: "Catalogues" });
    expect(frame).toHaveClass("overflow-x-auto");
    expect(frame).toHaveClass("relative");
  });

  it("wraps an error's URL anywhere rather than widening the page", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <Alert tone="danger">fetch: https://portal.example/api/v1/projects/a/pipelines/b/sample?limit=5</Alert>
      </I18nextProvider>,
    );
    expect(screen.getByText(/^fetch:/)).toHaveClass("[overflow-wrap:anywhere]");
  });
});
