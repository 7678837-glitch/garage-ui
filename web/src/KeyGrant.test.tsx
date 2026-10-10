import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { KeyGrant } from "./KeyGrant";

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
  fireEvent.change(screen.getByLabelText("Key"), { target: { value: "K1" } });
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
  fireEvent.change(screen.getByLabelText("Key"), { target: { value: "K1" } });
  fireEvent.click(screen.getByLabelText("Write"));
  fireEvent.click(screen.getByRole("button", { name: "Grant" }));
  expect((await screen.findByRole("alert")).textContent).toBe("bucket key denied");
  expect(screen.queryByText("Key granted")).toBeNull();
});
