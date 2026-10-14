import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { DetailTabs } from "./DetailTabs";

afterEach(cleanup);

test("detail tabs expose the active panel and navigate with arrows, Home and End", () => {
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
  expect(document.activeElement).toBe(settings);
  expect(settings.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tabpanel", { name: "Settings" }).id).toBe(settings.getAttribute("aria-controls"));
  fireEvent.keyDown(settings, { key: "Home" });
  expect(document.activeElement).toBe(overview);
  fireEvent.keyDown(overview, { key: "End" });
  expect(document.activeElement).toBe(settings);
  fireEvent.keyDown(settings, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(overview);
});
