// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderWorkbench } from "../../src/ui/workbench-view";
import { noOpWorkbenchActions, populatedWorkbenchModel } from "../helpers/ui-fixtures";
import { READ_ONLY_ACCEPTANCE_POLICY } from "../../src/runtime/safety-policy";

const renderRoot = (): HTMLDivElement => {
  const root = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  document.body.append(root);
  renderWorkbench(root, populatedWorkbenchModel(), noOpWorkbenchActions());
  return root;
};

describe("workbench accessibility contracts", () => {
  it("uses unique navigation and page IDs across simultaneous workbench roots", () => {
    const first = renderRoot();
    const second = renderRoot();
    const ids = Array.from(document.querySelectorAll<HTMLElement>("[id]")).map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const panel of Array.from(document.querySelectorAll<HTMLElement>("main[aria-labelledby]"))) {
      const label = panel.getAttribute("aria-labelledby");
      expect(label).not.toBeNull();
      if (label !== null) expect(document.getElementById(label)).not.toBeNull();
    }
    first.remove();
    second.remove();
  });

  it("renders one main region and one current navigation item", () => {
    const root = renderRoot();
    expect(root.querySelectorAll("main")).toHaveLength(1);
    expect(root.querySelectorAll('[data-workbench-page][aria-current="page"]')).toHaveLength(1);
    root.remove();
  });

  it("keeps navigation controls named and names every native control", () => {
    const root = renderRoot();
    const pages = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-workbench-page]"));
    expect(pages.map((page) => page.tabIndex)).toEqual([0, 0, 0]);
    expect(pages.map((page) => page.getAttribute("aria-label"))).toEqual(["文库", "任务", "更多"]);
    expect(root.querySelector<HTMLSelectElement>("[data-workbench-locale]")?.getAttribute("aria-label")).toBeTruthy();
    for (const control of Array.from(root.querySelectorAll<HTMLElement>("button, input, select, textarea"))) {
      const name = control.getAttribute("aria-label")
        ?? (control.id ? root.querySelector<HTMLLabelElement>(`label[for="${control.id}"]`)?.textContent : null)
        ?? control.closest("label")?.textContent
        ?? control.textContent;
      expect(name?.trim(), control.outerHTML).toBeTruthy();
    }
    root.remove();
  });

  it("ships container stacking, visible focus, and forceful reduced-motion rules", () => {
    const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");
    expect(css).toMatch(/container-type:\s*inline-size/u);
    expect(css).toMatch(/@container[^{]*\(max-width:/u);
    expect(css).toMatch(/:focus-visible/u);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
    expect(css).toMatch(/animation(?:-duration)?:\s*(?:none|0(?:ms|s)?)\s*!important/u);
    expect(css).toMatch(/transition(?:-duration)?:\s*(?:none|0(?:ms|s)?)\s*!important/u);
    expect(css).toMatch(/scroll-behavior:\s*auto\s*!important/u);
    expect(css).toMatch(/\.knowledge-workbench__page\s*\{[^}]*width:\s*min\(100%,\s*72rem\)/su);
    expect(css).toMatch(/@container\s+knowledge-workbench\s*\(max-width:\s*44rem\)/u);
    expect(css).not.toMatch(/background-image:\s*\n?\s*linear-gradient\(/u);
    expect(css).not.toMatch(/overflow-x:\s*clip/u);
    const narrowContainerStart = css.lastIndexOf("@container knowledge-workbench (max-width: 44rem)");
    expect(narrowContainerStart).toBeGreaterThanOrEqual(0);
    const openingBrace = css.indexOf("{", narrowContainerStart);
    expect(openingBrace).toBeGreaterThan(narrowContainerStart);
    let depth = 1;
    let narrowContainerEnd = openingBrace + 1;
    while (depth > 0 && narrowContainerEnd < css.length) {
      const character = css[narrowContainerEnd++];
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
    }
    expect(depth).toBe(0);
    const narrowContainer = css.slice(narrowContainerStart, narrowContainerEnd);
    expect(narrowContainer).toMatch(/\.knowledge-workbench__verification-progress\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/su);
    expect(narrowContainer).toMatch(/\.knowledge-workbench__verification-progress\s+dl\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/su);

    const progressBase = css.lastIndexOf(
      ".knowledge-workbench__verification-progress {\n  display: grid;\n  grid-template-columns: repeat(3, minmax(0, 1fr));",
    );
    const metricsBase = css.lastIndexOf(
      ".knowledge-workbench__verification-progress dl {\n  display: grid;\n  grid-template-columns: minmax(12rem, 1fr) minmax(0, 1fr);",
    );
    expect(progressBase).toBeGreaterThanOrEqual(0);
    expect(metricsBase).toBeGreaterThanOrEqual(0);
    const narrowProgressOverride = narrowContainer.indexOf(
      ".knowledge-workbench__verification-progress {\n    grid-template-columns: minmax(0, 1fr);",
    );
    const narrowMetricsOverride = narrowContainer.indexOf(
      ".knowledge-workbench__verification-progress dl {\n    grid-template-columns: minmax(0, 1fr);",
    );
    expect(narrowProgressOverride).toBeGreaterThanOrEqual(0);
    expect(narrowMetricsOverride).toBeGreaterThanOrEqual(0);
    expect(narrowContainerStart + narrowProgressOverride).toBeGreaterThan(progressBase);
    expect(narrowContainerStart + narrowMetricsOverride).toBeGreaterThan(metricsBase);
  });

  it("uses named native disabled controls and non-color-only acceptance styling", () => {
    const root = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
    renderWorkbench(root, populatedWorkbenchModel(), noOpWorkbenchActions(), READ_ONLY_ACCEPTANCE_POLICY);
    const banner = root.querySelector<HTMLElement>('[data-acceptance-banner="true"]')!;
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.getAttribute("aria-label")).toBe("只读验收模式已启用");
    for (const control of Array.from(root.querySelectorAll<HTMLButtonElement>("button:disabled"))) {
      expect(control.getAttribute("aria-label") ?? control.textContent).toBeTruthy();
    }
    const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");
    expect(css).toMatch(/\.knowledge-workbench__acceptance-banner\s*\{[^}]*border:\s*2px solid/su);
    expect(css).toMatch(/\.knowledge-workbench--read-only-acceptance button:disabled/u);
    expect(css).not.toMatch(/\.knowledge-workbench button:disabled/u);
  });
});
