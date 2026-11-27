/* 磁盘健康趋势（M6）：把某台主机最近 N 次采集画成一条状态色带 + 最高温度折线。
 * 纯函数便于测试；渲染全部走 DOM API（createElement / createElementNS），不拼 innerHTML。 */

var SVG_NS = 'http://www.w3.org/2000/svg';

/** 状态 → 色带用的语义类名。 */
export function statusClass(status) {
  var value = String(status == null ? '' : status).toLowerCase();
  if (value === 'ok') { return 'ok'; }
  if (value === 'degraded' || value === 'warning') { return 'warning'; }
  if (value === 'error' || value === 'critical') { return 'critical'; }
  if (value === 'no_storcli' || value === 'no_controller' || value === 'permission_denied') {
    return 'muted';
  }
  return 'unknown';
}

/** 每个采集点 → 一条色带段（含 tooltip 文案）。 */
export function buildStatusSegments(points) {
  var list = Array.isArray(points) ? points : [];
  return list.map(function (point) {
    var total = Number(point && point.drives) || 0;
    var status = String((point && point.status) || 'unknown');
    var parts = [String((point && point.t) || '')];
    parts.push(status);
    parts.push(total > 0 ? total + ' 块盘' : '无盘数据');
    if (point && Number(point.warning)) { parts.push('告警 ' + Number(point.warning)); }
    if (point && Number(point.critical)) { parts.push('严重 ' + Number(point.critical)); }
    if (point && point.max_temp !== null && point.max_temp !== undefined) {
      parts.push('最高 ' + point.max_temp + ' °C');
    }
    return {
      t: (point && point.t) || null,
      status: status,
      cls: statusClass(status),
      total: total,
      title: parts.join(' · '),
    };
  });
}

/** 抽出有数值的温度序列，按时间顺序（用于折线）。 */
export function buildTempSeries(points) {
  var list = Array.isArray(points) ? points : [];
  var series = [];
  for (var i = 0; i < list.length; i += 1) {
    var value = list[i] && list[i].max_temp;
    if (typeof value === 'number' && isFinite(value)) {
      series.push({ index: i, t: list[i].t || null, value: value });
    }
  }
  return series;
}

function svgEl(name) {
  return document.createElementNS(SVG_NS, name);
}

function clearNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

/**
 * 把一条趋势渲染进 `container`。返回 false 表示没有可绘制的点。
 * `points` 形如 [{t, status, drives, healthy, warning, critical, max_temp}]。
 */
export function renderDiskTrend(container, points) {
  if (!container) { return false; }
  clearNode(container);
  var list = Array.isArray(points) ? points : [];
  if (list.length === 0) {
    var empty = document.createElement('p');
    empty.className = 'muted small disk-trend-empty';
    empty.textContent = '暂无历史采集数据。';
    container.appendChild(empty);
    return false;
  }

  var segments = buildStatusSegments(list);

  var head = document.createElement('div');
  head.className = 'disk-trend-head';
  var caption = document.createElement('span');
  caption.className = 'disk-trend-caption';
  caption.textContent = '近 ' + list.length + ' 次采集';
  head.appendChild(caption);

  var legend = document.createElement('span');
  legend.className = 'disk-trend-legend';
  var legendItems = [
    ['ok', '正常'],
    ['warning', '告警'],
    ['critical', '严重'],
    ['unknown', '未知'],
  ];
  for (var i = 0; i < legendItems.length; i += 1) {
    var chip = document.createElement('span');
    chip.className = 'disk-trend-chip seg-' + legendItems[i][0];
    chip.textContent = legendItems[i][1];
    legend.appendChild(chip);
  }
  head.appendChild(legend);
  container.appendChild(head);

  var strip = document.createElement('div');
  strip.className = 'disk-trend-strip';
  strip.setAttribute('role', 'img');
  strip.setAttribute('aria-label', '磁盘状态时间线');
  for (var s = 0; s < segments.length; s += 1) {
    var seg = document.createElement('span');
    seg.className = 'disk-trend-seg seg-' + segments[s].cls;
    seg.setAttribute('title', segments[s].title);
    strip.appendChild(seg);
  }
  container.appendChild(strip);

  var temps = buildTempSeries(list);
  if (temps.length >= 2) {
    container.appendChild(buildTempChart(temps));
  }

  return true;
}

function buildTempChart(series) {
  var width = 320;
  var height = 72;
  var padL = 30;
  var padR = 10;
  var padT = 12;
  var padB = 16;
  var innerW = width - padL - padR;
  var innerH = height - padT - padB;

  var values = series.map(function (item) { return item.value; });
  var maxV = Math.max.apply(null, values);
  var minV = Math.min.apply(null, values);
  if (maxV === minV) { maxV = minV + 5; }
  var span = maxV - minV;
  var xStep = series.length > 1 ? innerW / (series.length - 1) : 0;

  var svg = svgEl('svg');
  svg.setAttribute('class', 'disk-trend-chart');
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '最高温度趋势');

  var pointsAttr = series.map(function (item, idx) {
    var x = padL + idx * xStep;
    var y = padT + innerH - ((item.value - minV) / span) * innerH;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');

  var polyline = svgEl('polyline');
  polyline.setAttribute('points', pointsAttr);
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', '#f59e0b');
  polyline.setAttribute('stroke-width', '2');
  svg.appendChild(polyline);

  for (var i = 0; i < series.length; i += 1) {
    var x2 = padL + i * xStep;
    var y2 = padT + innerH - ((series[i].value - minV) / span) * innerH;
    var dot = svgEl('circle');
    dot.setAttribute('cx', x2.toFixed(1));
    dot.setAttribute('cy', y2.toFixed(1));
    dot.setAttribute('r', '2.5');
    dot.setAttribute('fill', '#f59e0b');
    var tip = svgEl('title');
    tip.textContent = (series[i].t || '') + ' · ' + series[i].value + ' °C';
    dot.appendChild(tip);
    svg.appendChild(dot);
  }

  var maxLabel = svgEl('text');
  maxLabel.setAttribute('x', '2');
  maxLabel.setAttribute('y', String(padT + 6));
  maxLabel.setAttribute('font-size', '10');
  maxLabel.setAttribute('fill', '#94a3b8');
  maxLabel.textContent = maxV + '°';
  svg.appendChild(maxLabel);

  var minLabel = svgEl('text');
  minLabel.setAttribute('x', '2');
  minLabel.setAttribute('y', String(padT + innerH));
  minLabel.setAttribute('font-size', '10');
  minLabel.setAttribute('fill', '#94a3b8');
  minLabel.textContent = minV + '°';
  svg.appendChild(minLabel);

  var wrap = document.createElement('div');
  wrap.className = 'disk-trend-temp';
  wrap.appendChild(svg);
  return wrap;
}
