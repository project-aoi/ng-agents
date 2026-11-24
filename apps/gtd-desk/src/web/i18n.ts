/** Lightweight locale helper; an embedding host can swap this module at build time. */
export function t(zh: string, en: string): string {
  return /^zh(?:-|$)/i.test(document.documentElement.lang || navigator.languages?.[0] || navigator.language) ? zh : en;
}

/** Standalone has no host context. Keep an explicit locale, otherwise use the browser's. */
export function initLocale(): void {
  if (!document.documentElement.lang) {
    document.documentElement.lang = navigator.languages?.[0] || navigator.language || "en";
  }
  document.title = t("GTD 工作台", "GTD Workbench");
}
