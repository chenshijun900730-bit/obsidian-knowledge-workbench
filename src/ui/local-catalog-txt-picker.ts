export interface LocalCatalogTxtPicker {
  request(host: HTMLElement): Promise<string | null>;
}

type NativePathFile = File & Readonly<{ path?: unknown }>;

const nativePath = (file: NativePathFile | undefined): string | null => (
  file !== undefined && typeof file.path === "string" && file.path.length > 0
    ? file.path
    : null
);

const requestLocalCatalogTxtPath = (host: HTMLElement): Promise<string | null> => (
  new Promise((resolve) => {
    const input = host.ownerDocument.createElement("input");
    input.type = "file";
    input.accept = ".txt,text/plain";
    input.hidden = true;
    const hostWasConnected = host.isConnected;
    let settled = false;
    let observer: MutationObserver | null = null;

    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      observer = null;
      input.removeEventListener("change", onChange);
      input.removeEventListener("cancel", onCancel);
      input.remove();
      resolve(value);
    };
    const onChange = (): void => {
      settle(nativePath(input.files?.[0]));
    };
    const onCancel = (): void => {
      settle(null);
    };

    input.addEventListener("change", onChange);
    input.addEventListener("cancel", onCancel);
    host.append(input);
    const Observer = host.ownerDocument.defaultView?.MutationObserver ?? MutationObserver;
    observer = new Observer(() => {
      if (!host.contains(input) || (hostWasConnected && !host.isConnected)) settle(null);
    });
    observer.observe(hostWasConnected ? host.ownerDocument : host, {
      childList: true,
      subtree: true,
    });
    try {
      input.click();
    } catch {
      settle(null);
    }
  })
);

export const createLocalCatalogTxtPicker = (): LocalCatalogTxtPicker => ({
  request: (host) => requestLocalCatalogTxtPath(host),
});
