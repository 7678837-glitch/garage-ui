import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ResourceIdentity } from "./ui";

afterEach(cleanup);
const id = "GK0123456789abcdefghijklmnop";

test("resource identity copies the complete ID and confirms only after success", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<ResourceIdentity id={id} />);
  expect(screen.getByText(id).tagName).toBe("CODE");
  fireEvent.click(screen.getByRole("button", { name: "Copy ID" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("ID copied"));
  expect(writeText).toHaveBeenCalledWith(id);
});

test("resource identity reports failed clipboard writes without a success claim", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) } });
  render(<ResourceIdentity id={id} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy ID" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Could not copy ID. Select the full ID and copy it manually."));
  expect(screen.queryByText("ID copied")).toBeNull();
});
