import { Theme } from "@radix-ui/themes";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { CapacityField } from "./CapacityField";

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

function setup(bytes: string) {
  const submitted: string[] = [];
  render(
    <CapacityField
      bytes={bytes}
      submit={(value) => {
        submitted.push(value);
      }}
    />,
  );
  return submitted;
}

function capacityInput() {
  return screen.getByLabelText("Capacity") as HTMLInputElement;
}

function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

test("shows 1800000000000 bytes as 1.80 TB and submits that digit string unchanged", () => {
  const submitted = setup("1800000000000");
  expect(capacityInput().value).toBe("1.80");
  expect(screen.getByRole("combobox", { name: "Unit" }).textContent).toBe("TB");
  save();
  expect(submitted).toEqual(["1800000000000"]);
});

test("shows at least two fraction digits and keeps a smaller remainder", () => {
  const submitted = setup("1800500000000");
  expect(capacityInput().value).toBe("1.8005");
  save();
  expect(submitted).toEqual(["1800500000000"]);
});

test("shows 100 bytes in TB without rounding the remainder away", () => {
  const submitted = setup("100");
  expect(capacityInput().value).toBe("0.0000000001");
  save();
  expect(submitted).toEqual(["100"]);
});

test("submits a byte string past the 53-bit mantissa without rounding", () => {
  const submitted = setup("9007199254740993");
  expect(capacityInput().value).toBe("9007.199254740993");
  save();
  expect(submitted).toEqual(["9007199254740993"]);
});

test("submits a leading zero in the original byte string unchanged", () => {
  const submitted = setup("01800000000000");
  expect(capacityInput().value).toBe("1.80");
  save();
  expect(submitted).toEqual(["01800000000000"]);
});

test("keeps the original byte string when only the unit changes", () => {
  const submitted = setup("1800000000000");
  selectOption("Unit", "GB");
  expect(capacityInput().value).toBe("1800.00");
  save();
  expect(submitted).toEqual(["1800000000000"]);
});

test("submits an edited 1.81 TB as 1810000000000 bytes", () => {
  const submitted = setup("1800000000000");
  fireEvent.change(capacityInput(), { target: { value: "1.81" } });
  save();
  expect(submitted).toEqual(["1810000000000"]);
});

test("submits an edited byte string past the 53-bit mantissa unchanged as digits", () => {
  const submitted = setup("1");
  selectOption("Unit", "B");
  fireEvent.change(capacityInput(), { target: { value: "9007199254740993" } });
  save();
  expect(submitted).toEqual(["9007199254740993"]);
});

test("rejects a fraction of a byte instead of rounding it", () => {
  const submitted = setup("2");
  selectOption("Unit", "B");
  fireEvent.change(capacityInput(), { target: { value: "1.5" } });
  save();
  expect(screen.getByRole("alert").textContent).toBe("Enter a whole number of bytes");
  expect(submitted).toEqual([]);
});
