import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import type { Note, NotesApi } from "./notes";

function fake(start: Note[]): NotesApi & { notes: Note[] } {
  const notes = [...start];
  return {
    notes,
    list: vi.fn(async () => [...notes]),
    add: vi.fn(async (body: string) => {
      const note = { id: notes.length + 1, body, file: null, created_at: "" };
      notes.unshift(note);
      return note;
    }),
    change: vi.fn(async () => undefined),
    remove: vi.fn(async (id: number) => {
      notes.splice(notes.findIndex((n) => n.id === id), 1);
    }),
    upload: vi.fn(async () => undefined),
    downloadUrl: vi.fn(async () => "https://store.example/x"),
  };
}

describe("the notes screen", () => {
  it("lists the notes, adds one and deletes one", async () => {
    const api = fake([{ id: 1, body: "first", file: null, created_at: "" }]);
    render(<App api={api} />);
    const list = await screen.findByRole("list", { name: "Notes" });
    expect(within(list).getByText("first")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("New note"), "second");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("second")).toBeInTheDocument();
    expect(screen.getByLabelText("New note")).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: "Delete note 1" }));
    expect(await screen.findByText("second")).toBeInTheDocument();
    expect(screen.queryByText("first")).toBeNull();
  });

  it("says what went wrong and offers the file once there is one", async () => {
    const api = fake([{ id: 1, body: "with a file", file: "notes/1/a.txt", created_at: "" }]);
    api.remove = vi.fn(async () => {
      throw new Error("the database is busy");
    });
    render(<App api={api} />);
    expect(await screen.findByRole("button", { name: "Open the file" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete note 1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("the database is busy");
    await userEvent.upload(screen.getByLabelText("Replace the file"), new File(["x"], "b.txt"));
    expect(api.upload).toHaveBeenCalledWith(1, expect.any(File));
  });

  it("says there is nothing yet, and adds nothing empty", async () => {
    render(<App api={fake([])} />);
    expect(await screen.findByText("No notes yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });
});
