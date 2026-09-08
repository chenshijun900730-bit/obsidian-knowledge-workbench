export interface WindowedListSurface<T> {
  readonly element: HTMLUListElement;
  update(rows: readonly T[]): void;
  dispose(): void;
}

interface WindowedListOptions<T> {
  readonly rows: readonly T[];
  readonly rowHeight: number;
  readonly windowSize: number;
  readonly overscan: number;
  readonly renderRow: (row: T, index: number) => HTMLLIElement;
}

const requirePositiveFinite = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
};

const requireNonNegativeFinite = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number`);
  }
};

export function createWindowedList<T>(
  document: Document,
  options: Readonly<WindowedListOptions<T>>,
): WindowedListSurface<T> {
  requirePositiveFinite(options.rowHeight, "rowHeight");
  requirePositiveFinite(options.windowSize, "windowSize");
  requireNonNegativeFinite(options.overscan, "overscan");

  const list = document.createElement("ul");
  list.className = "knowledge-workbench__windowed-list";
  let rows = options.rows.slice();
  let renderedStart = -1;

  const paint = (): void => {
    const maximumStart = Math.max(0, rows.length - options.windowSize);
    const rawStart = Math.floor(list.scrollTop / options.rowHeight) - options.overscan;
    const finiteStart = Number.isFinite(rawStart)
      ? rawStart
      : rawStart === Number.POSITIVE_INFINITY
        ? maximumStart
        : 0;
    const start = Math.min(maximumStart, Math.max(0, finiteStart));
    if (start === renderedStart) return;
    renderedStart = start;
    list.replaceChildren();

    if (start > 0) {
      const before = document.createElement("li");
      before.className = "knowledge-workbench__window-spacer";
      before.setAttribute("aria-hidden", "true");
      before.style.height = `${start * options.rowHeight}px`;
      list.append(before);
    }

    const end = Math.min(rows.length, start + options.windowSize);
    for (let index = start; index < end; index += 1) {
      list.append(options.renderRow(rows[index]!, index));
    }

    if (end < rows.length) {
      const after = document.createElement("li");
      after.className = "knowledge-workbench__window-spacer";
      after.setAttribute("aria-hidden", "true");
      after.style.height = `${(rows.length - end) * options.rowHeight}px`;
      list.append(after);
    }
  };

  const ListenerAbortController = document.defaultView?.AbortController ?? AbortController;
  const listenerAbort = new ListenerAbortController();
  list.addEventListener("scroll", paint, { passive: true, signal: listenerAbort.signal });

  const update = (nextRows: readonly T[]): void => {
    rows = nextRows.slice();
    list.dataset.totalRows = String(rows.length);
    renderedStart = -1;
    paint();
  };

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    listenerAbort.abort();
  };

  list.dataset.totalRows = String(rows.length);
  paint();
  return { element: list, update, dispose };
}
