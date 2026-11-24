/* Pure helpers for the overview trend charts (M2: extracted from app.js).
 * No DOM access, no global state — safe to import in Node tests. */
import { formatPercent } from '../lib/format.js';

export function overviewNumbers(values) {
  return (values || []).filter(function (v) {
    return v !== null && v !== undefined && !isNaN(Number(v));
  }).map(Number);
}

export function overviewPathIndexed(values, min, max, width, height, padX, padY) {
  var span = Math.max(1, values.length - 1);
  var coords = [];
  values.forEach(function (value, index) {
    if (value === null || value === undefined || isNaN(Number(value))) { return; }
    coords.push([
      padX + (width - padX * 2) * (index / span),
      height - padY - (height - padY * 2) * ((Number(value) - min) / (max - min)),
      index
    ]);
  });
  return coords;
}

export function overviewTrendText(value, key) {
  if (value === null || value === undefined || isNaN(Number(value))) { return ''; }
  var num = Number(value);
  return key === 'load_1' ? num.toFixed(2) : formatPercent(num);
}
