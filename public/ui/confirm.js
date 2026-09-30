// @ts-check
/**
 * Risk gating (WEB_PORT_PLAN.md section 11). Safe commands send immediately. Caution commands
 * show a confirmation with the exact bytes. Danger commands show the bytes, a plain-language
 * statement of what will happen, the preconditions and the source document, and need a second
 * deliberate click.
 */
import { h, openDialog, closeDialog } from "./dom.js";
import { toHex, printable } from "../core/bytes.js";

/**
 * @param {{
 *   risk: "safe" | "caution" | "danger",
 *   device: string,
 *   command: string,
 *   description?: string,
 *   value?: any,
 *   bytes: Uint8Array,
 *   notes?: string[],
 *   source?: string,
 * }} request
 * @returns {Promise<boolean>}
 */
export function confirmSend(request) {
  if (request.risk === "safe") return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (/** @type {boolean} */ ok) => {
      if (settled) return;
      settled = true;
      closeDialog("confirmDialog");
      resolve(ok);
    };
    const danger = request.risk === "danger";
    let armed = false;
    const sendButton = /** @type {HTMLButtonElement} */ (h(`button.button.${danger ? "danger" : "primary"}`, { type: "button" }, danger ? "I understand — arm" : "Send"));
    sendButton.onclick = () => {
      if (danger && !armed) {
        armed = true;
        sendButton.textContent = "Send now";
        sendButton.focus();
        return;
      }
      finish(true);
    };
    openDialog("confirmDialog", {
      title: danger ? `Danger: ${request.command}` : `Confirm: ${request.command}`,
      body: [
        h("div", null, h(`span.risk.${request.risk}`, null, request.risk), " ", h("strong", null, request.device)),
        request.description ? h("p", null, request.description) : null,
        request.value !== undefined && request.value !== null && request.value !== "" ? h("p", null, "Value: ", h("code", null, String(request.value))) : null,
        danger
          ? h("div.callout.danger", null,
              h("strong", null, "This changes the gauge. "),
              "Configuration writes, adjustments and setpoint writes can move relays that may be wired into valve or pump interlocks. ",
              "Nothing is written until you arm and send.")
          : null,
        ...(request.notes ?? []).map((n) => h("div.callout.warn", null, n)),
        h("div.field", null, h("span.field-label", null, "Exact bytes"), h("div.byte-preview", null, toHex(request.bytes)), h("div.hint", null, printable(request.bytes))),
        request.source ? h("div.hint", null, `Source: ${request.source}`) : null
      ],
      actions: [h("button.button", { type: "button", onclick: () => finish(false) }, "Cancel"), sendButton],
      onClose: () => finish(false)
    });
  });
}

/**
 * One confirmation for a group of writes that belong together (the setpoint editor's Apply,
 * Spectrum Studio's algorithm start): every command, its value and its exact bytes are listed.
 * A danger batch (the default) needs the same arm-then-send second click as a danger command;
 * a caution batch sends on one click.
 * @param {{
 *   title: string,
 *   device: string,
 *   description?: string,
 *   items: { command: string, label?: string, value?: any, bytes: Uint8Array }[],
 *   notes?: string[],
 *   source?: string,
 *   risk?: "caution" | "danger",
 *   warning?: string,
 * }} request
 * @returns {Promise<boolean>}
 */
export function confirmBatch(request) {
  const danger = (request.risk ?? "danger") === "danger";
  return new Promise((resolve) => {
    let settled = false;
    const finish = (/** @type {boolean} */ ok) => {
      if (settled) return;
      settled = true;
      closeDialog("confirmDialog");
      resolve(ok);
    };
    let armed = !danger;
    const count = `${request.items.length} write${request.items.length === 1 ? "" : "s"}`;
    const sendButton = /** @type {HTMLButtonElement} */ (h(`button.button.${danger ? "danger" : "primary"}`, { type: "button" }, danger ? "I understand — arm" : `Send ${count}`));
    sendButton.onclick = () => {
      if (!armed) {
        armed = true;
        sendButton.textContent = `Send ${count} now`;
        sendButton.focus();
        return;
      }
      finish(true);
    };
    openDialog("confirmDialog", {
      title: request.title,
      body: [
        h("div", null, h(`span.risk.${danger ? "danger" : "caution"}`, null, danger ? "danger" : "caution"), " ", h("strong", null, request.device)),
        request.description ? h("p", null, request.description) : null,
        h(`div.callout.${danger ? "danger" : "warn"}`, null,
          h("strong", null, "This changes the gauge. "),
          request.warning ?? "Setpoint relays may be wired into valve or pump interlocks. The writes are sent one at a time, in this order, and read back afterwards.",
          danger ? " Nothing is written until you arm and send." : " The writes are sent one at a time, in this order."),
        ...(request.notes ?? []).map((n) => h("div.callout.warn", null, n)),
        h("div.batch-list", null, request.items.map((item) => h("div.batch-item", null,
          h("span", null, h("strong", null, item.label ?? item.command), " ", h("span.hint", null, item.command)),
          h("span.mono", null, item.value === undefined || item.value === "" ? "" : String(item.value)),
          h("code", null, `${toHex(item.bytes)}   ${printable(item.bytes)}`)))),
        request.source ? h("div.hint", null, `Source: ${request.source}`) : null
      ],
      actions: [h("button.button", { type: "button", onclick: () => finish(false) }, "Cancel"), sendButton],
      onClose: () => finish(false)
    });
  });
}
