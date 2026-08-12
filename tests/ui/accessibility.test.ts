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
  it("uses unique tab and panel IDs across simultaneous workbench roots", () => {
    const first = renderRoot();
    const second = renderRoot();
    const ids = Array.from(document.querySelectorAll<HTMLElement>("[id]")).map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tab of Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'))) {
      const controlled = tab.getAttribute("aria-controls");
      expect(controlled).not.toBeNull();
      if (controlled !== null) expect(document.getElementById(controlled)).not.toBeNull();
    }
    first.remove();
    second.remove();
  });

  it("keeps one roving tab stop and names every native control", () => {
    const root = renderRoot();
    const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
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
  });

  it("uses named native disabled controls and non-color-only acceptance styling", () => {
    const root = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
    renderWorkbench(root, populatedWorkbenchModel(), noOpWorkbenchActions(), READ_ONLY_ACCEPTANCE_POLICY);
    const banner = root.querySelector<HTMLElement>('[data-acceptance-banner="true"]')!;
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.getAttribute("aria-label")).toBe("Read-only acceptance mode is active");
    for (const control of Array.from(root.querySelectorAll<HTMLButtonElement>("button:disabled"))) {
      expect(control.getAttribute("aria-label") ?? control.textContent).toBeTruthy();
    }
    const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");
    expect(css).toMatch(/\.knowledge-workbench__acceptance-banner\s*\{[^}]*border:\s*2px solid/su);
    expect(css).toMatch(/\.knowledge-workbench--read-only-acceptance button:disabled/u);
    expect(css).not.toMatch(/\.knowledge-workbench button:disabled/u);
  });
});
