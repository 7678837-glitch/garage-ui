import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Breadcrumb } from "./App";
import { CapacityField } from "./CapacityField";
import { ConfirmDialog } from "./confirm";
import { en } from "./copy-en";
import { zh } from "./copy-zh";
import { CapacityText, InstantText, LanguageChooser, LanguageProvider, phrase } from "./i18n";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("english and chinese catalogs have the same keys", () => {
  const enKeys = Object.keys(en).sort();
  const zhKeys = Object.keys(zh).sort();
  expect(zhKeys).toEqual(enKeys);
  for (const key of enKeys) {
    const english = en[key as keyof typeof en];
    const chinese = zh[key as keyof typeof zh];
    expect(english.length).toBeGreaterThan(0);
    expect(chinese.length).toBeGreaterThan(0);
    expect(chinese).not.toBe(key);
    expect(chinese).not.toBe(english);
  }
});

test("new page labels translate from exact English phrases", () => {
  const labels = [
    ["No matches on this page.", "本页没有匹配项。"],
    ["Filtering and sorting apply to the current page", "筛选和排序仅作用于当前页"],
    ["User list", "用户列表"],
    ["Admin token list", "管理令牌列表"],
    ["Audit events", "审计事件"],
    ["All nodes", "所有节点"],
    ["Layout version", "布局版本"],
    ["Node list", "节点列表"],
    ["Worker list", "工作任务列表"],
    ["Block error list", "数据块错误列表"],
    [
      "Leave this page? Unfinished uploads will be cancelled and unsaved changes will be lost.",
      "离开此页面？未完成的上传将被取消，未保存的更改将丢失。",
    ],
  ] as const;

  for (const [english, chinese] of labels) {
    expect(phrase("en", english)).toBe(english);
    expect(phrase("zh-CN", english)).toBe(chinese);
  }
});

test("switching to chinese replaces the language label", () => {
  localStorage.clear();
  render(
    <LanguageProvider>
      <LanguageChooser />
    </LanguageProvider>,
  );
  expect(screen.getByLabelText("Language")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Language"), { target: { value: "zh-CN" } });
  expect(screen.getByLabelText("语言")).toBeTruthy();
  expect(screen.queryByLabelText("Language")).toBeNull();
  expect(screen.queryByText("settings.language")).toBeNull();
});

test("a chinese breadcrumb names sections and tabs from the catalog", () => {
  localStorage.setItem("garage-ui-language", "zh-CN");
  const { unmount } = render(
    <LanguageProvider>
      <Breadcrumb section="keys" hash="#keys" onSelect={() => undefined} />
    </LanguageProvider>,
  );
  const keys = screen.getByRole("navigation", { name: "路径" });
  expect(within(keys).getByRole("link", { name: "概览" }).textContent).toBe("概览");
  expect(within(keys).getByText("密钥").textContent).toBe("密钥");
  expect(within(keys).queryByText("Overview")).toBeNull();
  expect(within(keys).queryByText("Keys")).toBeNull();
  unmount();

  render(
    <LanguageProvider>
      <Breadcrumb
        section="buckets"
        hash="#buckets/bucket-ada/photos/"
        onSelect={() => undefined}
      />
    </LanguageProvider>,
  );
  const objects = screen.getByRole("navigation", { name: "路径" });
  expect(within(objects).getByRole("link", { name: "概览" }).textContent).toBe("概览");
  expect(within(objects).getByRole("link", { name: "存储桶" }).textContent).toBe("存储桶");
  expect(within(objects).getByText("对象").textContent).toBe("对象");
  expect(objects.textContent).not.toContain("bucket-ada");

  cleanup();
  render(
    <LanguageProvider>
      <Breadcrumb section="buckets" hash="#bucket/b1/permissions" onSelect={() => undefined} />
    </LanguageProvider>,
  );
  const permissions = screen.getByRole("navigation", { name: "路径" });
  expect(within(permissions).getByText("权限").textContent).toBe("权限");
  expect(within(permissions).queryByText("Permissions")).toBeNull();
});

test("a timestamp follows the language and english keeps the source text", () => {
  localStorage.setItem("garage-ui-language", "zh-CN");
  const chinese = render(
    <LanguageProvider>
      <InstantText value="2026-10-11T00:00:00Z" />
    </LanguageProvider>,
  );
  expect(screen.getByText("2026年10月11日 00:00").textContent).toBe("2026年10月11日 00:00");
  expect(screen.queryByText("2026-10-11T00:00:00Z")).toBeNull();
  chinese.unmount();

  localStorage.setItem("garage-ui-language", "en");
  render(
    <LanguageProvider>
      <InstantText value="2026-10-11T00:00:00Z" />
    </LanguageProvider>,
  );
  expect(screen.getByText("2026-10-11T00:00:00Z").textContent).toBe("2026-10-11T00:00:00Z");
});

test("capacity units follow the language", () => {
  const english = render(
    <LanguageProvider>
      <CapacityText digits="1000" />
    </LanguageProvider>,
  );
  expect(screen.getByText("1.00 KB").textContent).toBe("1.00 KB");
  english.unmount();

  localStorage.setItem("garage-ui-language", "zh-CN");
  const chinese = render(
    <LanguageProvider>
      <CapacityText digits="1000" />
    </LanguageProvider>,
  );
  expect(screen.getByText("1.00 千字节").textContent).toBe("1.00 千字节");
  expect(screen.queryByText("1.00 KB")).toBeNull();
  chinese.unmount();

  render(
    <LanguageProvider>
      <CapacityField bytes="1800000000000" submit={() => undefined} />
    </LanguageProvider>,
  );
  const unit = screen.getByRole("combobox", { name: "单位" }) as HTMLSelectElement;
  expect(unit.value).toBe("TB");
  expect(unit.selectedOptions[0]?.textContent).toBe("太字节");
});

test("the confirm dialog follows the language", () => {
  localStorage.setItem("garage-ui-language", "zh-CN");
  render(
    <LanguageProvider>
      <ConfirmDialog
        action="delete-key"
        name="key-1"
        consequence="gone"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    </LanguageProvider>,
  );
  expect(screen.getByRole("heading", { name: "确认 key-1" }).textContent).toBe("确认 key-1");
  expect(screen.getByRole("button", { name: "取消" }).textContent).toBe("取消");
  expect(screen.getByRole("button", { name: "确认" }).textContent).toBe("确认");
});
