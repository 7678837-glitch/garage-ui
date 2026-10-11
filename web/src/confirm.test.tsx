import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { ConfirmDialog, riskOf } from "./confirm";

afterEach(() => {
  cleanup();
});

const actions = [
  ["rename", "low"],
  ["quota", "low"],
  ["website-document", "low"],
  ["delete-object", "medium"],
  ["revoke-permission", "medium"],
  ["delete-empty-bucket", "medium"],
  ["delete-key", "medium"],
  ["recursive-delete", "high"],
  ["batch-delete", "high"],
  ["clear-block", "high"],
  ["skip-dead-node", "high"],
  ["apply-layout", "high"],
  ["enable-website", "high"],
  ["create-admin-token", "high"],
] as const;

test.each(actions)("riskOf(%s) is %s", (action, level) => {
  expect(riskOf(action)).toBe(level);
});

test("riskOf throws for an unknown action", () => {
  expect(() => riskOf("not-an-action")).toThrow("Unknown write action: not-an-action");
});

test("medium confirmation focuses Cancel, closes on Escape, and Confirm runs the action", () => {
  const confirmed: string[] = [];
  function Probe() {
    const [open, setOpen] = useState(true);
    if (!open) {
      return null;
    }
    return (
      <ConfirmDialog
        action="delete-object"
        name="photos/a.jpg"
        consequence="This permanently deletes the object."
        onCancel={() => {
          setOpen(false);
        }}
        onConfirm={() => {
          confirmed.push("photos/a.jpg");
        }}
      />
    );
  }
  render(<Probe />);
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("photos/a.jpg");
  expect(dialog.textContent).toContain("This permanently deletes the object.");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(dialog, { key: "Enter" });
  expect(confirmed).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(confirmed).toEqual(["photos/a.jpg"]);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(confirmed).toEqual(["photos/a.jpg"]);
});

test("high confirmation accepts only the typed target name", () => {
  const confirmed: string[] = [];
  function Probe() {
    const [open, setOpen] = useState(true);
    if (!open) {
      return null;
    }
    return (
      <ConfirmDialog
        action="recursive-delete"
        name="photos"
        consequence="This permanently deletes every object under the prefix."
        scope="4 objects, 12 MB"
        onCancel={() => {
          setOpen(false);
        }}
        onConfirm={() => {
          confirmed.push("photos");
        }}
      />
    );
  }
  render(<Probe />);
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("photos");
  expect(dialog.textContent).toContain("This permanently deletes every object under the prefix.");
  expect(dialog.textContent).toContain("4 objects, 12 MB");
  const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
  const input = screen.getByRole("textbox");
  expect(confirm.disabled).toBe(true);
  fireEvent.change(input, { target: { value: "pho" } });
  expect(confirm.disabled).toBe(true);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(confirmed).toEqual([]);
  fireEvent.change(input, { target: { value: "photos " } });
  expect(confirm.disabled).toBe(true);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(confirmed).toEqual([]);
  fireEvent.change(input, { target: { value: "photos" } });
  expect(confirm.disabled).toBe(false);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(confirmed).toEqual(["photos"]);
  fireEvent.click(confirm);
  expect(confirmed).toEqual(["photos", "photos"]);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(confirmed).toEqual(["photos", "photos"]);
});

test("pending confirmation reads Working, stays disabled, and keeps Cancel focused", () => {
  const confirmed: string[] = [];
  const cancelled: string[] = [];
  function Probe() {
    const [open, setOpen] = useState(true);
    if (!open) {
      return null;
    }
    return (
      <ConfirmDialog
        action="delete-object"
        name="photos/a.jpg"
        consequence="This permanently deletes the object."
        pending
        onCancel={() => {
          cancelled.push("cancel");
          setOpen(false);
        }}
        onConfirm={() => {
          confirmed.push("photos/a.jpg");
        }}
      />
    );
  }
  render(<Probe />);
  const dialog = screen.getByRole("dialog");
  const working = screen.getByRole("button", { name: "Working" }) as HTMLButtonElement;
  expect(working.disabled).toBe(true);
  expect(working.textContent).toBe("Working");
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(working);
  fireEvent.keyDown(dialog, { key: "Enter" });
  expect(confirmed).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(cancelled).toEqual(["cancel"]);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(confirmed).toEqual([]);
});

test("pending high confirmation keeps the typed name and does not confirm", () => {
  const confirmed: string[] = [];
  render(
    <ConfirmDialog
      action="recursive-delete"
      name="photos"
      consequence="This permanently deletes every object under the prefix."
      scope="4 objects, 12 MB"
      pending
      onCancel={() => {
        confirmed.push("cancel");
      }}
      onConfirm={() => {
        confirmed.push("photos");
      }}
    />,
  );
  const input = screen.getByRole("textbox") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "photos" } });
  const working = screen.getByRole("button", { name: "Working" }) as HTMLButtonElement;
  expect(working.disabled).toBe(true);
  expect(input.value).toBe("photos");
  expect(screen.getByText("Type photos to confirm")).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.click(working);
  expect(confirmed).toEqual([]);
  const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
  expect(cancel.disabled).toBe(false);
  expect(cancel.textContent).toBe("Cancel");
  expect(document.activeElement).toBe(cancel);
});
