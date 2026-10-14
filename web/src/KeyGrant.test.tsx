import { Theme } from "@radix-ui/themes";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { KeyGrant } from "./KeyGrant";

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

function render(ui: ReactNode) { return rtlRender(<Theme>{ui}</Theme>); }

function selectOption(label: string, option: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name: label }), { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: option }));
}
HTMLElement.prototype.scrollIntoView = () => {};

afterEach(() => {
  cleanup();
});

const keys = [{ id: "K1", label: "key one" }];

test("disables submit when no key is selected or no permission is checked", () => {
  render(<KeyGrant keys={keys} submit={async () => {}} />);
  const grant = screen.getByRole("button", { name: "Grant" }) as HTMLButtonElement;
  expect(grant.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("Read"));
  expect(grant.disabled).toBe(true);
  selectOption("Key", "key one");
  expect(grant.disabled).toBe(false);
  fireEvent.click(screen.getByLabelText("Read"));
  expect(grant.disabled).toBe(true);
});

test("shows the error text when the grant request fails", async () => {
  render(
    <KeyGrant
      keys={keys}
      submit={async () => {
        throw new Error("bucket key denied");
      }}
    />,
  );
  selectOption("Key", "key one");
  fireEvent.click(screen.getByLabelText("Write"));
  fireEvent.click(screen.getByRole("button", { name: "Grant" }));
  expect((await screen.findByRole("alert")).textContent).toBe("bucket key denied");
  expect(screen.queryByText("Key granted")).toBeNull();
});

test("disables another grant while the request is pending and restores the form on failure", async () => {
  let rejectGrant: ((error: Error) => void) | undefined;
  render(<KeyGrant keys={keys} submit={() => new Promise<void>((_resolve, reject) => { rejectGrant = reject; })} />);
  selectOption("Key", "key one");
  fireEvent.click(screen.getByLabelText("Write"));
  fireEvent.click(screen.getByRole("button", { name: "Grant" }));
  expect((screen.getByRole("button", { name: "Granting" }) as HTMLButtonElement).disabled).toBe(true);
  rejectGrant?.(new Error("Grant denied"));
  expect((await screen.findByRole("alert")).textContent).toBe("Grant denied");
  expect((screen.getByRole("button", { name: "Grant" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole("combobox", { name: "Key" }).textContent).toBe("key one");
  expect(screen.getByRole("checkbox", { name: "Write" }).getAttribute("aria-checked")).toBe("true");
});
