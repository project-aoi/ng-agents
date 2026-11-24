// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { initLocale, t } from "../src/web/i18n";

const originalLang = document.documentElement.lang;
const originalTitle = document.title;
afterEach(() => {
  document.documentElement.lang = originalLang;
  document.title = originalTitle;
  vi.restoreAllMocks();
});

it.each([ ["zh-CN", "GTD 工作台"], ["en-US", "GTD Workbench"], ["fr-FR", "GTD Workbench"] ])(
  "uses the browser locale %s when standalone has no explicit locale",
  (locale, title) => {
    document.documentElement.removeAttribute("lang");
    vi.spyOn(navigator, "languages", "get").mockReturnValue([locale]);
    initLocale();
    expect(document.documentElement.lang).toBe(locale);
    expect(document.title).toBe(title);
  },
);

it("retains an explicit locale and translates only fixed text", () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
  document.documentElement.lang = "zh-Hans";
  initLocale();
  expect(t("确定", "Confirm")).toBe("确定");
  document.documentElement.lang = "en";
  expect(t("确定", "Confirm")).toBe("Confirm");
});
