export function renderAiSuggestion(root: HTMLElement, text: string): void {
  const wrap = root.ownerDocument.createElement("section");
  wrap.className = "knowledge-workbench__ai-suggestion";
  const heading = root.ownerDocument.createElement("h3");
  heading.textContent = "AI suggestion";
  const value = root.ownerDocument.createElement("p");
  value.textContent = text;
  wrap.append(heading, value);
  root.append(wrap);
}
