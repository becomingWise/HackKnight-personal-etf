export const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const time = date => Date.parse(date);
const dateLabel = date => new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const shortDate = date => new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const valueLabel = (value, odds) => odds ? `${(value * 100).toFixed(1)}% Yes` : value.toFixed(2);
const charts = new Map();

export function chartMarkup({ id, label, history, projection = [], odds = false }) {
  const observed = history.filter(p => Number.isFinite(p.close) && Number.isFinite(time(p.date)));
  if (observed.length < 2) { charts.delete(id); return '<p class="chart-empty">Not enough observed history to draw this chart.</p>'; }
  const points = [...observed.map(p => ({ ...p, kind: "Observed" })), ...projection.slice(1).map(p => ({ ...p, kind: "Illustrative scenario" }))];
  charts.set(id, { points, odds });
  const width = 680, height = 225, left = 47, right = 14, top = 22, bottom = 31;
  const start = time(points[0].date), end = time(points.at(-1).date);
  const ys = points.flatMap(p => [p.close, p.low ?? p.close, p.high ?? p.close]);
  const minimum = Math.min(...ys), maximum = Math.max(...ys), span = Math.max(maximum - minimum, odds ? 0.05 : 2);
  const low = odds ? Math.max(0, minimum - span * 0.12) : minimum - span * 0.12;
  const high = odds ? Math.min(1, maximum + span * 0.12) : maximum + span * 0.12;
  const x = date => left + (time(date) - start) / Math.max(end - start, 1) * (width - left - right);
  const y = value => height - bottom - (value - low) / Math.max(high - low, .001) * (height - top - bottom);
  const line = (rows, key = "close") => rows.map((p, i) => `${i ? "L" : "M"}${x(p.date).toFixed(2)},${y(p[key]).toFixed(2)}`).join(" ");
  const axis = [0, 1, 2, 3].map(i => {
    const value = low + (high - low) * i / 3;
    return `<line x1="${left}" y1="${y(value)}" x2="${width-right}" y2="${y(value)}" stroke="#e5e5dc"/><text x="${left-9}" y="${y(value)+4}" text-anchor="end">${odds ? (value*100).toFixed(0)+'%' : value.toFixed(0)}</text>`;
  }).join("");
  const axisDate = new Date(points[0].date).getUTCFullYear() !== new Date(points.at(-1).date).getUTCFullYear() ? dateLabel : shortDate;
  const last = observed.at(-1);
  const future = projection.length > 1 ? `<path class="uncertainty-band" d="${line(projection, 'high')} ${[...projection].reverse().map(p => `L${x(p.date).toFixed(2)},${y(p.low).toFixed(2)}`).join(' ')} Z"/><line x1="${x(last.date)}" y1="${top}" x2="${x(last.date)}" y2="${height-bottom}" stroke="#c9c8ba" stroke-dasharray="3 4"/><text x="${Math.min(x(last.date)+6,width-120)}" y="13">ILLUSTRATIVE SCENARIO</text><path class="scenario-line" d="${line(projection)}"/>` : "";
  return `<div class="line-chart" data-chart="${escape(id)}"><svg viewBox="0 0 ${width} ${height}" tabindex="0" role="img" aria-label="${escape(label)}. Use left and right arrows to inspect dates." data-start="${start}" data-end="${end}" data-low="${low}" data-high="${high}"><g class="chart-axis">${axis}${future}<text x="${left}" y="${height-6}">${axisDate(points[0].date)}</text><text x="${width-right}" y="${height-6}" text-anchor="end">${axisDate(points.at(-1).date)}</text></g><path class="history-line" d="${line(observed)}"/><circle cx="${x(last.date)}" cy="${y(last.close)}" r="3" fill="#17634d"/><line class="chart-cursor" x1="0" x2="0" y1="${top}" y2="${height-bottom}" hidden/><circle class="chart-marker" r="4" hidden/></svg><div class="chart-tooltip" role="status" aria-live="polite" hidden></div></div>`;
}

export function bindCharts(root) {
  for (const element of root.querySelectorAll("[data-chart]")) {
    const config = charts.get(element.dataset.chart), svg = element.querySelector("svg"), tip = element.querySelector(".chart-tooltip");
    if (!config) continue;
    const { points, odds } = config;
    let index = points.findLastIndex(p => p.kind === "Observed");
    const show = i => {
      index = Math.max(0, Math.min(points.length - 1, i)); const p = points[index];
      const x = 47 + (time(p.date) - Number(svg.dataset.start)) / Math.max(Number(svg.dataset.end) - Number(svg.dataset.start), 1) * 619;
      const y = 194 - (p.close - Number(svg.dataset.low)) / Math.max(Number(svg.dataset.high) - Number(svg.dataset.low), .001) * 172;
      const cursor = element.querySelector(".chart-cursor"), marker = element.querySelector(".chart-marker");
      cursor.hidden = false; cursor.removeAttribute("hidden"); cursor.setAttribute("x1", x); cursor.setAttribute("x2", x);
      marker.removeAttribute("hidden"); marker.setAttribute("cx", x); marker.setAttribute("cy", y);
      tip.hidden = false;
      tip.innerHTML = `<strong>${escape(dateLabel(p.date))}</strong><span>${p.kind} · ${valueLabel(p.close, odds)}</span>${p.low != null ? `<small>Fit interval: ${valueLabel(p.low, odds)} – ${valueLabel(p.high, odds)}</small>` : ""}`;
      tip.style.left = `${Math.max(2, Math.min(62, x / 680 * 100))}%`;
    };
    svg.addEventListener("pointermove", event => {
      const rect = svg.getBoundingClientRect();
      const target = Number(svg.dataset.start) + Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * 680 - 47) / 619)) * (Number(svg.dataset.end) - Number(svg.dataset.start));
      let lo = 0, hi = points.length - 1;
      while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (time(points[mid].date) < target) lo = mid + 1; else hi = mid; }
      show(lo > 0 && target - time(points[lo-1].date) < time(points[lo].date) - target ? lo - 1 : lo);
    });
    const hide = () => { tip.hidden = true; element.querySelector(".chart-cursor").setAttribute("hidden", ""); element.querySelector(".chart-marker").setAttribute("hidden", ""); };
    svg.addEventListener("pointerleave", hide); svg.addEventListener("blur", hide); svg.addEventListener("focus", () => show(index));
    svg.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); show(event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : index + (event.key === "ArrowRight" ? 1 : -1));
    });
  }
}
