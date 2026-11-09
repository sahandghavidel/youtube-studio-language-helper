export function showWorkflow(ui, manual) {
  ui["manual-view"].hidden = !manual;
  ui["watch-view"].hidden = manual;
  ui["view-manual"].setAttribute("aria-pressed", String(manual));
  ui["view-watch"].setAttribute("aria-pressed", String(!manual));
}

export async function copyText(button, text) {
  const label = button.dataset.label || button.textContent;
  button.dataset.label = label;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed · retry";
  }
  setTimeout(() => { button.textContent = label; }, 1800);
}

export function renderPreview(container, rows) {
  container.replaceChildren();
  const groups = [["To add", ["Add"]], ["Will skip", ["Skip"]], ["Needs review", ["Hold", "Review"]]];
  for (const [title, decisions] of groups) {
    const items = rows.filter(row => decisions.includes(row[3]));
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = title + " · " + items.length;
    details.append(summary);
    const list = document.createElement("div");
    list.className = "preview-rows";
    for (const [language, entries] of Object.entries(Object.groupBy(items, row => row[0]))) {
      const name = document.createElement("strong");
      name.textContent = language;
      list.append(name);
      for (const [, component, file, , reason] of entries) {
        const line = document.createElement("p");
        line.textContent = [component, file, reason].join(" · ");
        list.append(line);
      }
    }
    if (!items.length) list.textContent = "No matching files.";
    details.append(list);
    container.append(details);
  }
}
