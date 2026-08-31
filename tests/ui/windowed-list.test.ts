// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createWindowedList } from "../../src/ui/windowed-list";

const renderTextRow = (value: string, index: number): HTMLLIElement => {
  const row = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "li",
  ) as HTMLLIElement;
  row.dataset.rowIndex = String(index);
  row.textContent = value;
  return row;
};

describe("createWindowedList", () => {
  it("bounds a 20,000-row DOM and reaches the final row", () => {
    const values = Array.from({ length: 20_000 }, (_, index) => `Folder ${index}`);
    const surface = createWindowedList(document, {
      rows: values,
      rowHeight: 44,
      windowSize: 100,
      overscan: 10,
      renderRow: renderTextRow,
    });

    expect(surface.element.dataset.totalRows).toBe("20000");
    expect(surface.element.querySelectorAll("li").length).toBeLessThanOrEqual(102);
    expect(surface.element.textContent).toContain("Folder 0");
    expect(surface.element.textContent).not.toContain("Folder 19999");

    surface.element.scrollTop = 44 * 20_000;
    surface.element.dispatchEvent(new Event("scroll"));

    expect(surface.element.textContent).toContain("Folder 19999");
    expect(surface.element.querySelectorAll("li").length).toBeLessThanOrEqual(102);
  });

  it("updates from one copied snapshot of the supplied rows", () => {
    let sliceCount = 0;
    const source = ["A", "B", "C"];
    const originalSlice = source.slice.bind(source);
    source.slice = (start?: number, end?: number): string[] => {
      sliceCount += 1;
      return originalSlice(start, end);
    };
    const surface = createWindowedList(document, {
      rows: source,
      rowHeight: 44,
      windowSize: 100,
      overscan: 10,
      renderRow: renderTextRow,
    });

    expect(sliceCount).toBe(1);
    source[0] = "mutated after create";
    expect(surface.element.textContent).toContain("A");
    expect(surface.element.textContent).not.toContain("mutated after create");

    surface.update(source);
    expect(sliceCount).toBe(2);
    source[0] = "mutated after update";
    expect(surface.element.dataset.totalRows).toBe("3");
    expect(surface.element.textContent).toContain("mutated after create");
    expect(surface.element.textContent).not.toContain("mutated after update");

    surface.update(["Replacement A", "Replacement B"]);
    expect(surface.element.dataset.totalRows).toBe("2");
    expect(surface.element.textContent).toBe("Replacement AReplacement B");
  });

  it("clamps negative, non-finite, and overlarge scroll-derived indices", () => {
    const surface = createWindowedList(document, {
      rows: Array.from({ length: 200 }, (_, index) => `Folder ${index}`),
      rowHeight: 44,
      windowSize: 100,
      overscan: 10,
      renderRow: renderTextRow,
    });

    surface.element.scrollTop = -1_000;
    surface.element.dispatchEvent(new Event("scroll"));
    expect(surface.element.textContent).toContain("Folder 0");

    surface.element.scrollTop = Number.NaN;
    surface.element.dispatchEvent(new Event("scroll"));
    expect(surface.element.textContent).toContain("Folder 0");

    surface.element.scrollTop = Number.POSITIVE_INFINITY;
    surface.element.dispatchEvent(new Event("scroll"));
    expect(surface.element.textContent).toContain("Folder 199");
    expect(surface.element.querySelector('[data-row-index="199"]')).not.toBeNull();
  });

  it("removes its scroll listener on an idempotent dispose", () => {
    const surface = createWindowedList(document, {
      rows: Array.from({ length: 200 }, (_, index) => `Folder ${index}`),
      rowHeight: 44,
      windowSize: 100,
      overscan: 10,
      renderRow: renderTextRow,
    });

    surface.dispose();
    surface.dispose();
    surface.element.scrollTop = 44 * 200;
    surface.element.dispatchEvent(new Event("scroll"));

    expect(surface.element.textContent).toContain("Folder 0");
    expect(surface.element.textContent).not.toContain("Folder 199");
  });

  it.each([
    ["rowHeight", { rowHeight: 0, windowSize: 100, overscan: 10 }],
    ["rowHeight", { rowHeight: -1, windowSize: 100, overscan: 10 }],
    ["windowSize", { rowHeight: 44, windowSize: 0, overscan: 10 }],
    ["windowSize", { rowHeight: 44, windowSize: -1, overscan: 10 }],
    ["overscan", { rowHeight: 44, windowSize: 100, overscan: -1 }],
  ] as const)("rejects an invalid %s", (_field, dimensions) => {
    expect(() => createWindowedList(document, {
      rows: [],
      ...dimensions,
      renderRow: renderTextRow,
    })).toThrow(RangeError);
  });
});
