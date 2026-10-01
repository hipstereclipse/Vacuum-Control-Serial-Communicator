// @ts-check
/**
 * Row multi-selection for tables, matching CSC's extended selection: a click selects one row,
 * Ctrl/Cmd-click toggles a row, Shift-click selects the range from the last clicked row, and
 * dragging with the button held selects the range under the pointer. A row's checkbox toggles
 * only that row. Used by the Add Gauge results and the Simulate dialog's model list.
 */

/**
 * @template T
 * @param {{ row: HTMLElement, box?: HTMLInputElement | null }[]} rows   in the same order as items
 * @param {(T & { selected: boolean })[]} items
 * @param {() => void} [onChange]   after every change of the selection
 * @returns {{ sync: () => void }}
 */
export function bindRowSelection(rows, items, onChange = () => {}) {
  let anchor = -1;
  let dragging = false;
  const sync = () => {
    rows.forEach(({ row, box }, i) => {
      row.classList.toggle("selected", items[i].selected);
      row.setAttribute("aria-selected", String(items[i].selected));
      if (box) box.checked = items[i].selected;
    });
  };
  const changed = () => {
    sync();
    onChange();
  };
  /** @param {number} a @param {number} b @param {boolean} [exclusive] */
  const selectRange = (a, b, exclusive = true) => {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    items.forEach((x, i) => {
      if (i >= lo && i <= hi) x.selected = true;
      else if (exclusive) x.selected = false;
    });
  };
  const stop = () => {
    dragging = false;
    window.removeEventListener("mouseup", stop);
  };
  rows.forEach(({ row, box }, idx) => {
    row.classList.add("selectable-row");
    if (box) {
      // The checkbox toggles its own row and nothing else.
      box.addEventListener("mousedown", (e) => e.stopPropagation());
      box.addEventListener("click", (e) => e.stopPropagation());
      box.addEventListener("change", () => {
        items[idx].selected = box.checked;
        anchor = idx;
        changed();
      });
    }
    row.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const target = /** @type {HTMLElement} */ (e.target);
      if (target.closest("input, select, button, a, label")) return;
      e.preventDefault(); // no text selection while dragging
      if (e.ctrlKey || e.metaKey) {
        items[idx].selected = !items[idx].selected;
        anchor = idx;
      } else if (e.shiftKey && anchor >= 0) {
        selectRange(anchor, idx, false);
      } else {
        items.forEach((x, i) => (x.selected = i === idx));
        anchor = idx;
        dragging = true;
        window.addEventListener("mouseup", stop);
      }
      changed();
    });
    row.addEventListener("mouseenter", (e) => {
      if (!dragging || !(e.buttons & 1) || anchor < 0) return;
      selectRange(anchor, idx);
      changed();
    });
  });
  sync();
  return { sync };
}
