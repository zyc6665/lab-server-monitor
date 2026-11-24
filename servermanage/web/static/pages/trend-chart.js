/* Overview trend chart rendering (M2: extracted from app.js).
 * Pure SVG building: the caller passes the target <svg> and the series. */
import { overviewPathIndexed, overviewTrendText } from './overview-trends.js';
import { formatPercent } from '../lib/format.js';

var OVERVIEW_COLORS = { cpu: '#2563eb', memory: '#7c3aed', disk: '#059669', gpu_util: '#d97706', load_1: '#0ea5e9' };

export function overviewSvgEl(name, attrs) {
  var el = document.createElementNS(OVERVIEW_SVG_NS, name);
  Object.keys(attrs || {}).forEach(function (key) { el.setAttribute(key, attrs[key]); });
  return el;
}

export function overviewPath(values, min, max, width, height, padX, padY) {
  var span = Math.max(1, values.length - 1);
  var coords = [];
  values.forEach(function (value, index) {
    if (value === null || value === undefined || isNaN(Number(value))) { return; }
    coords.push([
      padX + (width - padX * 2) * (index / span),
      height - padY - (height - padY * 2) * ((Number(value) - min) / (max - min))
    ]);
  });
  return coords;
}

export function drawOverviewTrend(svg, values, key, previous, labels) {
  if (!svg) { return; }
  while (svg.firstChild) { svg.removeChild(svg.firstChild); }
  var numbers = overviewNumbers(values);
  var history = overviewNumbers(previous);
  var latest = document.querySelector('[data-overview-latest="' + key + '"]');
  if (latest) {
    latest.textContent = numbers.length
      ? (key === 'load_1' ? numbers[numbers.length - 1].toFixed(2) : formatPercent(numbers[numbers.length - 1]))
      : '';
  }
  if (numbers.length < 2) { return; }
  var width = 300, height = 84, padX = 8, padY = 8;
  var chartH = height - 12;
  var scale = numbers.concat(history.length >= 2 ? history : []);
  var min = Math.min.apply(null, scale), max = Math.max.apply(null, scale);
  if (max - min < 1) { max = min + 1; }
  var indexed = overviewPathIndexed(values, min, max, width, chartH, padX, padY);
  var points = indexed.map(function (point) { return [point[0], point[1]]; });
  [0, 0.5, 1].forEach(function (fraction) {
    var y = padY + (chartH - padY * 2) * fraction;
    svg.appendChild(overviewSvgEl('line', {
      x1: padX, x2: width - padX, y1: y, y2: y, stroke: '#e8edf5', 'stroke-width': '1'
    }));
  });
  var previousPoints = history.length >= 2
    ? overviewPath(previous, min, max, width, chartH, padX, padY)
    : [];
  if (previousPoints.length >= 2) {
    svg.appendChild(overviewSvgEl('path', {
      d: previousPoints.map(function (point, index) {
        return (index ? 'L' : 'M') + point[0].toFixed(1) + ' ' + point[1].toFixed(1);
      }).join(' '),
      fill: 'none', stroke: OVERVIEW_COLORS[key], 'stroke-width': '1.4',
      'stroke-dasharray': '4 4', 'stroke-opacity': '0.45', 'stroke-linecap': 'round'
    }));
  }
  svg.appendChild(overviewSvgEl('path', {
    d: points.map(function (point, index) {
      return (index ? 'L' : 'M') + point[0].toFixed(1) + ' ' + point[1].toFixed(1);
    }).join(' '),
    fill: 'none', stroke: OVERVIEW_COLORS[key], 'stroke-width': '2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round'
  }));
  var last = points[points.length - 1];
  svg.appendChild(overviewSvgEl('circle', { cx: last[0], cy: last[1], r: '2.8', fill: OVERVIEW_COLORS[key] }));
  if (labels && labels.length) {
    [[0, 'start'], [Math.floor((labels.length - 1) / 2), 'middle'], [labels.length - 1, 'end']].forEach(function (pair) {
      if (!labels[pair[0]]) { return; }
      var tick = overviewSvgEl('text', {
        x: pair[1] === 'start' ? padX : (pair[1] === 'end' ? width - padX : width / 2),
        y: height - 2,
        'text-anchor': pair[1],
        fill: '#8a93a3',
        'font-size': '7.5'
      });
      tick.textContent = labels[pair[0]];
      svg.appendChild(tick);
    });
  }
  bindOverviewHover(svg, indexed, values, key, labels || []);
}

export function bindOverviewHover(svg, indexed, values, key, labels) {
  if (!indexed.length) { return; }
  var width = 300, height = 84;
  var cross = overviewSvgEl('line', {
    x1: 0, x2: 0, y1: 8, y2: height - 8, stroke: '#b8c2d4',
    'stroke-width': '1', 'stroke-dasharray': '3 3', opacity: '0'
  });
  var dot = overviewSvgEl('circle', { cx: 0, cy: 0, r: '3', fill: OVERVIEW_COLORS[key], opacity: '0' });
  var label = overviewSvgEl('text', {
    x: width - 8, y: 11, 'text-anchor': 'end',
    fill: '#5b6472', 'font-size': '9', opacity: '0'
  });
  svg.appendChild(cross);
  svg.appendChild(dot);
  svg.appendChild(label);
  svg.addEventListener('mousemove', function (event) {
    var rect = svg.getBoundingClientRect();
    if (!rect.width) { return; }
    var x = (event.clientX - rect.left) / rect.width * width;
    var best = 0;
    for (var i = 1; i < indexed.length; i += 1) {
      if (Math.abs(indexed[i][0] - x) < Math.abs(indexed[best][0] - x)) { best = i; }
    }
    var point = indexed[best];
    var stamp = labels[point[2]] || '';
    cross.setAttribute('x1', point[0]);
    cross.setAttribute('x2', point[0]);
    cross.setAttribute('opacity', '0.9');
    dot.setAttribute('cx', point[0]);
    dot.setAttribute('cy', point[1]);
    dot.setAttribute('opacity', '1');
    label.textContent = (stamp ? stamp + ' · ' : '') + overviewTrendText(values[point[2]], key);
    label.setAttribute('opacity', '1');
  });
  svg.addEventListener('mouseleave', function () {
    cross.setAttribute('opacity', '0');
    dot.setAttribute('opacity', '0');
    label.setAttribute('opacity', '0');
  });
}
