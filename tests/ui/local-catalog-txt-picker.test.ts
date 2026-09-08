// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createLocalCatalogTxtPicker } from "../../src/ui/local-catalog-txt-picker";

const hostElement = (): HTMLElement => {
  return document.body.cloneNode(false) as HTMLElement;
};

const currentInput = (host: HTMLElement): HTMLInputElement => {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("missing file input");
  return input;
};

const setFiles = (input: HTMLInputElement, files: readonly File[]): void => {
  Object.defineProperty(input, "files", {
    configurable: true,
    value: files,
  });
};

const hostFile = (name: string, path: unknown): File => {
  const file = new File(["catalog"], name, { type: "text/plain" });
  Object.defineProperty(file, "path", {
    configurable: true,
    value: path,
  });
  return file;
};

describe("local catalog TXT picker", () => {
  it("opens one hidden TXT-only host input", () => {
    const host = hostElement();
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);

    void createLocalCatalogTxtPicker().request(host);

    const input = currentInput(host);
    expect(input.accept).toBe(".txt,text/plain");
    expect(input.hidden).toBe(true);
    expect(click).toHaveBeenCalledOnce();
  });

  it("returns null on cancel and removes the transient input", async () => {
    const host = hostElement();
    const result = createLocalCatalogTxtPicker().request(host);
    const input = currentInput(host);

    input.dispatchEvent(new Event("cancel"));

    await expect(result).resolves.toBeNull();
    expect(host.querySelector("input")).toBeNull();
  });

  it("returns only a selected host file with a non-empty native path", async () => {
    const host = hostElement();
    const picker = createLocalCatalogTxtPicker();
    const missingPath = picker.request(host);
    let input = currentInput(host);
    setFiles(input, [new File(["catalog"], "catalog.txt", { type: "text/plain" })]);
    input.dispatchEvent(new Event("change"));
    await expect(missingPath).resolves.toBeNull();

    const blankPath = picker.request(host);
    input = currentInput(host);
    setFiles(input, [hostFile("catalog.txt", "")]);
    input.dispatchEvent(new Event("change"));
    await expect(blankPath).resolves.toBeNull();

    const selected = picker.request(host);
    input = currentInput(host);
    setFiles(input, [hostFile("catalog.txt", "/Synthetic/Private/catalog.txt")]);
    input.dispatchEvent(new Event("change"));
    await expect(selected).resolves.toBe("/Synthetic/Private/catalog.txt");
    expect(host.querySelector("input")).toBeNull();
  });

  it("settles once when change and cancel events repeat", async () => {
    const host = hostElement();
    const picker = createLocalCatalogTxtPicker();
    const result = picker.request(host);
    const input = currentInput(host);
    setFiles(input, [hostFile("catalog.txt", "/Synthetic/First/catalog.txt")]);

    input.dispatchEvent(new Event("change"));
    input.dispatchEvent(new Event("cancel"));
    setFiles(input, [hostFile("catalog.txt", "/Synthetic/Second/catalog.txt")]);
    input.dispatchEvent(new Event("change"));

    await expect(result).resolves.toBe("/Synthetic/First/catalog.txt");
    expect(host.childElementCount).toBe(0);
  });

  it("fails closed when the connected host is removed while awaiting a choice", async () => {
    const host = hostElement();
    document.body.append(host);
    const result = createLocalCatalogTxtPicker().request(host);
    const input = currentInput(host);

    host.remove();
    await new Promise<void>((resolve) => { queueMicrotask(resolve); });

    await expect(result).resolves.toBeNull();
    expect(host.querySelector("input")).toBeNull();
    setFiles(input, [hostFile("catalog.txt", "/Synthetic/Too-Late/catalog.txt")]);
    input.dispatchEvent(new Event("change"));
    input.dispatchEvent(new Event("cancel"));
    await expect(result).resolves.toBeNull();
  });

  it("does not retain or render the selected native path after settlement", async () => {
    const host = hostElement();
    const picker = createLocalCatalogTxtPicker();
    const result = picker.request(host);
    const input = currentInput(host);
    const privatePath = "/Synthetic/Secret/catalog.txt";
    setFiles(input, [hostFile("catalog.txt", privatePath)]);

    input.dispatchEvent(new Event("change"));

    await expect(result).resolves.toBe(privatePath);
    expect(host.outerHTML).not.toContain(privatePath);
    expect(JSON.stringify(picker)).not.toContain(privatePath);
  });
});
