/* Host table rows and cards (M2: extracted from app.js).
 * Each builder takes the host payload and returns a detached DOM node. */
import { formatBytesShared, formatPercent, formatRelative, formatStamp } from '../lib/format.js';

// Shared thresholds/weights for the "关注项" chips. These used to live in
// app.js; after the M2 module split they must be defined here too (used by
// hostAttentionReasons/attentionChip), otherwise every table row build throws.
const ATTENTION_LIMITS = { cpu: 90, memory: 90, disk: 90, gpu: 90, temperature: 70 };
const ATTENTION_WEIGHTS = {
  checks: 90,
  diskHealth: 80,
  temperature: 70,
  disk: 65,
  memory: 60,
  cpu: 55,
  gpu: 50,
  alerts: 40,
};


export function setText(id, text) {
  var el = document.getElementById(id);
  if (el) { el.textContent = String(text); }
}


export function textCell(text, extraClass) {
  var td = document.createElement('td');
  if (extraClass) { td.className = extraClass; }
  td.textContent = text === null || text === undefined || text === '' ? '—' : String(text);
  return td;
}

// 时间戳：表格里只显示「月-日 时:分」，完整值放进 title，避免 ISO 串撑宽行。
// v0.1.81：温度小徽标（≥70℃ 琥珀、≥85℃ 红），无数据时不渲染。
// 采集成功率低于 90% 才显示，正常时不打扰视线。


export function uptimeChip(uptime) {
  if (!uptime) { return null; }
  var expected = Number(uptime.expected) || 0;
  if (expected <= 0) { return null; }
  var samples = Number(uptime.samples) || 0;
  var ratio = Math.min(1, samples / expected);
  if (ratio >= 0.9) { return null; }
  var chip = document.createElement('span');
  chip.className = 'uptime-chip ' + (ratio < 0.6 ? 'is-critical' : 'is-warn');
  chip.textContent = '采集率 ' + Math.round(ratio * 100) + '%';
  chip.title = '最近 24 小时应采 ' + expected + ' 次，实际 ' + samples + ' 次';
  return chip;
}


export function temperatureChip(value) {
  if (value === null || value === undefined || value === '') { return null; }
  var num = Number(value);
  if (isNaN(num)) { return null; }
  var chip = document.createElement('span');
  chip.className = 'temp-chip';
  if (num >= 85) { chip.classList.add('is-critical'); }
  else if (num >= 70) { chip.classList.add('is-hot'); }
  chip.textContent = Math.round(num) + '°';
  chip.title = '最高温度 ' + num.toFixed(1) + ' °C';
  return chip;
}

// v0.1.79：相对时间（3 分钟前 / 2 小时前），超过 7 天回退到绝对时间。
// 迷你趋势线：纯 SVG，不引第三方图表库。数据点不足两个时返回 null。


