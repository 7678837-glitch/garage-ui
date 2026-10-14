import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { DetailTabs } from "./DetailTabs";

afterEach(cleanup);

test("detail tabs expose the active panel and navigate with arrows, Home and End", async () => {
  function Example() {
    const [selected, setSelected] = useState("overview");
    return <DetailTabs label="Buckets" tabs={[{ id: "overview", label: "Overview" }, { id: "settings", label: "Settings" }]} selected={selected} hrefFor={(tab) => `#${tab}`} onSelect={setSelected}>{selected}</DetailTabs>;
  }
  render(<Example />);
  const overview = screen.getByRole("tab", { name: "Overview" });
  const settings = screen.getByRole("tab", { name: "Settings" });
  expect(overview.tabIndex).toBe(0);
  expect(settings.tabIndex).toBe(-1);
  fireEvent.keyDown(overview, { key: "ArrowRight" });
  await waitFor(() => expect(document.activeElement).toBe(settings));
  expect(settings.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tabpanel", { name: "Settings" }).id).toBe(settings.getAttribute("aria-controls"));
  fireEvent.keyDown(settings, { key: "Home" });
  await waitFor(() => expect(document.activeElement).toBe(overview));
  fireEvent.keyDown(overview, { key: "End" });
  await waitFor(() => expect(document.activeElement).toBe(settings));
  fireEvent.keyDown(settings, { key: "ArrowLeft" });
  await waitFor(() => expect(document.activeElement).toBe(overview));
});


test("detail tab links preserve hashes and call navigation once per activation", async () => {
  const onSelect = vi.fn();
  render(<DetailTabs label="Buckets" tabs={[{ id: "overview", label: "Overview" }, { id: "settings", label: "Settings" }]} selected="overview" hrefFor={(tab) => `#bucket/photos/${tab}`} onSelect={onSelect}><input aria-label="Unsaved name" defaultValue="photos" /></DetailTabs>);
  const overview = screen.getByRole("tab", { name: "Overview" });
  const settings = screen.getByRole("tab", { name: "Settings" });
  expect(settings.getAttribute("href")).toBe("#bucket/photos/settings");
  fireEvent.mouseDown(settings, { button: 0, ctrlKey: false });
  fireEvent.click(settings);
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("settings");
  expect(overview.getAttribute("aria-selected")).toBe("true");
  expect(settings.getAttribute("aria-selected")).toBe("false");
  expect(screen.getByRole("textbox", { name: "Unsaved name" })).toBeTruthy();
  onSelect.mockClear();
  fireEvent.keyDown(settings, { key: "Enter" });
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("settings");
  onSelect.mockClear();
  overview.focus();
  fireEvent.keyDown(overview, { key: "ArrowRight" });
  await waitFor(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith("settings"));
});
