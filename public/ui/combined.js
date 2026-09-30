// @ts-check
/**
 * Combined tab: overlay, stacked and grid layouts, visibility toggles, per-device colours,
 * synchronised navigation (one TrendView shared by every chart), and full session history per
 * series so gauges at different poll rates share one time axis.
 */
import { h, replace } from "./dom.js";
import { Trend, TrendView } from "./trend.js";
import { isPressureUnit } from "../core/units.js";

export class CombinedTab {
  /** @param {any} app */
  constructor(app) {
    this.app = app;
    this.view = new TrendView();
    this.el = h("div.panel", { role: "tabpanel" });
    /** @type {Trend[]} */
    this.trends = [];
    this.build();
  }

  entries() {
    const layout = this.app.state.layout;
    const out = [];
    for (const d of this.app.state.devices.values()) {
      for (const series of d.series.values()) {
        if (!isPressureUnit(series.unit) && !series.id.endsWith(":pressure")) continue;
        const key = series.id;
        out.push({ key, device: d, series, color: layout.colors[key] ?? d.color, label: `${d.label}${series.id.endsWith(":pressure") ? "" : ` ${series.id.split(":").pop()}`}`, visible: !layout.hidden.includes(key) });
      }
    }
    return out;
  }

  build() {
    for (const t of this.trends) t.destroy();
    this.trends = [];
    const layout = this.app.state.layout;
    const entries = this.entries();
    const modes = h("div.segmented", { role: "group", "aria-label": "Layout" },
      ...["overlay", "stacked", "grid"].map((m) => h("button", { type: "button", "aria-pressed": String(layout.combined === m), onclick: () => {
        layout.combined = m;
        this.app.markDirty();
        this.build();
      } }, m[0].toUpperCase() + m.slice(1))));
    const legend = h("div.legend", null, entries.map((e) => {
      const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: e.visible }));
      box.onchange = () => {
        layout.hidden = box.checked ? layout.hidden.filter((/** @type {string} */ k) => k !== e.key) : [...layout.hidden, e.key];
        this.app.markDirty();
        if (layout.combined !== "overlay") this.build();
        else for (const t of this.trends) t.markDirty();
      };
      const color = /** @type {HTMLInputElement} */ (h("input", { type: "color", value: e.color, "aria-label": `Colour for ${e.label}` }));
      color.oninput = () => {
        layout.colors[e.key] = color.value;
        for (const t of this.trends) t.markDirty();
        this.app.markDirty();
      };
      return h("label", null, box, color, e.label);
    }));

    const grid = h(`div.combined-grid${layout.combined === "grid" ? ".grid" : ""}`);
    if (!entries.length) {
      grid.append(h("p.empty", null, "Add gauges to compare them here."));
    } else if (layout.combined === "overlay") {
      const trend = new Trend({ view: this.view, height: 380, displayUnit: () => this.app.displayUnit(), getSeries: () => this.entries(), title: "All gauges" });
      this.trends.push(trend);
      grid.append(h("div.card", null, trend.el));
    } else {
      let first = true;
      for (const e of entries.filter((x) => x.visible)) {
        const trend = new Trend({
          view: this.view,
          height: layout.combined === "grid" ? 220 : 180,
          displayUnit: () => this.app.displayUnit(),
          getSeries: () => this.entries().filter((x) => x.key === e.key),
          toolbar: first,
          title: first ? "Synchronised" : undefined
        });
        first = false;
        this.trends.push(trend);
        grid.append(h("div.card", null, h("div.row", null, h("span", { style: { color: e.color } }, "■"), h("strong", null, e.label)), trend.el));
      }
    }
    replace(this.el, h("div.card", null, h("div.row", null, h("h3.card-title", { style: { margin: 0 } }, "Combined"), modes, h("div.grow")), h("div", { style: { marginTop: "10px" } }, legend)), grid);
  }

  update() {}

  destroy() {
    for (const t of this.trends) t.destroy();
  }
}