export function sparkline(values, className) {
  var list = (values || []).filter(function (item) {
    return item !== null && item !== undefined && !isNaN(Number(item));
  });
  if (list.length < 2) { return null; }
  var width = 34;
  var height = 14;
  var pad = 1.5;
  var min = Math.min.apply(null, list);
  var max = Math.max.apply(null, list);
  var span = max - min;
  if (span < 1) { span = 1; }
  var step = (width - pad * 2) / (list.length - 1);
  var points = list.map(function (item, index) {
    var x = pad + step * index;
    var ratio = (Number(item) - min) / span;
    var y = height - pad - ratio * (height - pad * 2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'spark ' + (className || ''));
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('aria-hidden', 'true');
  // 面积填充让趋势更易读，最后一根竖线标出当前点。
  var area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  area.setAttribute(
    'points',
    points.join(' ') + ' ' + (width - pad).toFixed(1) + ',' + height + ' ' + pad + ',' + height
  );
  area.setAttribute('class', 'spark-area');
  svg.appendChild(area);
  var line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', points.join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '1.4');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(line);
  var lastPoint = points[points.length - 1].split(',');
  var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', lastPoint[0]);
  dot.setAttribute('cy', lastPoint[1]);
  dot.setAttribute('r', '1.6');
  dot.setAttribute('fill', 'currentColor');
  svg.appendChild(dot);
  return svg;
}

// 百分比单元格：迷你进度条 + 数字，比纯文本更容易扫视。
// 有 24h 序列时用趋势线替代进度条，直观看出最近是涨还是跌。


export function percentCell(value, spark) {
  var td = document.createElement('td');
  td.className = 'pct-cell';
  if (value === null || value === undefined || value === '') {
    td.textContent = '—';
    return td;
  }
  var num = Number(value);
  if (isNaN(num)) {
    td.textContent = String(value);
    return td;
  }
  var trend = sparkline(spark, 'spark-pct');
  if (trend) {
    trend.setAttribute('title', '最近 ' + (spark || []).length + ' 次采集趋势');
    td.appendChild(trend);
  } else {
    var meter = document.createElement('span');
    meter.className = 'pct-meter';
    meter.setAttribute('aria-hidden', 'true');
    var fill = document.createElement('span');
    fill.className = 'pct-meter-fill';
    fill.style.width = Math.max(0, Math.min(100, num)) + '%';
    meter.appendChild(fill);
    td.appendChild(meter);
  }
  var label = document.createElement('span');
  label.className = 'pct-value';
  label.textContent = formatPercent(num);
  td.appendChild(label);
  return td;
}

// 资源排行：从当前主机快照取数值，按所选指标降序显示前 5 台。


export function booleanBadge(online) {
  var badge = document.createElement('span');
  badge.className = 'badge ' + (online ? 'badge-online' : 'badge-offline');
  badge.textContent = online ? '在线' : '离线';
  return badge;
}


export function hostAttentionReasons(host) {
  var entries = [];
  function add(weight, text) { entries.push({ weight: weight, text: text }); }
  var checks = host.checks || {};
  if (checks.failed) { add(ATTENTION_WEIGHTS.checks, checks.failed + ' 项服务检查异常'); }
  var disk = host.disk_health || {};
  if (disk.critical) { add(ATTENTION_WEIGHTS.diskHealth + 5, disk.critical + ' 块盘严重'); }
  else if (disk.warning) { add(ATTENTION_WEIGHTS.diskHealth, disk.warning + ' 块盘告警'); }
  var usage = [
    ['cpu_percent', 'CPU', 'cpu'],
    ['memory_percent', '内存', 'memory'],
    ['disk_percent', '磁盘', 'disk'],
    ['gpu_memory_percent', 'GPU 显存', 'gpu'],
  ];
  usage.forEach(function (item) {
    var value = host[item[0]];
    if (typeof value === 'number' && value >= ATTENTION_LIMITS[item[2]]) {
      add(ATTENTION_WEIGHTS[item[2]], item[1] + ' ' + Math.round(value) + '%');
    }
  });
  if (typeof host.temperature_c === 'number' && host.temperature_c >= ATTENTION_LIMITS.temperature) {
    add(ATTENTION_WEIGHTS.temperature, '温度 ' + Math.round(host.temperature_c) + ' °C');
  }
  if (host.active_alert_count > 0) { add(ATTENTION_WEIGHTS.alerts, host.active_alert_count + ' 条活动告警'); }
  entries.sort(function (a, b) { return b.weight - a.weight; });
  return entries.map(function (entry) { return entry.text; });
}


export function attentionChip(host, compact) {
  var reasons = hostAttentionReasons(host);
  if (!reasons.length) { return null; }
  var chip = document.createElement('button');
  chip.type = 'button';
  chip.className = compact ? 'attention-chip is-compact' : 'attention-chip';
  if (!host.online || reasons.length >= 3) { chip.className += ' is-critical'; }
  chip.textContent = compact ? String(reasons.length) : reasons.length + ' 项关注';
  chip.title = reasons.join(' · ');
  chip.setAttribute('data-attention-host', host.name || '');
  chip.setAttribute('aria-label', (host.name || '') + ' 的关注项：' + reasons.join('，'));
  return chip;
}

// 点"N 项关注"弹出原因清单，省得只能看 title 悬停。


export function gpuMemoryChip(memory) {
  if (!memory || !memory.total_mb) { return null; }
  var pct = (memory.used_mb / memory.total_mb) * 100;
  var chip = document.createElement('span');
  chip.className = 'gpu-chip' + (pct >= 90 ? ' is-critical' : (pct >= 70 ? ' is-hot' : ''));
  chip.textContent = '显存 ' + Math.round(pct) + '%';
  chip.title = '已用 ' + (memory.used_mb / 1024).toFixed(1) + ' GB / 共 '
    + (memory.total_mb / 1024).toFixed(1) + ' GB';
  return chip;
}


export function buildHostRow(host) {
  var tr = document.createElement('tr');
  if (host.name) {
    tr.setAttribute('data-host', host.name);
    tr.setAttribute('tabindex', '0');
    tr.setAttribute('title', '点击打开 ' + host.name + ' 的详情');
  }
  tr.setAttribute('data-group', host.group || '未分组');
  tr.setAttribute('data-owner', host.owner || '');
  tr.setAttribute('data-online', host.online ? '1' : '0');
  tr.setAttribute('data-silenced', host.silenced ? '1' : '0');
  tr.setAttribute('data-alert-count', host.active_alert_count || 0);
  tr.setAttribute('data-attention', hostAttentionReasons(host).length);
  tr.setAttribute('data-uptime', uptimeRatio(host.collection_uptime));
  tr.setAttribute(
    'data-search',
    [host.name, host.host, host.group || '未分组', host.owner, host.location]
      .join(' ').toLowerCase()
  );

  var nameCell = document.createElement('td');
  var link = document.createElement('a');
  link.href = '/host/' + encodeURIComponent(host.name || '');
  link.textContent = host.name || '—';
  nameCell.appendChild(link);
  var rowGpu = gpuMemoryChip(host.gpu_memory);
  if (rowGpu) { nameCell.appendChild(rowGpu); }
  var rowTemp = temperatureChip(host.temperature_c);
  if (rowTemp) { nameCell.appendChild(rowTemp); }
  var rowUptime = uptimeChip(host.collection_uptime);
  if (rowUptime) { nameCell.appendChild(rowUptime); }
  tr.appendChild(nameCell);

  tr.appendChild(textCell(host.host, 'mono col-secondary col-address'));
  tr.appendChild(textCell(host.group || '未分组', 'col-secondary col-group'));
  tr.appendChild(textCell(host.owner, 'col-secondary col-owner'));

  var statusCell = document.createElement('td');
  statusCell.appendChild(booleanBadge(!!host.online));
  if (host.silenced) {
    var silenceBadge = document.createElement('span');
    silenceBadge.className = 'badge badge-silenced';
    silenceBadge.title = '静默至 ' + (host.silenced_until || '—');
    silenceBadge.textContent = '静默';
    statusCell.appendChild(document.createTextNode(' '));
    statusCell.appendChild(silenceBadge);
  }
  var rowAttention = attentionChip(host, true);
  if (rowAttention) {
    statusCell.appendChild(document.createTextNode(' '));
    statusCell.appendChild(rowAttention);
  }
  tr.appendChild(statusCell);

  var alertCell = document.createElement('td');
  alertCell.className = 'col-alerts';
  var alertTotal = Number(host.active_alert_count || 0);
  if (alertTotal > 0) {
    var alertLink = document.createElement('a');
    alertLink.className = 'alert-count-badge';
    alertLink.href = '/alerts?host=' + encodeURIComponent(host.name || '') + '&status=active';
    alertLink.title = '查看这台的 ' + alertTotal + ' 条活动告警';
    alertLink.textContent = String(alertTotal);
    alertCell.appendChild(alertLink);
  } else {
    var alertNone = document.createElement('span');
    alertNone.className = 'alert-count-empty';
    alertNone.textContent = '—';
    alertCell.appendChild(alertNone);
  }
  tr.appendChild(alertCell);

  var spark = host.spark || {};
  tr.appendChild(percentCell(host.cpu_percent, spark.cpu));
  tr.appendChild(percentCell(host.memory_percent, spark.memory));
  tr.appendChild(percentCell(host.disk_percent));
  tr.appendChild(percentCell(host.gpu_memory_percent));
  tr.appendChild(textCell(host.logged_in_user_count == null ? '—' : host.logged_in_user_count, 'col-secondary col-users'));

  var checks = host.checks || {};
  var checkCell = document.createElement('td');
  checkCell.className = 'check-cell col-secondary col-checks';
  var checkBadge;
  if (checks.total) {
    var checkClass = 'check-summary';
    if (checks.failed) { checkClass += ' check-failed'; }
    else if (checks.unknown) { checkClass += ' check-unknown'; }
    checkBadge = document.createElement('a');
    checkBadge.className = checkClass;
    checkBadge.href = '/host/' + encodeURIComponent(host.name || '') + '#tab-checks';
    checkBadge.title = '查看这台的服务器检查明细';
    checkBadge.textContent = (checks.ok || 0) + '/' + checks.total;
  } else {
    checkBadge = document.createElement('span');
    checkBadge.className = 'check-summary check-empty';
    checkBadge.textContent = '—';
  }
  checkCell.appendChild(checkBadge);
  tr.appendChild(checkCell);

  var healthCell = document.createElement('td');
  healthCell.className = 'col-secondary col-health';
  var dh = host.disk_health || {};
  var health = document.createElement('span');
  health.className = 'health health-' + (dh.status || 'unknown');
  health.textContent = dh.status || 'unknown';
  healthCell.appendChild(health);
  var counts = document.createElement('span');
  counts.className = 'health-counts';
  counts.textContent = '健康 ' + (dh.healthy || 0) +
    ' · 告警 ' + (dh.warning || 0) +
    ' · 严重 ' + (dh.critical || 0);
  healthCell.appendChild(counts);
  tr.appendChild(healthCell);

  // 采集时间显示相对时长，悬停看绝对时间：一眼判断数据是否过期。
  var collectedCell = textCell(
    host.collected_at ? formatRelative(host.collected_at) : '—',
    'mono col-collected'
  );
  if (host.collected_at) {
    collectedCell.title = formatStamp(host.collected_at) + '（' + String(host.collected_at) + '）';
  }
  tr.appendChild(collectedCell);

  // 操作列：快捷采集 + 终端入口。用 DOM API + textContent 构建，避免把主机名当 HTML。
  var actionCell = document.createElement('td');
  actionCell.className = 'host-actions';
  var collectButton = document.createElement('button');
  collectButton.type = 'button';
  collectButton.className = 'btn-link host-collect';
  collectButton.setAttribute('data-host-name', host.name || '');
  collectButton.textContent = '采集';
  actionCell.appendChild(collectButton);
  var terminalLink = document.createElement('a');
  terminalLink.className = 'btn-link terminal-link';
  terminalLink.href = '/terminal?host=' + encodeURIComponent(host.name || '');
  terminalLink.textContent = '终端';
  actionCell.appendChild(terminalLink);
  tr.appendChild(actionCell);
  return tr;
}

// ---- 概览主机卡片视图（纯前端渲染，数据与表格同源） ----


export function percentText(value) {
  if (value === null || value === undefined || value === '') { return '—'; }
  var num = Number(value);
  if (isNaN(num)) { return String(value); }
  return num.toFixed(1) + '%';
}


export function metricBlock(label, value, spark) {
  var box = document.createElement('div');
  box.className = 'host-card-metric';
  var name = document.createElement('span');
  name.className = 'host-card-metric-label';
  name.textContent = label;
  box.appendChild(name);
  var val = document.createElement('span');
  val.className = 'host-card-metric-value';
  val.textContent = percentText(value);
  box.appendChild(val);
  var chart = Array.isArray(spark) && spark.length > 1 ? sparkline(spark, 'spark') : null;
  if (chart) { box.appendChild(chart); }
  return box;
}


export function buildHostCard(host) {
  var card = document.createElement('article');
  card.className = 'host-card';
  card.setAttribute('data-host', host.name || '');
  card.setAttribute('data-group', host.group || '未分组');
  card.setAttribute('data-owner', host.owner || '');
  card.setAttribute('data-online', host.online ? '1' : '0');
  card.setAttribute('data-uptime', uptimeRatio(host.collection_uptime));
  card.setAttribute('data-silenced', host.silenced ? '1' : '0');
  card.setAttribute('data-alert-count', host.active_alert_count || 0);
  card.setAttribute('data-attention', hostAttentionReasons(host).length);
  card.setAttribute(
    'data-search',
    [host.name, host.host, host.group || '未分组', host.owner, host.location]
      .join(' ').toLowerCase()
  );

  var head = document.createElement('div');
  head.className = 'host-card-head';
  var link = document.createElement('a');
  link.className = 'host-card-name';
  link.href = '/host/' + encodeURIComponent(host.name || '');
  link.textContent = host.name || '—';
  head.appendChild(link);
  head.appendChild(booleanBadge(!!host.online));
  var cardGpu = gpuMemoryChip(host.gpu_memory);
  if (cardGpu) { head.appendChild(cardGpu); }
  var cardTemp = temperatureChip(host.temperature_c);
  if (cardTemp) { head.appendChild(cardTemp); }
  var cardUptime = uptimeChip(host.collection_uptime);
  if (cardUptime) { head.appendChild(cardUptime); }
  var cardAlerts = Number(host.active_alert_count || 0);
  if (cardAlerts > 0) {
    var cardAlertLink = document.createElement('a');
    cardAlertLink.className = 'alert-count-badge';
    cardAlertLink.href = '/alerts?host=' + encodeURIComponent(host.name || '') + '&status=active';
    cardAlertLink.title = '查看这台的 ' + cardAlerts + ' 条活动告警';
    cardAlertLink.textContent = String(cardAlerts);
    head.appendChild(cardAlertLink);
  }
  var cardAttention = attentionChip(host);
  if (cardAttention) { head.appendChild(cardAttention); }
  if (host.silenced) {
    var silenceBadge = document.createElement('span');
    silenceBadge.className = 'badge badge-silenced';
    silenceBadge.title = '静默至 ' + (host.silenced_until || '—');
    silenceBadge.textContent = '静默';
    head.appendChild(silenceBadge);
  }
  card.appendChild(head);

  var meta = document.createElement('p');
  meta.className = 'host-card-meta';
  meta.textContent = [host.host || '—', host.group || '未分组', host.owner]
    .filter(function (item) { return !!item; }).join(' · ');
  card.appendChild(meta);

  var spark = host.spark || {};
  var metrics = document.createElement('div');
  metrics.className = 'host-card-metrics';
  metrics.appendChild(metricBlock('CPU', host.cpu_percent, spark.cpu));
  metrics.appendChild(metricBlock('内存', host.memory_percent, spark.memory));
  metrics.appendChild(metricBlock('磁盘', host.disk_percent));
  metrics.appendChild(metricBlock('GPU 显存', host.gpu_memory_percent));
  card.appendChild(metrics);

  var foot = document.createElement('div');
  foot.className = 'host-card-foot';
  if (host.load_1 !== null && host.load_1 !== undefined) {
    var loadChip = document.createElement('span');
    loadChip.className = 'host-card-load';
    loadChip.textContent = '负载 ' + Number(host.load_1).toFixed(2);
    if (host.cpu_cores) { loadChip.title = host.cpu_cores + ' 核，负载 ' + host.load_1; }
    foot.appendChild(loadChip);
  }
  if (host.uptime) {
    var uptimeChipNode = document.createElement('span');
    uptimeChipNode.className = 'host-card-uptime';
    uptimeChipNode.textContent = '运行 ' + String(host.uptime).split(',')[0];
    uptimeChipNode.title = '系统运行时长 ' + host.uptime;
    foot.appendChild(uptimeChipNode);
  }
  var checks = host.checks || {};
  var checkSpan;
  if (checks.total) {
    checkSpan = document.createElement('a');
    checkSpan.className = 'check-summary' + (checks.failed ? ' check-failed' : (checks.unknown ? ' check-unknown' : ''));
    checkSpan.href = '/host/' + encodeURIComponent(host.name || '') + '#tab-checks';
    checkSpan.title = '查看这台的服务器检查明细';
    checkSpan.textContent = '检查 ' + (checks.ok || 0) + '/' + checks.total;
  } else {
    checkSpan = document.createElement('span');
    checkSpan.className = 'check-summary check-empty';
    checkSpan.textContent = '检查 —';
  }
  foot.appendChild(checkSpan);

  var dh = host.disk_health || {};
  var health = document.createElement('span');
  health.className = 'health health-' + (dh.status || 'unknown');
  health.textContent = '磁盘' + (dh.status || 'unknown') + ' ' + (dh.healthy || 0) + '/' +
    ((dh.healthy || 0) + (dh.warning || 0) + (dh.critical || 0));
  foot.appendChild(health);

  if (host.container_count) {
    var containers = document.createElement('span');
    containers.className = 'host-card-containers';
    containers.textContent = '容器 ' + host.container_count;
    foot.appendChild(containers);
  }

  var time = document.createElement('span');
  time.className = 'host-card-time mono';
  time.textContent = host.collected_at ? formatRelative(host.collected_at) : '—';
  if (host.collected_at) {
    time.title = formatStamp(host.collected_at) + '（' + String(host.collected_at) + '）';
  }
  foot.appendChild(time);
  card.appendChild(foot);

  var actions = document.createElement('div');
  actions.className = 'host-card-actions';
  var collectButton = document.createElement('button');
  collectButton.type = 'button';
  collectButton.className = 'btn-link host-collect';
  collectButton.setAttribute('data-host-name', host.name || '');
  collectButton.textContent = '采集';
  actions.appendChild(collectButton);
  var terminalLink = document.createElement('a');
  terminalLink.className = 'btn-link terminal-link';
  terminalLink.href = '/terminal?host=' + encodeURIComponent(host.name || '');
  terminalLink.textContent = '终端';
  actions.appendChild(terminalLink);
  card.appendChild(actions);
  return card;
}


export function uptimeRatio(uptime) {
  if (!uptime || !uptime.expected) { return -1; }
  return Math.min(1, Math.max(0, Number(uptime.samples || 0) / Number(uptime.expected)));
}
