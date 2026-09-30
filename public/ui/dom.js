// @ts-check
/** Small DOM helpers; the UI is plain DOM so the core stays framework-free. */

/**
 * Create an element. `h("button.button.primary", { onclick }, "Add")`.
 * @param {string} tag  tag with optional .classes and #id
 * @param {Record<string, any> | null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props = null, ...children) {
  const [, name = "div", rest = ""] = /^([a-z0-9-]*)(.*)$/i.exec(tag) ?? [];
  const el = document.createElement(name || "div");
  for (const token of rest.match(/[.#][^.#]+/g) ?? []) {
    if (token[0] === ".") el.classList.add(token.slice(1));
    else el.id = token.slice(1);
  }
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key in el && key !== "list" && typeof value !== "string") /** @type {any} */ (el)[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

/** @param {Element} el @param {any[]} children */
function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** @param {string} selector @param {ParentNode} [root] */
export const $ = (selector, root = document) => /** @type {HTMLElement} */ (root.querySelector(selector));

/** @param {Element} el @param {...any} children */
export function replace(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

/**
 * @param {string} message
 * @param {"ok" | "warn" | "bad"} [kind]
 * @param {number} [ms]
 */
export function toast(message, kind = "ok", ms = 4500) {
  const region = document.getElementById("toastRegion");
  if (!region) return;
  const el = h(`div.toast.${kind}`, { role: kind === "bad" ? "alert" : "status" }, message);
  region.append(el);
  setTimeout(() => el.remove(), ms);
}

/**
 * Fill one of the page's dialog shells and show it.
 * @param {string} id
 * @param {{ title?: string, body: any[], actions?: any[], onClose?: () => void }} content
 */
export function openDialog(id, content) {
  const dialog = /** @type {HTMLDialogElement} */ (document.getElementById(id));
  if (content.title) dialog.querySelector("h2").textContent = content.title;
  replace(/** @type {Element} */ (dialog.querySelector('[data-role="body"]')), ...content.body);
  replace(/** @type {Element} */ (dialog.querySelector('[data-role="actions"]')), ...(content.actions ?? []));
  /** @type {HTMLElement} */ (dialog.querySelector('[data-role="actions"]')).hidden = !(content.actions ?? []).length;
  dialog.onclose = () => content.onClose?.();
  /** @type {HTMLButtonElement} */ (dialog.querySelector(".modal-close")).onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();
  return dialog;
}

/** @param {string} id */
export function closeDialog(id) {
  const dialog = /** @type {HTMLDialogElement} */ (document.getElementById(id));
  if (dialog?.open) dialog.close();
}

/** Download a text file. @param {string} name @param {string} content @param {string} [type] */
export function download(name, content, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** @param {number} ms */
export function formatClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * Series colours from the brand chart palette (secondary blues, then greys), ordered so the
 * first few stay distinct and readable on both the light and the dark theme.
 */
export const SERIES_COLORS = ["#1b74b3", "#7e848f", "#82b4d9", "#0f5e9e", "#a9aeb6", "#4993cb", "#124477", "#58646f"];
