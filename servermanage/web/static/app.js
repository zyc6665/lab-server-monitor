/* 服务器轮询监测 - 静态轮询脚本
 * 每 30 秒拉取 /api/overview 与 /api/alerts?status=active，原位更新 DOM。
 * 无框架、无外部依赖；任何网络/解析错误都被吞掉，绝不抛出未捕获异常。
 * 会话失效（401）时优雅跳转到 /login。 */
(function () {
  'use strict';

  var REFRESH_MS = 30000;
  // 告警页当前状态筛选：active / acknowledged / resolved / all。
  var alertStatus = 'active';
  var ALERT_STATUS_FILTERS = ['active', 'acknowledged', 'resolved', 'all'];
  var lastHosts = [];
  var lastAlerts = [];
  var alertSeverity = '';
  var alertKeyword = '';
  var alertHost = '';
  var alertCategory = '';
  var alertTimeRange = '';
  var alertSortOrder = 'desc';
  var alertPage = 1;
  var alertPageSize = 25;
  var selectedAlertIds = {};
  var hostsLoaded = false;
  var hostSortKey = '';
  var hostSortDir = 1;
  var silenceTarget = null;
  var resourceRankMetric = 'cpu';

  function redirectToLogin() {
    if (window.location.pathname !== '/login') {
      window.location.assign('/login');
    }
  }

  // 读取 base.html <meta name="csrf-token"> 中的会话 CSRF 令牌。
  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? (meta.getAttribute('content') || '') : '';
  }

  // 统一的 JSON 请求：401 -> 跳登录并返回 null；非 2xx / 非 JSON -> null。
  // 所有非 GET 请求自动携带 X-CSRF-Token（服务端 CSRF 校验依赖它）。
  function fetchJson(url, options) {
    var opts = options || {};
    var method = (opts.method || 'GET').toUpperCase();
    var headers = { 'Accept': 'application/json' };
    if (opts.headers) {
      for (var key in opts.headers) {
        if (Object.prototype.hasOwnProperty.call(opts.headers, key)) {
          headers[key] = opts.headers[key];
        }
      }
    }
    if (method !== 'GET' && method !== 'HEAD') {
      var token = csrfToken();
      if (token) { headers['X-CSRF-Token'] = token; }
    }
    var base = {
      credentials: 'same-origin',
      headers: headers
    };
    if (opts.method) { base.method = opts.method; }
    if (opts.body !== undefined) { base.body = opts.body; }

    return fetch(url, base).then(function (response) {
      if (response.status === 401) {
        redirectToLogin();
        return null;
      }
      if (!response.ok) {
        return null;
      }
      var contentType = response.headers.get('content-type') || '';
      if (contentType.indexOf('application/json') === -1) {
        return null;
      }
      return response.json();
    });
  }

  // 轻量 toast：所有页面共用，不依赖任何第三方组件。
  function showToast(message, kind) {
    var container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + (kind || 'info');
    toast.textContent = String(message || '');
    container.appendChild(toast);
    window.setTimeout(function () {
      toast.classList.add('toast-out');
      window.setTimeout(function () {
        if (toast.parentNode) { toast.parentNode.removeChild(toast); }
      }, 220);
    }, 2600);
  }
  window.servermonitorToast = showToast;

  function formatPercent(value) {
    if (value === null || value === undefined || value === '') { return '—'; }
    var num = Number(value);
    if (isNaN(num)) { return '—'; }
    return num.toFixed(1) + '%';
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) { el.textContent = String(text); }
  }

  function textCell(text, extraClass) {
    var td = document.createElement('td');
    if (extraClass) { td.className = extraClass; }
    td.textContent = text === null || text === undefined || text === '' ? '—' : String(text);
    return td;
  }

  // 时间戳：表格里只显示「月-日 时:分」，完整值放进 title，避免 ISO 串撑宽行。
  function formatStamp(value) {
    if (!value) { return '—'; }
    var text = String(value);
    var date = new Date(text);
    if (isNaN(date.getTime())) { return text; }
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    var sameYear = date.getFullYear() === new Date().getFullYear();
    return (sameYear ? '' : date.getFullYear() + '-') +
      pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  // v0.1.81：温度小徽标（≥70℃ 琥珀、≥85℃ 红），无数据时不渲染。
  // 采集成功率低于 90% 才显示，正常时不打扰视线。
  function uptimeChip(uptime) {
    if (!uptime) { return null; }
    var expected = Number(uptime.expected) || 0;
    if (expected <= 0) { return null; }
    var samples = Number(uptime.samples) || 0;
    var ratio = Math.min(1, samples / expected);
    if (ratio >= 0.9) { return null; }
    var chip = document.createElement('span');
    chip.className = 'uptime-chip ' + (ratio < 0.6 ? 'is-critical' : 'is-warn');
    chip.textContent = '采集 ' + Math.round(ratio * 100) + '%';
    chip.title = '最近 24 小时应采 ' + expected + ' 次，实际 ' + samples + ' 次';
    return chip;
  }

  function temperatureChip(value) {
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
  function formatRelative(value) {
    if (!value) { return '—'; }
    var date = new Date(String(value));
    if (isNaN(date.getTime())) { return String(value); }
    var seconds = Math.round((Date.now() - date.getTime()) / 1000);
    if (seconds < 0) { seconds = 0; }
    if (seconds < 45) { return '刚刚'; }
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) { return minutes + ' 分钟前'; }
    var hours = Math.round(minutes / 60);
    if (hours < 24) { return hours + ' 小时前'; }
    var days = Math.round(hours / 24);
    if (days <= 7) { return days + ' 天前'; }
    return formatStamp(value);
  }

  // 迷你趋势线：纯 SVG，不引第三方图表库。数据点不足两个时返回 null。
  function sparkline(values, className) {
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
  function percentCell(value, spark) {
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
  var resourceRankLabels = {
    cpu: 'CPU',
    memory: '内存',
    disk: '磁盘',
    gpu: 'GPU 显存'
  };

  function resourceRankValue(host, metric) {
    if (!host) { return null; }
    var value = null;
    if (metric === 'cpu') { value = host.cpu_percent; }
    else if (metric === 'memory') { value = host.memory_percent; }
    else if (metric === 'disk') { value = host.disk_percent; }
    else if (metric === 'gpu') { value = host.gpu_memory_percent; }
    if (value === null || value === undefined || value === '') { return null; }
    var num = Number(value);
    return isNaN(num) ? null : num;
  }

  function renderResourceRanking() {
    var list = document.getElementById('resource-rank-list');
    if (!list) { return; }
    while (list.firstChild) { list.removeChild(list.firstChild); }
    var ranked = [];
    for (var i = 0; i < lastHosts.length; i += 1) {
      var value = resourceRankValue(lastHosts[i], resourceRankMetric);
      if (value !== null) { ranked.push({ host: lastHosts[i], value: value }); }
    }
    ranked.sort(function (a, b) { return b.value - a.value; });
    ranked = ranked.slice(0, 5);
    if (!ranked.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '暂无可排序的' + (resourceRankLabels[resourceRankMetric] || '') + '数据';
      list.appendChild(empty);
      return;
    }
    for (var j = 0; j < ranked.length; j += 1) {
      var item = ranked[j];
      var row = document.createElement('a');
      row.className = 'rank-row';
      row.href = '/host/' + encodeURIComponent(item.host.name || '');
      var name = document.createElement('span');
      name.className = 'rank-name';
      name.textContent = item.host.name || '未命名';
      var group = document.createElement('span');
      group.className = 'rank-group';
      group.textContent = item.host.group || '未分组';
      var meter = document.createElement('span');
      meter.className = 'rank-meter';
      var fill = document.createElement('span');
      fill.className = 'rank-meter-fill';
      if (item.value >= 90) { fill.className += ' is-hot'; }
      else if (item.value >= 75) { fill.className += ' is-warn'; }
      fill.style.width = Math.max(0, Math.min(100, item.value)) + '%';
      meter.appendChild(fill);
      var number = document.createElement('span');
      number.className = 'rank-value';
      number.textContent = formatPercent(item.value);
      row.appendChild(name);
      row.appendChild(group);
      row.appendChild(meter);
      row.appendChild(number);
      if (item.host.online === false) {
        var offline = document.createElement('span');
        offline.className = 'rank-offline';
        offline.textContent = '离线';
        row.appendChild(offline);
      }
      list.appendChild(row);
    }
  }

  function setResourceRankMetric(metric) {
    if (!resourceRankLabels[metric]) { return; }
    resourceRankMetric = metric;
    var tabs = document.querySelectorAll('#resource-rank [data-rank-metric]');
    for (var i = 0; i < tabs.length; i += 1) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-rank-metric') === metric);
      tabs[i].setAttribute('aria-pressed', tabs[i].getAttribute('data-rank-metric') === metric ? 'true' : 'false');
    }
    renderResourceRanking();
  }

  function bindResourceRankTabs() {
    var tabs = document.querySelectorAll('#resource-rank [data-rank-metric]');
    for (var i = 0; i < tabs.length; i += 1) {
      tabs[i].addEventListener('click', function (event) {
        var metric = event.currentTarget.getAttribute('data-rank-metric');
        setResourceRankMetric(metric);
      });
    }
  }

  var CAPACITY_LABELS = { memory: '内存', disk: '磁盘', gpu_memory: 'GPU 显存' };

  function renderCapacityForecast(items) {
    var list = document.getElementById('capacity-list');
    var summary = document.getElementById('capacity-summary');
    if (!list) { return; }
    while (list.firstChild) { list.removeChild(list.firstChild); }
    var risks = [];
    var insufficient = 0;
    (items || []).forEach(function (host) {
      (host.metrics || []).forEach(function (metric) {
        if (metric.status === 'insufficient_data') { insufficient += 1; }
        if (metric.status === 'critical' || metric.status === 'warning') {
          risks.push({ host: host, metric: metric });
        }
      });
    });
    risks.sort(function (a, b) {
      if (a.metric.status !== b.metric.status) { return a.metric.status === 'critical' ? -1 : 1; }
      return (a.metric.days_to_threshold == null ? 9999 : a.metric.days_to_threshold) - (b.metric.days_to_threshold == null ? 9999 : b.metric.days_to_threshold);
    });
    if (summary) {
      if (risks.length) {
        summary.textContent = '未来 30 天内有 ' + risks.length + ' 项容量风险';
      } else if (insufficient) {
        summary.textContent = '容量数据不足（需至少 5 天历史）';
      } else {
        summary.textContent = '未来 30 天容量平稳';
      }
    }
    if (!risks.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = insufficient ? '历史数据不足，暂时无法预测' : '暂无容量风险';
      list.appendChild(empty);
      return;
    }
    risks.slice(0, 8).forEach(function (item) {
      var metric = item.metric;
      var row = document.createElement('a');
      row.className = 'capacity-row capacity-risk-' + metric.status;
      row.href = '/host/' + encodeURIComponent(item.host.host_name || '');
      var name = document.createElement('span');
      name.className = 'capacity-host';
      name.textContent = item.host.host_name || '未命名';
      var label = document.createElement('span');
      label.className = 'capacity-metric';
      label.textContent = CAPACITY_LABELS[metric.key] || metric.key;
      var value = document.createElement('span');
      value.className = 'capacity-value';
      value.textContent = '当前 ' + formatPercent(metric.current);
      var trend = document.createElement('span');
      trend.className = 'capacity-trend';
      if (metric.days_to_threshold === 0) {
        trend.textContent = '已达阈值 ' + formatPercent(metric.threshold);
      } else if (metric.days_to_threshold == null) {
        trend.textContent = '趋势平缓';
      } else {
        trend.textContent = '约 ' + Math.max(0, Math.round(metric.days_to_threshold)) + ' 天后达到 ' + formatPercent(metric.threshold);
      }
      row.appendChild(name);
      row.appendChild(label);
      row.appendChild(value);
      row.appendChild(trend);
      list.appendChild(row);
    });
  }

  function booleanBadge(online) {
    var badge = document.createElement('span');
    badge.className = 'badge ' + (online ? 'badge-online' : 'badge-offline');
    badge.textContent = online ? '在线' : '离线';
    return badge;
  }

  function updateSummary(summary, hosts) {
    if (!summary) { return; }
    setText('summary-total', Array.isArray(hosts) ? hosts.length : 0);
    setText('summary-online', summary.online == null ? 0 : summary.online);
    setText('summary-offline', summary.offline == null ? 0 : summary.offline);
    setText('summary-alerts', summary.active_alerts == null ? 0 : summary.active_alerts);
  }

  var OVERVIEW_SVG_NS = 'http://www.w3.org/2000/svg';
  var OVERVIEW_COLORS = { cpu: '#2563eb', memory: '#7c3aed', disk: '#059669', gpu_util: '#d97706', load_1: '#0ea5e9' };

  function overviewSvgEl(name, attrs) {
    var el = document.createElementNS(OVERVIEW_SVG_NS, name);
    Object.keys(attrs || {}).forEach(function (key) { el.setAttribute(key, attrs[key]); });
    return el;
  }

  function overviewNumbers(values) {
    return (values || []).filter(function (v) {
      return v !== null && v !== undefined && !isNaN(Number(v));
    }).map(Number);
  }

  function overviewPath(values, min, max, width, height, padX, padY) {
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

  function drawOverviewTrend(svg, values, key, previous) {
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
    var scale = numbers.concat(history.length >= 2 ? history : []);
    var min = Math.min.apply(null, scale), max = Math.max.apply(null, scale);
    if (max - min < 1) { max = min + 1; }
    var points = overviewPath(values, min, max, width, height, padX, padY);
    [0, 0.5, 1].forEach(function (fraction) {
      var y = padY + (height - padY * 2) * fraction;
      svg.appendChild(overviewSvgEl('line', {
        x1: padX, x2: width - padX, y1: y, y2: y, stroke: '#e8edf5', 'stroke-width': '1'
      }));
    });
    var previousPoints = history.length >= 2
      ? overviewPath(previous, min, max, width, height, padX, padY)
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
  }

  var OVERVIEW_TREND_KEYS = ['cpu', 'memory', 'disk', 'gpu_util', 'load_1'];
  var OVERVIEW_TREND_LABELS = {
    cpu: 'CPU %',
    memory: '内存 %',
    disk: '磁盘 %',
    gpu_util: 'GPU 显存 %',
    load_1: '负载(1)',
  };
  // 最近一次拉到的趋势数据，导出 CSV 时直接复用，不再请求接口。
  var overviewHistory = { range: '24h', points: [], previous: [] };

  function loadOverviewHistory(rangeKey) {
    if (!document.getElementById('overview-trend')) { return; }
    fetchJson('/api/overview/history?compare=1&range=' + encodeURIComponent(rangeKey)).then(function (payload) {
      var points = (payload && payload.points) || [];
      var previous = (payload && payload.previous) || [];
      var empty = document.getElementById('overview-trend-empty');
      if (empty) { empty.hidden = points.length > 0; }
      var hint = document.getElementById('overview-trend-hint');
      if (hint) {
        hint.hidden = previous.length < 2;
        hint.textContent = previous.length >= 2 ? '虚线为上一周期' : '';
      }
      OVERVIEW_TREND_KEYS.forEach(function (key) {
        drawOverviewTrend(
          document.querySelector('[data-overview-trend="' + key + '"]'),
          points.map(function (point) { return point[key]; }),
          key,
          previous.map(function (point) { return point[key]; })
        );
      });
      overviewHistory = { range: rangeKey, points: points, previous: previous };
      var exportButton = document.getElementById('overview-trend-export');
      if (exportButton) { exportButton.hidden = points.length === 0; }
    }).catch(function () {});
  }

  function overviewPointLabel(point) {
    var raw = point && point.t;
    if (!raw) { return ''; }
    var text = String(raw);
    if (text.length >= 16) { return text.slice(5, 16).replace('T', ' '); }
    return text;
  }

  function csvEscape(value) {
    var text = value == null ? '' : String(value);
    return '"' + text.split('"').join('""') + '"';
  }

  function exportOverviewHistory() {
    var points = overviewHistory.points || [];
    if (!points.length) { return; }
    var previous = overviewHistory.previous || [];
    var header = ['时间'];
    OVERVIEW_TREND_KEYS.forEach(function (key) { header.push(OVERVIEW_TREND_LABELS[key]); });
    header.push('上一周期时间');
    OVERVIEW_TREND_KEYS.forEach(function (key) { header.push('上一周期 ' + OVERVIEW_TREND_LABELS[key]); });
    var lines = [header.map(csvEscape).join(',')];
    points.forEach(function (point, index) {
      var prior = previous[index] || {};
      var cells = [overviewPointLabel(point)];
      OVERVIEW_TREND_KEYS.forEach(function (key) {
        cells.push(typeof point[key] === 'number' ? point[key].toFixed(1) : '');
      });
      cells.push(previous.length ? overviewPointLabel(prior) : '');
      OVERVIEW_TREND_KEYS.forEach(function (key) {
        cells.push(typeof prior[key] === 'number' ? prior[key].toFixed(1) : '');
      });
      lines.push(cells.map(csvEscape).join(','));
    });
    var blob = new Blob(['\ufeff' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    var stamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = 'overview-trend-' + overviewHistory.range + '-' + stamp + '.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function bindOverviewExport() {
    var button = document.getElementById('overview-trend-export');
    if (!button) { return; }
    button.addEventListener('click', exportOverviewHistory);
  }

  // 主机表的列显示偏好：窄屏或只想看指标时，把地址/分组/负责人等收起来。
  var HOST_COLUMNS = ['address', 'group', 'owner', 'users', 'checks', 'health'];
  var HOST_COLUMNS_STORE = 'overview:columns';

  function readHostColumns() {
    try {
      var parsed = JSON.parse(localStorage.getItem(HOST_COLUMNS_STORE) || 'null');
      if (!parsed || typeof parsed !== 'object') { return {}; }
      return parsed;
    } catch (err) {
      return {};
    }
  }

  function applyHostColumns(hidden) {
    var table = document.getElementById('host-table');
    if (!table) { return; }
    HOST_COLUMNS.forEach(function (name) {
      table.classList.toggle('hide-' + name, !!hidden[name]);
    });
  }

  function bindHostColumns() {
    var menu = document.getElementById('host-columns');
    var table = document.getElementById('host-table');
    if (!menu || !table) { return; }
    var hidden = readHostColumns();
    var boxes = menu.querySelectorAll('[data-host-col]');
    Array.prototype.forEach.call(boxes, function (box) {
      var name = box.getAttribute('data-host-col');
      box.checked = !hidden[name];
      box.addEventListener('change', function () {
        hidden[name] = !box.checked;
        applyHostColumns(hidden);
        try { localStorage.setItem(HOST_COLUMNS_STORE, JSON.stringify(hidden)); } catch (err) {}
      });
    });
    applyHostColumns(hidden);
  }

  // 重点关注里点主机名，直接把下方主机列表筛到这一台，不再手动输关键字。
  function bindFocusHosts() {
    var list = document.getElementById('focus-alert-list');
    if (!list) { return; }
    list.addEventListener('click', function (event) {
      var target = event.target.closest('[data-focus-host]');
      if (!target) { return; }
      var name = target.getAttribute('data-focus-host') || '';
      var keyword = document.getElementById('filter-keyword');
      if (keyword) {
        keyword.value = name;
      }
      applyHostFilters();
      var section = document.getElementById('host-table-wrap') || document.getElementById('host-cards');
      if (section && section.scrollIntoView) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  function bindOverviewRanges() {
    var tabs = document.querySelectorAll('[data-overview-range]');
    if (!tabs.length) { return; }
    Array.prototype.forEach.call(tabs, function (tab) {
      tab.addEventListener('click', function () {
        Array.prototype.forEach.call(tabs, function (other) { other.classList.remove('active'); });
        tab.classList.add('active');
        loadOverviewHistory(tab.getAttribute('data-overview-range'));
      });
    });
    loadOverviewHistory('24h');
  }

  var ALERT_TREND_COLORS = { critical: '#dc2626', warning: '#f59e0b', info: '#3b82f6' };

  function drawAlertTrend(buckets) {
    var svg = document.querySelector('[data-alert-trend]');
    if (!svg) { return; }
    while (svg.firstChild) { svg.removeChild(svg.firstChild); }
    var width = 720, height = 150, padX = 28, padY = 16, padBottom = 28;
    var plotW = width - padX * 2, plotH = height - padY - padBottom;
    var maxTotal = 1;
    buckets.forEach(function (bucket) {
      maxTotal = Math.max(maxTotal, Number(bucket.total || 0));
    });
    [0, 0.5, 1].forEach(function (fraction) {
      var y = padY + plotH * (1 - fraction);
      svg.appendChild(overviewSvgEl('line', {
        x1: padX, x2: width - padX, y1: y, y2: y, stroke: '#e8edf5', 'stroke-width': '1'
      }));
      var label = overviewSvgEl('text', {
        x: 2, y: y + 4, 'font-size': '9', fill: '#94a3b8'
      });
      label.textContent = Math.round(maxTotal * fraction);
      svg.appendChild(label);
    });
    var slot = plotW / Math.max(1, buckets.length);
    var barW = Math.max(2, Math.min(20, slot * 0.62));
    buckets.forEach(function (bucket, index) {
      var x = padX + slot * index + (slot - barW) / 2;
      var bottom = padY + plotH;
      ['critical', 'warning', 'info'].forEach(function (level) {
        var count = Number(bucket[level] || 0);
        if (!count) { return; }
        var barH = plotH * (count / maxTotal);
        bottom -= barH;
        svg.appendChild(overviewSvgEl('rect', {
          x: x, y: bottom, width: barW, height: Math.max(1, barH),
          fill: ALERT_TREND_COLORS[level], rx: '1'
        }));
      });
      if (index === 0 || index === buckets.length - 1 || index % Math.ceil(buckets.length / 6) === 0) {
        var text = overviewSvgEl('text', {
          x: x + barW / 2, y: height - 8, 'font-size': '9',
          'text-anchor': 'middle', fill: '#94a3b8'
        });
        text.textContent = bucket.label;
        svg.appendChild(text);
      }
    });
  }

  function loadAlertHistory(rangeKey) {
    if (!document.getElementById('alert-trend')) { return; }
    fetchJson('/api/overview/alert-history?range=' + encodeURIComponent(rangeKey)).then(function (payload) {
      var buckets = (payload && payload.buckets) || [];
      var empty = document.getElementById('alert-trend-empty');
      var hasAlerts = buckets.some(function (bucket) { return Number(bucket.total || 0) > 0; });
      if (empty) { empty.hidden = hasAlerts; }
      drawAlertTrend(buckets);
    }).catch(function () {});
  }

  function bindAlertRanges() {
    var tabs = document.querySelectorAll('[data-alert-range]');
    if (!tabs.length) { return; }
    Array.prototype.forEach.call(tabs, function (tab) {
      tab.addEventListener('click', function () {
        Array.prototype.forEach.call(tabs, function (other) { other.classList.remove('active'); });
        tab.classList.add('active');
        loadAlertHistory(tab.getAttribute('data-alert-range'));
      });
    });
    loadAlertHistory('24h');
  }

  var ATTENTION_LIMITS = { cpu: 90, memory: 90, disk: 90, gpu: 90, temperature: 70 };

  // 关注项按"影响面"排序：检查失败/坏盘这类硬故障在前，占用类指标居中，
  // 活动告警只是结果，放在最后。数字越大越靠前。
  var ATTENTION_WEIGHTS = {
    checks: 90,
    diskHealth: 80,
    temperature: 70,
    disk: 65,
    memory: 60,
    cpu: 55,
    gpu: 50,
    alerts: 40,
  };

  function hostAttentionReasons(host) {
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

  function attentionChip(host, compact) {
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
  function attentionPopover() {
    var pop = document.getElementById('attention-pop');
    if (pop) { return pop; }
    pop = document.createElement('div');
    pop.id = 'attention-pop';
    pop.className = 'attention-pop';
    pop.hidden = true;
    document.body.appendChild(pop);
    return pop;
  }

  function closeAttentionPopover() {
    var pop = document.getElementById('attention-pop');
    if (pop) { pop.hidden = true; }
  }

  function openAttentionPopover(button) {
    var pop = attentionPopover();
    var hostName = button.getAttribute('data-attention-host') || '';
    var reasons = (button.title || '').split(' · ').filter(Boolean);
    pop.textContent = '';
    var head = document.createElement('div');
    head.className = 'attention-pop-head';
    head.textContent = hostName;
    pop.appendChild(head);
    var list = document.createElement('ul');
    reasons.forEach(function (reason) {
      var item = document.createElement('li');
      item.textContent = reason;
      list.appendChild(item);
    });
    pop.appendChild(list);
    pop.hidden = false;
    var rect = button.getBoundingClientRect();
    var width = pop.offsetWidth || 220;
    var left = Math.min(rect.left, window.innerWidth - width - 12);
    pop.style.left = Math.max(12, left) + 'px';
    pop.style.top = (rect.bottom + window.scrollY + 6) + 'px';
  }

  function bindAttentionChips() {
    document.addEventListener('click', function (event) {
      var chip = event.target.closest('[data-attention-host]');
      if (!chip) {
        closeAttentionPopover();
        return;
      }
      event.preventDefault();
      var pop = document.getElementById('attention-pop');
      if (pop && !pop.hidden) {
        closeAttentionPopover();
        return;
      }
      openAttentionPopover(chip);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { closeAttentionPopover(); }
    });
  }

  function gpuMemoryChip(memory) {
    if (!memory || !memory.total_mb) { return null; }
    var pct = (memory.used_mb / memory.total_mb) * 100;
    var chip = document.createElement('span');
    chip.className = 'gpu-chip' + (pct >= 90 ? ' is-critical' : (pct >= 70 ? ' is-hot' : ''));
    chip.textContent = '显存 ' + Math.round(pct) + '%';
    chip.title = '已用 ' + (memory.used_mb / 1024).toFixed(1) + ' GB / 共 '
      + (memory.total_mb / 1024).toFixed(1) + ' GB';
    return chip;
  }

  function buildHostRow(host) {
    var tr = document.createElement('tr');
    if (host.name) { tr.setAttribute('data-host', host.name); }
    tr.setAttribute('data-group', host.group || '未分组');
    tr.setAttribute('data-owner', host.owner || '');
    tr.setAttribute('data-online', host.online ? '1' : '0');
    tr.setAttribute('data-silenced', host.silenced ? '1' : '0');
    tr.setAttribute('data-alert-count', host.active_alert_count || 0);
    tr.setAttribute('data-attention', hostAttentionReasons(host).length);
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

    var spark = host.spark || {};
    tr.appendChild(percentCell(host.cpu_percent, spark.cpu));
    tr.appendChild(percentCell(host.memory_percent, spark.memory));
    tr.appendChild(percentCell(host.disk_percent));
    tr.appendChild(percentCell(host.gpu_memory_percent));
    tr.appendChild(textCell(host.logged_in_user_count == null ? '—' : host.logged_in_user_count, 'col-secondary col-users'));

    var checks = host.checks || {};
    var checkCell = document.createElement('td');
    checkCell.className = 'check-cell col-secondary col-checks';
    var checkBadge = document.createElement('span');
    if (checks.total) {
      var checkClass = 'check-summary';
      if (checks.failed) { checkClass += ' check-failed'; }
      else if (checks.unknown) { checkClass += ' check-unknown'; }
      checkBadge.className = checkClass;
      checkBadge.textContent = (checks.ok || 0) + '/' + checks.total;
    } else {
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

    var collectedCell = textCell(formatStamp(host.collected_at), 'mono');
    if (host.collected_at) { collectedCell.title = String(host.collected_at); }
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
  var HOST_VIEW_KEY = 'overview:host-view';
  var hostView = 'table';

  function readHostView() {
    try {
      var stored = window.localStorage.getItem(HOST_VIEW_KEY);
      if (stored === 'cards' || stored === 'table') { return stored; }
    } catch (error) { /* 隐私模式下忽略 */ }
    return 'table';
  }

  function applyHostView(view) {
    hostView = view === 'cards' ? 'cards' : 'table';
    var wrap = document.getElementById('host-table-wrap');
    var grid = document.getElementById('host-cards');
    if (wrap) { wrap.hidden = hostView !== 'table'; }
    if (grid) { grid.hidden = hostView !== 'cards'; }
    var tabs = document.querySelectorAll('[data-host-view]');
    for (var i = 0; i < tabs.length; i += 1) {
      var active = tabs[i].getAttribute('data-host-view') === hostView;
      tabs[i].classList.toggle('active', active);
      tabs[i].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    try { window.localStorage.setItem(HOST_VIEW_KEY, hostView); } catch (error) { /* 隐私模式下忽略 */ }
  }

  function bindHostView() {
    var toggle = document.querySelector('.view-toggle');
    if (!toggle) { return; }
    toggle.addEventListener('click', function (event) {
      var target = event.target;
      var button = target && target.closest ? target.closest('[data-host-view]') : null;
      if (!button) { return; }
      applyHostView(button.getAttribute('data-host-view'));
    });
    applyHostView(readHostView());
  }

  // ---- 界面密度（舒适 / 紧凑，纯本地偏好） ----
  var DENSITY_KEY = 'overview:density';

  function readDensity() {
    try {
      var stored = window.localStorage.getItem(DENSITY_KEY);
      if (stored === 'compact' || stored === 'cozy') { return stored; }
    } catch (error) { /* 隐私模式下忽略 */ }
    return 'cozy';
  }

  function applyDensity(value) {
    var density = value === 'compact' ? 'compact' : 'cozy';
    var root = document.documentElement;
    if (density === 'compact') {
      root.setAttribute('data-density', 'compact');
    } else {
      root.removeAttribute('data-density');
    }
    var buttons = document.querySelectorAll('[data-density]');
    for (var i = 0; i < buttons.length; i += 1) {
      var active = buttons[i].getAttribute('data-density') === density;
      buttons[i].classList.toggle('active', active);
      buttons[i].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    try { window.localStorage.setItem(DENSITY_KEY, density); } catch (error) { /* 隐私模式下忽略 */ }
  }

  function bindDensity() {
    var toggle = document.querySelector('.density-toggle');
    if (!toggle) { return; }
    toggle.addEventListener('click', function (event) {
      var target = event.target;
      var button = target && target.closest ? target.closest('[data-density]') : null;
      if (!button) { return; }
      applyDensity(button.getAttribute('data-density'));
    });
    applyDensity(readDensity());
  }

  function percentText(value) {
    if (value === null || value === undefined || value === '') { return '—'; }
    var num = Number(value);
    if (isNaN(num)) { return String(value); }
    return num.toFixed(1) + '%';
  }

  function metricBlock(label, value, spark) {
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

  function buildHostCard(host) {
    var card = document.createElement('article');
    card.className = 'host-card';
    card.setAttribute('data-host', host.name || '');
    card.setAttribute('data-group', host.group || '未分组');
    card.setAttribute('data-owner', host.owner || '');
    card.setAttribute('data-online', host.online ? '1' : '0');
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
    var checks = host.checks || {};
    var checkSpan = document.createElement('span');
    if (checks.total) {
      checkSpan.className = 'check-summary' + (checks.failed ? ' check-failed' : (checks.unknown ? ' check-unknown' : ''));
      checkSpan.textContent = '检查 ' + (checks.ok || 0) + '/' + checks.total;
    } else {
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
    time.textContent = formatStamp(host.collected_at);
    if (host.collected_at) { time.title = String(host.collected_at); }
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

  function renderHostCards(hosts) {
    var grid = document.getElementById('host-cards');
    if (!grid) { return; }
    while (grid.firstChild) { grid.removeChild(grid.firstChild); }
    for (var i = 0; i < hosts.length; i += 1) {
      grid.appendChild(buildHostCard(hosts[i] || {}));
    }
  }

  function hostRowMatches(tr, group, status, keyword) {
    if (group && tr.getAttribute('data-group') !== group) { return false; }
    if (status === 'online' && tr.getAttribute('data-online') !== '1') { return false; }
    if (status === 'offline' && tr.getAttribute('data-online') !== '0') { return false; }
    if (status === 'alert' && Number(tr.getAttribute('data-alert-count') || 0) <= 0) { return false; }
    if (status === 'attention' && Number(tr.getAttribute('data-attention') || 0) <= 0) { return false; }
    if (status === 'silenced' && tr.getAttribute('data-silenced') !== '1') { return false; }
    if (keyword) {
      var haystack = (tr.getAttribute('data-search') || tr.textContent || '').toLowerCase();
      if (haystack.indexOf(keyword) === -1) { return false; }
    }
    return true;
  }

  // 记住上次用的分组/状态筛选：刷新或切页回来不用重新选一遍。
  var HOST_FILTER_KEY = 'overview:filters';

  function readHostFilters() {
    try {
      var raw = localStorage.getItem(HOST_FILTER_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function saveHostFilters(group, status) {
    try {
      if (!group && !status) {
        localStorage.removeItem(HOST_FILTER_KEY);
        return;
      }
      localStorage.setItem(HOST_FILTER_KEY, JSON.stringify({ group: group || '', status: status || '' }));
    } catch (err) {}
  }

  function restoreHostFilters() {
    var saved = readHostFilters();
    var groupEl = document.getElementById('filter-group');
    var statusEl = document.getElementById('filter-status');
    var pairs = [[groupEl, saved.group], [statusEl, saved.status]];
    pairs.forEach(function (pair) {
      var el = pair[0];
      var value = pair[1];
      if (!el || !value) { return; }
      var found = false;
      for (var i = 0; i < el.options.length; i += 1) {
        if (el.options[i].value === value) { found = true; break; }
      }
      if (found) { el.value = value; }
    });
  }

  // 纯客户端筛选：只显隐已渲染的 host 行与卡片，不触发任何网络请求。
  function applyHostFilters() {
    var tbody = document.getElementById('host-table-body');
    var grid = document.getElementById('host-cards');
    var groupEl = document.getElementById('filter-group');
    var statusEl = document.getElementById('filter-status');
    var keywordEl = document.getElementById('filter-keyword');
    var group = groupEl ? groupEl.value : '';
    var status = statusEl ? statusEl.value : '';
    var keyword = keywordEl ? keywordEl.value.trim().toLowerCase() : '';
    var rows = tbody ? tbody.querySelectorAll('tr') : [];
    var cards = grid ? grid.querySelectorAll('[data-host]') : [];
    var i;
    var rowsVisible = 0;
    for (i = 0; i < rows.length; i += 1) {
      var showRow = hostRowMatches(rows[i], group, status, keyword);
      rows[i].hidden = !showRow;
      if (showRow) { rowsVisible += 1; }
    }
    var cardsVisible = 0;
    for (i = 0; i < cards.length; i += 1) {
      var showCard = hostRowMatches(cards[i], group, status, keyword);
      cards[i].hidden = !showCard;
      if (showCard) { cardsVisible += 1; }
    }
    var visible = hostView === 'cards' ? cardsVisible : rowsVisible;
    var totalCount = hostView === 'cards' ? cards.length : rows.length;
    var count = document.getElementById('filter-count');
    if (count) {
      count.textContent = (group || status || keyword)
        ? ('筛选出 ' + visible + ' / ' + totalCount + ' 台')
        : '';
    }
    var clear = document.getElementById('filter-clear');
    if (clear) { clear.hidden = !(group || status || keyword); }
    saveHostFilters(group, status);
    if (totalCount > 0) {
      var table = document.getElementById('host-table');
      var empty = document.getElementById('empty-state');
      if (table) { table.hidden = rowsVisible === 0; }
      if (empty) {
        empty.hidden = visible !== 0;
        empty.textContent = visible === 0 ? '没有符合筛选条件的主机' : '暂无数据';
      }
    }
  }

  function hostSortValue(host, key) {
    if (key === 'cpu') { return Number(host.cpu_percent); }
    if (key === 'memory') { return Number(host.memory_percent); }
    if (key === 'disk') { return Number(host.disk_percent); }
    if (key === 'gpu') { return Number(host.gpu_memory_percent); }
    if (key === 'users') { return Number(host.logged_in_user_count); }
    if (key === 'status') { return host.online ? 1 : 0; }
    if (key === 'health') {
      var status = (host.disk_health || {}).status || '';
      return status === 'critical' ? 3 : (status === 'warning' ? 2 : (status === 'ok' ? 1 : 0));
    }
    if (key === 'group') { return String(host.group || '未分组').toLowerCase(); }
    if (key === 'collected') { return String(host.collected_at || ''); }
    return String(host[key] || '').toLowerCase();
  }

  function sortedHosts() {
    var rows = lastHosts.slice();
    if (!hostSortKey) { return rows; }
    rows.sort(function (a, b) {
      var av = hostSortValue(a || {}, hostSortKey);
      var bv = hostSortValue(b || {}, hostSortKey);
      if (typeof av === 'number' && typeof bv === 'number') {
        if (isNaN(av) && isNaN(bv)) { return 0; }
        if (isNaN(av)) { return 1; }
        if (isNaN(bv)) { return -1; }
        return (av - bv) * hostSortDir;
      }
      if (av < bv) { return -hostSortDir; }
      if (av > bv) { return hostSortDir; }
      return 0;
    });
    return rows;
  }

  function updateSortIndicators() {
    var heads = document.querySelectorAll('#host-table th[data-sort-key]');
    for (var i = 0; i < heads.length; i += 1) {
      var key = heads[i].getAttribute('data-sort-key');
      heads[i].classList.toggle('sort-asc', key === hostSortKey && hostSortDir === 1);
      heads[i].classList.toggle('sort-desc', key === hostSortKey && hostSortDir === -1);
      if (key === hostSortKey) {
        heads[i].setAttribute('aria-sort', hostSortDir === 1 ? 'ascending' : 'descending');
      } else {
        heads[i].removeAttribute('aria-sort');
      }
    }
  }

  function renderHosts() {
    if (!hostsLoaded) { return; }
    var tbody = document.getElementById('host-table-body');
    var table = document.getElementById('host-table');
    var empty = document.getElementById('empty-state');
    if (!tbody || !table) { return; }
    var rows = sortedHosts();
    while (tbody.firstChild) { tbody.removeChild(tbody.firstChild); }
    for (var i = 0; i < rows.length; i += 1) {
      tbody.appendChild(buildHostRow(rows[i] || {}));
    }
    var hasData = rows.length > 0;
    table.hidden = !hasData;
    if (empty) {
      empty.hidden = hasData;
      if (hasData) { empty.textContent = ''; }
    }
    var hostSkeleton = document.getElementById('host-skeleton');
    if (hostSkeleton) { hostSkeleton.hidden = true; }
    var onboard = document.getElementById('onboard-card');
    if (onboard) { onboard.hidden = hasData; }
    setText('host-count', '共 ' + rows.length + ' 台');
    updateSortIndicators();
    renderHostCards(rows);
    applyHostView(hostView);
    applyHostFilters();
  }

  function updateHosts(hosts) {
    if (!Array.isArray(hosts)) { return; }
    lastHosts = hosts.slice();
    hostsLoaded = true;
    renderHosts();
    renderResourceRanking();
  }

  // 概览/主机列表的快捷采集：提交后轮询单台状态，完成时刷新表格。
  function collectHost(name, button) {
    if (!name || !button || button.disabled) { return; }
    var original = button.textContent || '采集';
    button.disabled = true;
    button.textContent = '采集中…';
    fetchJson('/api/settings/hosts/' + encodeURIComponent(name) + '/collect', { method: 'POST' })
      .then(function (payload) {
        if (!payload || !payload.ok) {
          throw new Error('collect failed');
        }
        showToast('已提交采集：' + name, 'success');
        pollHostCollection(name, button, original);
      })
      .catch(function () {
        button.disabled = false;
        button.textContent = original;
        showToast('采集任务提交失败：' + name, 'error');
      });
  }

  function pollHostCollection(name, button, original) {
    var deadline = Date.now() + 60000;
    var url = '/api/settings/hosts/collection-status?names=' + encodeURIComponent(name);
    function restore() {
      button.disabled = false;
      button.textContent = original;
    }
    function tick() {
      fetchJson(url).then(function (payload) {
        var status = payload && payload.statuses && payload.statuses[name];
        if (status && status.state === 'done') {
          restore();
          showToast('采集完成：' + name, 'success');
          refreshOverview().catch(function () {});
          return;
        }
        if (status && status.state === 'error') {
          restore();
          showToast('采集失败：' + (status.error || '未知错误'), 'error');
          return;
        }
        if (Date.now() < deadline) {
          window.setTimeout(tick, 1500);
        } else {
          restore();
          showToast('采集仍在后台进行：' + name, 'info');
        }
      }).catch(function () {
        if (Date.now() < deadline) {
          window.setTimeout(tick, 2000);
        } else {
          restore();
        }
      });
    }
    tick();
  }

  function hostIsAbnormal(host) {
    if (!host || host.online === false) { return true; }
    if (Number(host.active_alert_count || 0) > 0) { return true; }
    var diskStatus = String((host.disk_health && host.disk_health.status) || '').toLowerCase();
    return diskStatus === 'warning' || diskStatus === 'critical';
  }

  function collectAllHosts(button) {
    var names = lastHosts.map(function (host) { return host && host.name; }).filter(Boolean);
    if (!names.length) {
      showToast('暂无可采集的主机', 'info');
      return;
    }
    collectHosts(names, button);
  }

  function collectAbnormalHosts(button) {
    var names = lastHosts
      .filter(hostIsAbnormal)
      .map(function (host) { return host && host.name; })
      .filter(Boolean);
    if (!names.length) {
      showToast('没有异常主机需要采集', 'info');
      return;
    }
    collectHosts(names, button);
  }

  function collectHosts(names, button) {
    if (!names || !names.length || !button || button.disabled) { return; }
    var original = button.textContent || '采集';
    button.disabled = true;
    button.textContent = '采集中…';
    fetchJson('/api/settings/hosts/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: names })
    }).then(function (payload) {
      if (!payload || !payload.ok) {
        throw new Error('collect failed');
      }
      if (!payload.count) {
        button.disabled = false;
        button.textContent = original;
        showToast('没有匹配的主机', 'info');
        return;
      }
      showToast('已提交采集：' + payload.count + ' 台', 'success');
      pollHostsCollection(names, button, original);
    }).catch(function () {
      button.disabled = false;
      button.textContent = original;
      showToast('批量采集提交失败', 'error');
    });
  }

  function exportHostsCsv() {
    var table = document.getElementById('host-table');
    var tbody = document.getElementById('host-table-body');
    if (!table || !tbody) { return; }
    var headerCells = table.querySelectorAll('thead th');
    var headers = [];
    for (var h = 0; h < headerCells.length - 1; h += 1) {
      headers.push(headerCells[h].textContent.trim());
    }
    var lines = [headers.map(function (value) {
      return '"' + String(value).replace(/"/g, '""') + '"';
    }).join(',')];
    var rows = tbody.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].hidden) { continue; }
      var cells = rows[i].querySelectorAll('td');
      var values = [];
      for (var c = 0; c < cells.length - 1; c += 1) {
        values.push((cells[c].textContent || '').replace(/\s+/g, ' ').trim());
      }
      lines.push(values.map(function (value) {
        return '"' + String(value).replace(/"/g, '""') + '"';
      }).join(','));
    }
    if (lines.length <= 1) {
      showToast('没有可导出的主机', 'error');
      return;
    }
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'hosts-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('已导出 ' + (lines.length - 1) + ' 台主机', 'success');
  }

  function pollHostsCollection(names, button, original) {
    var deadline = Date.now() + 90000;
    var url = '/api/settings/hosts/collection-status?names=' + encodeURIComponent(names.join(','));
    function restore() {
      button.disabled = false;
      button.textContent = original;
    }
    function tick() {
      fetchJson(url).then(function (payload) {
        var statuses = (payload && payload.statuses) || {};
        var pending = names.filter(function (name) {
          var state = statuses[name] && statuses[name].state;
          return state !== 'done' && state !== 'error';
        });
        if (!pending.length) {
          var failed = names.filter(function (name) {
            return statuses[name] && statuses[name].state === 'error';
          });
          restore();
          if (failed.length) {
            showToast('采集完成，失败 ' + failed.length + ' 台', 'error');
          } else {
            showToast('采集完成：' + names.length + ' 台', 'success');
          }
          refreshOverview().catch(function () {});
          return;
        }
        if (Date.now() < deadline) {
          window.setTimeout(tick, 1500);
        } else {
          restore();
          showToast('采集仍在后台进行：' + pending.length + ' 台', 'info');
        }
      }).catch(function () {
        if (Date.now() < deadline) {
          window.setTimeout(tick, 2000);
        } else {
          restore();
        }
      });
    }
    tick();
  }

  // 记住主机表的排序方式：刷新后仍按上次点过的列排。
  var HOST_SORT_STORE = 'overview:sort';

  function readHostSort() {
    try {
      var parsed = JSON.parse(localStorage.getItem(HOST_SORT_STORE) || 'null');
      if (!parsed || typeof parsed.key !== 'string' || !parsed.key) { return null; }
      return { key: parsed.key, dir: parsed.dir === -1 ? -1 : 1 };
    } catch (err) {
      return null;
    }
  }

  function saveHostSort() {
    try {
      if (!hostSortKey) {
        localStorage.removeItem(HOST_SORT_STORE);
        return;
      }
      localStorage.setItem(HOST_SORT_STORE, JSON.stringify({ key: hostSortKey, dir: hostSortDir }));
    } catch (err) {}
  }

  function restoreHostSort() {
    var saved = readHostSort();
    if (!saved) { return; }
    var known = document.querySelector('#host-table th[data-sort-key="' + saved.key + '"]');
    if (!known) { return; }
    hostSortKey = saved.key;
    hostSortDir = saved.dir;
  }

  function setHostSort(key) {
    if (!key) { return; }
    if (hostSortKey === key) {
      hostSortDir = hostSortDir === 1 ? -1 : 1;
    } else {
      hostSortKey = key;
      hostSortDir = 1;
    }
    saveHostSort();
    renderHosts();
  }

  // 告警表的列显示偏好：只影响阅读，不改数据。
  var ALERT_COLUMNS = ['category', 'host', 'message'];
  var ALERT_COLUMNS_STORE = 'alerts:columns';

  function readAlertColumns() {
    try {
      var parsed = JSON.parse(localStorage.getItem(ALERT_COLUMNS_STORE) || 'null');
      if (!parsed || typeof parsed !== 'object') { return {}; }
      return parsed;
    } catch (err) {
      return {};
    }
  }

  function applyAlertColumns(hidden) {
    var table = document.getElementById('alerts-table');
    if (!table) { return; }
    for (var i = 0; i < ALERT_COLUMNS.length; i += 1) {
      var name = ALERT_COLUMNS[i];
      table.classList.toggle('hide-' + name, Boolean(hidden && hidden[name]));
    }
  }

  function bindAlertColumns() {
    var menu = document.getElementById('alert-columns');
    var table = document.getElementById('alerts-table');
    if (!menu || !table) { return; }
    var hidden = readAlertColumns();
    var boxes = menu.querySelectorAll('[data-alert-col]');
    for (var i = 0; i < boxes.length; i += 1) {
      var name = boxes[i].getAttribute('data-alert-col');
      boxes[i].checked = !hidden[name];
    }
    applyAlertColumns(hidden);
    menu.addEventListener('change', function (event) {
      var box = event.target.closest('[data-alert-col]');
      if (!box) { return; }
      var key = box.getAttribute('data-alert-col');
      var next = readAlertColumns();
      if (box.checked) { delete next[key]; } else { next[key] = true; }
      try { localStorage.setItem(ALERT_COLUMNS_STORE, JSON.stringify(next)); } catch (err) {}
      applyAlertColumns(next);
    });
  }

  function buildAlertRow(alert) {
    var tr = document.createElement('tr');
    if (alert.id != null) { tr.setAttribute('data-alert-row', alert.id); }
    tr.setAttribute('data-severity', alert.severity || 'info');
    tr.setAttribute('data-status', alert.status || 'active');

    var checkCell = document.createElement('td');
    checkCell.className = 'check-col';
    if (alert.status === 'active' && alert.id != null) {
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'alert-select';
      checkbox.setAttribute('data-alert-id', alert.id);
      checkbox.checked = Boolean(selectedAlertIds[alert.id]);
      checkCell.appendChild(checkbox);
    }
    tr.appendChild(checkCell);

    var severityCell = document.createElement('td');
    var severity = document.createElement('span');
    severity.className = 'severity severity-' + (alert.severity || 'info');
    severity.textContent = alert.severity || '—';
    severityCell.appendChild(severity);
    tr.appendChild(severityCell);

    var categoryCell = textCell(alert.category);
    categoryCell.classList.add('col-secondary', 'col-category');
    tr.appendChild(categoryCell);
    var hostCell = document.createElement('td');
    hostCell.className = 'mono col-host';
    if (alert.host_name) {
      var hostLink = document.createElement('a');
      hostLink.className = 'host-link';
      hostLink.setAttribute('href', '/host/' + encodeURIComponent(alert.host_name));
      hostLink.textContent = alert.host_name;
      hostCell.appendChild(hostLink);
    } else {
      hostCell.textContent = '—';
    }
    tr.appendChild(hostCell);

    var titleCell = document.createElement('td');
    titleCell.className = 'alert-title';
    titleCell.textContent = alert.title || '—';
    tr.appendChild(titleCell);

    var messageCell = document.createElement('td');
    messageCell.className = 'alert-message col-wide col-message';
    messageCell.textContent = alert.message || '—';
    if (alert.message) {
      messageCell.title = String(alert.message);
      if (String(alert.message).length > 48) { messageCell.classList.add('is-clamped'); }
    }
    tr.appendChild(messageCell);

    var timeCell = textCell(formatRelative(alert.created_at), 'mono alert-time');
    if (alert.created_at) { timeCell.title = formatStamp(alert.created_at); }
    tr.appendChild(timeCell);
    tr.appendChild(textCell(alert.status));

    var actionCell = document.createElement('td');
    actionCell.className = 'alert-actions';
    if (alert.status === 'active') {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'ack-btn';
      button.setAttribute('data-alert-id', alert.id);
      button.textContent = '确认';
      actionCell.appendChild(button);
      var silenceButton = document.createElement('button');
      silenceButton.type = 'button';
      silenceButton.className = 'silence-btn';
      silenceButton.setAttribute('data-alert-id', alert.id);
      silenceButton.setAttribute('data-host-name', alert.host_name || '');
      silenceButton.textContent = '静默';
      actionCell.appendChild(silenceButton);
    } else {
      var dash = document.createElement('span');
      dash.className = 'muted';
      dash.textContent = '—';
      actionCell.appendChild(dash);
    }
    tr.appendChild(actionCell);
    return tr;
  }

  var FOCUS_SEVERITY_WEIGHT = { critical: 3, warning: 2, info: 1 };

  function focusRank(alert) {
    var weight = FOCUS_SEVERITY_WEIGHT[(alert && alert.severity) || 'info'] || 0;
    var stamp = Date.parse((alert && alert.created_at) || '') || 0;
    return weight * 1e13 + stamp;
  }

  function pickFocusAlerts(alerts) {
    // 同一台主机只保留最严重（同级取最新）的一条，避免 5 条全是同一台机器。
    var groups = {};
    var order = [];
    alerts.forEach(function (alert) {
      var key = (alert && alert.host_name) || '';
      if (!groups[key]) {
        groups[key] = { alert: alert, total: 0, extra: 0 };
        order.push(key);
      }
      groups[key].total += 1;
      if (focusRank(alert) > focusRank(groups[key].alert)) { groups[key].alert = alert; }
    });
    var picks = order.map(function (key) { return groups[key]; });
    picks.forEach(function (pick) { pick.extra = pick.total - 1; });
    picks.sort(function (a, b) { return focusRank(b.alert) - focusRank(a.alert); });
    return picks.slice(0, 5);
  }

  function updateFocusAlerts(alerts) {
    var list = document.getElementById('focus-alert-list');
    if (!list) { return; }
    var visible = pickFocusAlerts(alerts || []);
    while (list.firstChild) { list.removeChild(list.firstChild); }
    for (var i = 0; i < visible.length; i += 1) {
      var pick = visible[i] || {};
      var alert = pick.alert || {};
      var item = document.createElement('li');
      item.className = 'focus-item';
      item.setAttribute('data-host', alert.host_name || '');
      var dot = document.createElement('span');
      dot.className = 'focus-dot focus-' + (alert.severity || 'info');
      item.appendChild(dot);
      var content = document.createElement('div');
      content.className = 'focus-content';
      var title = document.createElement('div');
      title.className = 'focus-title';
      title.textContent = alert.title || alert.category || '告警';
      if (pick.extra > 0) {
        var extra = document.createElement('span');
        extra.className = 'focus-extra';
        extra.textContent = '另有 ' + pick.extra + ' 条';
        extra.title = '这台主机还有 ' + pick.extra + ' 条活动告警';
        title.appendChild(extra);
      }
      content.appendChild(title);
      var meta = document.createElement('div');
      meta.className = 'focus-meta';
      if (alert.host_name) {
        var hostButton = document.createElement('button');
        hostButton.type = 'button';
        hostButton.className = 'focus-host';
        hostButton.setAttribute('data-focus-host', alert.host_name);
        hostButton.title = '在下方主机列表里只看这台';
        hostButton.textContent = alert.host_name;
        meta.appendChild(hostButton);
      }
      var rest = [alert.message, formatStamp(alert.created_at)]
        .filter(function (part) { return part && part !== '—'; }).join(' · ');
      if (rest) {
        var restSpan = document.createElement('span');
        restSpan.textContent = (alert.host_name ? ' · ' : '') + rest;
        meta.appendChild(restSpan);
      }
      content.appendChild(meta);
      item.appendChild(content);
      list.appendChild(item);
    }
    var empty = document.getElementById('focus-empty');
    if (empty) { empty.hidden = visible.length > 0; }
    var hint = document.getElementById('focus-hint');
    if (hint) {
      hint.textContent = visible.length
        ? '每台主机只列最严重一条 · 共 ' + (alerts || []).length + ' 条活动告警 · 点主机名可筛选下表'
        : '';
      hint.hidden = visible.length === 0;
    }
  }

  function bucketStartFor(value, range) {
    var when = typeof value === 'number' ? value : Date.parse(value || '');
    if (isNaN(when)) { return 0; }
    var spec = TIMELINE_RANGES[range] || TIMELINE_RANGES['24h'];
    var stepMs = spec.stepHours * 3600 * 1000;
    return Math.floor(when / stepMs) * stepMs;
  }

  var ALERT_CATEGORY_LABELS = {
    cpu: 'CPU',
    memory: '内存',
    disk: '磁盘',
    gpu: 'GPU',
    offline: '主机离线',
    host: '主机',
    system: '系统',
    user: '服务器账号',
    availability: '服务检查',
    batch: '批量采集',
    storage: '存储'
  };

  function alertCategoryLabel(category) {
    return ALERT_CATEGORY_LABELS[category] || category;
  }

  function populateAlertCategories(alerts) {
    var select = document.getElementById('alert-category-filter');
    if (!select) { return; }
    var seen = {};
    (alerts || []).forEach(function (alert) {
      var value = alert.category || '';
      if (value) { seen[value] = (seen[value] || 0) + 1; }
    });
    var names = Object.keys(seen).sort(function (a, b) {
      return alertCategoryLabel(a).localeCompare(alertCategoryLabel(b), 'zh-Hans-CN');
    });
    while (select.options.length > 1) { select.remove(1); }
    names.forEach(function (name) {
      var option = document.createElement('option');
      option.value = name;
      option.textContent = alertCategoryLabel(name) + '（' + seen[name] + '）';
      select.appendChild(option);
    });
    if (alertCategory && !seen[alertCategory]) {
      // 当前类别在这次数据里已经不存在（例如全部已恢复），回落到“全部类别”。
      alertCategory = '';
    }
    select.value = alertCategory;
  }

  function matchingAlerts(ignoreSeverity, ignoreBucket) {
    var keyword = (alertKeyword || '').trim().toLowerCase();
    return lastAlerts.filter(function (alert) {
      if (!ignoreBucket && alertBucket && bucketStartFor(alert.created_at, timelineRange) !== alertBucket) { return false; }
      if (!ignoreSeverity && alertSeverity && (alert.severity || '') !== alertSeverity) { return false; }
      if (alertHost && (alert.host_name || '') !== alertHost) { return false; }
      if (alertCategory && (alert.category || '') !== alertCategory) { return false; }
      if (!keyword) { return true; }
      return [alert.host_name, alert.title, alert.message, alert.category]
        .filter(function (part) { return part; })
        .join(' ').toLowerCase().indexOf(keyword) >= 0;
    });
  }

  function filteredAlerts(ignoreBucket) {
    var rows = matchingAlerts(false, ignoreBucket);
    rows.sort(function (left, right) {
      var a = String(left.created_at || '');
      var b = String(right.created_at || '');
      var order = a.localeCompare(b);
      return alertSortOrder === 'asc' ? order : -order;
    });
    return rows;
  }

  function renderAlertStatusCounts(counts) {
    var data = counts || {};
    setText('alert-status-count-active', data.active == null ? 0 : data.active);
    setText('alert-status-count-acknowledged', data.acknowledged == null ? 0 : data.acknowledged);
    setText('alert-status-count-resolved', data.resolved == null ? 0 : data.resolved);
    setText('alert-status-count-total', data.total == null ? 0 : data.total);
  }

  function renderAlertSummary() {
    var rows = matchingAlerts(true);
    var counts = { critical: 0, warning: 0, info: 0 };
    rows.forEach(function (alert) {
      var severity = alert.severity || 'info';
      if (counts[severity] !== undefined) { counts[severity] += 1; }
    });
    setText('alert-stat-total', rows.length);
    setText('alert-stat-critical', counts.critical);
    setText('alert-stat-warning', counts.warning);
    setText('alert-stat-info', counts.info);
    var buttons = document.querySelectorAll('#alert-summary .alert-stat');
    Array.prototype.forEach.call(buttons, function (button) {
      var value = button.getAttribute('data-alert-stat') || '';
      var active = value === alertSeverity;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function renderAlertPagination(total, pages, start, count) {
    var info = document.getElementById('alert-page-info');
    var prev = document.getElementById('alert-prev-page');
    var next = document.getElementById('alert-next-page');
    if (info) {
      info.textContent = '第 ' + alertPage + ' / ' + pages + ' 页' +
        (total ? '，显示 ' + (start + 1) + '-' + (start + count) + ' 条' : '');
    }
    if (prev) { prev.disabled = alertPage <= 1; }
    if (next) { next.disabled = alertPage >= pages; }
  }

  var ALERT_GROUP_KEY = 'alerts:group-by-host';
  var alertGrouped = false;
  var collapsedHosts = {};

  function readAlertGrouping() {
    try {
      alertGrouped = localStorage.getItem(ALERT_GROUP_KEY) === '1';
    } catch (err) {
      alertGrouped = false;
    }
    var toggle = document.getElementById('alert-group-toggle');
    if (toggle) {
      toggle.classList.toggle('active', alertGrouped);
      toggle.setAttribute('aria-pressed', alertGrouped ? 'true' : 'false');
    }
    var expand = document.getElementById('alert-group-expand');
    if (expand) { expand.hidden = !alertGrouped; }
  }

  function setAlertGrouping(value) {
    alertGrouped = Boolean(value);
    try {
      localStorage.setItem(ALERT_GROUP_KEY, alertGrouped ? '1' : '0');
    } catch (err) {}
    var toggle = document.getElementById('alert-group-toggle');
    if (toggle) {
      toggle.classList.toggle('active', alertGrouped);
      toggle.setAttribute('aria-pressed', alertGrouped ? 'true' : 'false');
    }
    var expand = document.getElementById('alert-group-expand');
    if (expand) { expand.hidden = !alertGrouped; }
    renderAlertRows();
  }

  // 分组视图下几十条告警分布在多台主机时，一次全开或全收比逐组点快得多。
  function groupHostsFor(alerts) {
    var seen = {};
    var hosts = [];
    (alerts || []).forEach(function (alert) {
      var host = (alert && alert.host_name) || '未命名主机';
      if (!seen[host]) {
        seen[host] = true;
        hosts.push(host);
      }
    });
    return hosts;
  }

  function updateGroupExpandLabel(alerts) {
    var button = document.getElementById('alert-group-expand');
    if (!button || !alertGrouped) { return; }
    var hosts = groupHostsFor(alerts);
    var collapsed = hosts.filter(function (host) { return collapsedHosts[host]; }).length;
    button.textContent = hosts.length && collapsed === hosts.length ? '全部展开' : '全部折叠';
  }

  function toggleAllGroups(alerts) {
    var hosts = groupHostsFor(alerts);
    var allCollapsed = hosts.length > 0 && hosts.every(function (host) { return collapsedHosts[host]; });
    hosts.forEach(function (host) { collapsedHosts[host] = !allCollapsed; });
    renderAlertRows();
  }

  var SEVERITY_WEIGHT = { critical: 3, warning: 2, info: 1 };

  function sortAlertsForGrouping(alerts) {
    var copy = alerts.slice();
    copy.sort(function (a, b) {
      var left = String((a && a.host_name) || '');
      var right = String((b && b.host_name) || '');
      if (left < right) { return -1; }
      if (left > right) { return 1; }
      var ta = String((a && a.created_at) || '');
      var tb = String((b && b.created_at) || '');
      if (ta === tb) { return 0; }
      return alertSortOrder === 'asc' ? (ta < tb ? -1 : 1) : (ta > tb ? -1 : 1);
    });
    return copy;
  }

  function groupAlertsByHost(alerts) {
    var order = [];
    var groups = {};
    for (var i = 0; i < alerts.length; i += 1) {
      var alert = alerts[i] || {};
      var key = alert.host_name || '未知主机';
      if (!groups[key]) {
        groups[key] = { host: key, alerts: [], severity: 'info', latest: '' };
        order.push(key);
      }
      var group = groups[key];
      group.alerts.push(alert);
      var weight = SEVERITY_WEIGHT[alert.severity] || 0;
      if (weight > (SEVERITY_WEIGHT[group.severity] || 0)) {
        group.severity = alert.severity;
      }
      if (!group.latest || String(alert.created_at || '') > String(group.latest)) {
        group.latest = alert.created_at || group.latest;
      }
    }
    return order.map(function (key) { return groups[key]; });
  }

  function buildAlertGroupRow(group) {
    var tr = document.createElement('tr');
    tr.className = 'alert-group';
    tr.setAttribute('data-alert-group', group.host);
    tr.setAttribute('data-severity', group.severity || 'info');
    var cell = document.createElement('td');
    cell.className = 'alert-group-cell';
    cell.colSpan = 9;

    var caret = document.createElement('span');
    caret.className = 'alert-group-caret';
    caret.textContent = collapsedHosts[group.host] ? '▸' : '▾';
    cell.appendChild(caret);

    var name = document.createElement('strong');
    name.textContent = group.host;
    cell.appendChild(name);

    var count = document.createElement('span');
    count.className = 'alert-group-count';
    count.textContent = group.alerts.length + ' 条';
    cell.appendChild(count);

    var badge = document.createElement('span');
    badge.className = 'severity severity-' + (group.severity || 'info');
    badge.textContent = group.severity || '—';
    cell.appendChild(badge);

    var time = document.createElement('span');
    time.className = 'alert-group-time mono';
    time.textContent = formatRelative(group.latest);
    if (group.latest) { time.title = formatStamp(group.latest); }
    cell.appendChild(time);

    tr.appendChild(cell);
    tr.tabIndex = 0;
    tr.setAttribute('aria-expanded', collapsedHosts[group.host] ? 'false' : 'true');
    return tr;
  }

  function renderAlertRows() {
    var body = document.getElementById('alerts-body');
    var table = document.getElementById('alerts-table');
    var empty = document.getElementById('alerts-empty');
    if (!body || !table) { return; }
    var matched = filteredAlerts();
    if (alertGrouped) { matched = sortAlertsForGrouping(matched); }
    var total = matched.length;
    var pages = Math.max(1, Math.ceil(total / alertPageSize));
    if (alertPage > pages) { alertPage = pages; }
    if (alertPage < 1) { alertPage = 1; }
    var start = (alertPage - 1) * alertPageSize;
    var visible = matched.slice(start, start + alertPageSize);
    while (body.firstChild) { body.removeChild(body.firstChild); }
    if (alertGrouped) {
      var groups = groupAlertsByHost(visible);
      for (var g = 0; g < groups.length; g += 1) {
        var group = groups[g];
        body.appendChild(buildAlertGroupRow(group));
        if (collapsedHosts[group.host]) { continue; }
        for (var j = 0; j < group.alerts.length; j += 1) {
          var subRow = buildAlertRow(group.alerts[j] || {});
          if (subRow && subRow.getAttribute('data-alert-row')) {
            subRow.classList.add('alert-row', 'alert-subrow');
            subRow.tabIndex = 0;
            subRow.setAttribute('aria-expanded', 'false');
          }
          body.appendChild(subRow);
        }
      }
    } else {
      for (var i = 0; i < visible.length; i += 1) {
        var row = buildAlertRow(visible[i] || {});
        if (row && row.getAttribute('data-alert-row')) {
          row.classList.add('alert-row');
          row.tabIndex = 0;
          row.setAttribute('aria-expanded', 'false');
        }
        body.appendChild(row);
      }
    }
    var skeleton = document.getElementById('alert-skeleton');
    if (skeleton) { skeleton.hidden = true; }
    var hasData = visible.length > 0;
    table.hidden = !hasData;
    if (empty) {
      empty.hidden = hasData;
      empty.textContent = lastAlerts.length
        ? '当前筛选没有匹配的告警，可以点“清除筛选”回到全部。'
        : '还没有告警记录。主机离线或指标超过阈值时会自动生成。';
    }
    var suffix = total !== lastAlerts.length ? '（匹配 ' + total + ' 条）' : '';
    setText('alert-count', '共 ' + lastAlerts.length + ' 条' + suffix);
    renderAlertSummary();
    updateGroupExpandLabel(filteredAlerts(true));
    renderAlertPagination(total, pages, start, visible.length);
    updateAlertSelectionSummary();
    renderAlertTimeline(filteredAlerts(true));
  }

  // -- 概览卡片折叠（记住上次状态） ---------------------------------------

  var COLLAPSIBLE_CARDS = ['focus-card', 'system-check', 'resource-rank', 'capacity-forecast', 'overview-trend', 'alert-trend'];
  var COLLAPSE_STORAGE_KEY = 'overview:collapsed:';

  function setCardCollapsed(section, collapsed) {
    if (!section) { return; }
    section.classList.toggle('is-collapsed', collapsed);
    var button = section.querySelector('.card-toggle');
    if (button) {
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      button.title = collapsed ? '展开卡片' : '收起卡片';
      button.textContent = collapsed ? '展开' : '收起';
    }
  }

  function setupCardCollapse() {
    for (var i = 0; i < COLLAPSIBLE_CARDS.length; i += 1) {
      var section = document.getElementById(COLLAPSIBLE_CARDS[i]);
      if (!section) { continue; }
      var head = section.querySelector('.section-head');
      if (!head || head.querySelector('.card-toggle')) { continue; }
      var stored = null;
      try { stored = window.localStorage.getItem(COLLAPSE_STORAGE_KEY + section.id); } catch (error) { stored = null; }
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'card-toggle';
      button.setAttribute('aria-expanded', stored === '1' ? 'false' : 'true');
      button.addEventListener('click', function (event) {
        event.preventDefault();
        var card = event.currentTarget.closest('section.card');
        if (!card) { return; }
        var collapsed = !card.classList.contains('is-collapsed');
        setCardCollapsed(card, collapsed);
        try { window.localStorage.setItem(COLLAPSE_STORAGE_KEY + card.id, collapsed ? '1' : '0'); } catch (error) { /* 隐私模式下忽略 */ }
      });
      setCardCollapsed(section, stored === '1');
      head.appendChild(button);
    }
  }

  // -- 告警行内展开详情 ---------------------------------------------------

  function alertById(id) {
    for (var i = 0; i < lastAlerts.length; i += 1) {
      if (String(lastAlerts[i].id) === String(id)) { return lastAlerts[i]; }
    }
    return null;
  }

  function buildAlertDetailRow(alert) {
    var tr = document.createElement('tr');
    tr.className = 'alert-detail-row';
    var cell = document.createElement('td');
    cell.colSpan = 9;
    cell.className = 'alert-detail-cell';
    var wrap = document.createElement('div');
    wrap.className = 'alert-detail';

    var message = document.createElement('p');
    message.className = 'alert-detail-message';
    message.textContent = alert.message || '没有更多详细信息';
    wrap.appendChild(message);

    var meta = document.createElement('dl');
    meta.className = 'alert-detail-meta';
    var rows = [
      ['主机', alert.host_name || '—'],
      ['类别', alert.category || '—'],
      ['首次出现', formatStamp(alert.created_at)],
      ['当前状态', alert.status || '—']
    ];
    for (var i = 0; i < rows.length; i += 1) {
      var dt = document.createElement('dt');
      dt.textContent = rows[i][0];
      var dd = document.createElement('dd');
      dd.textContent = rows[i][1];
      meta.appendChild(dt);
      meta.appendChild(dd);
    }
    wrap.appendChild(meta);

    if (alert.host_name) {
      var link = document.createElement('a');
      link.className = 'alert-detail-link';
      link.href = '/host/' + encodeURIComponent(alert.host_name);
      link.textContent = '查看主机详情 →';
      wrap.appendChild(link);
    }

    cell.appendChild(wrap);
    tr.appendChild(cell);
    return tr;
  }

  function toggleAlertDetail(row) {
    var next = row.nextElementSibling;
    if (next && next.classList && next.classList.contains('alert-detail-row')) {
      row.parentNode.removeChild(next);
      row.classList.remove('is-expanded');
      row.setAttribute('aria-expanded', 'false');
      return;
    }
    var alert = alertById(row.getAttribute('data-alert-row'));
    if (!alert) { return; }
    row.parentNode.insertBefore(buildAlertDetailRow(alert), row.nextSibling);
    row.classList.add('is-expanded');
    row.setAttribute('aria-expanded', 'true');
  }

  function setupAlertRowExpansion() {
    var body = document.getElementById('alerts-body');
    if (!body || body.getAttribute('data-expand-bound') === '1') { return; }
    body.setAttribute('data-expand-bound', '1');
    body.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) { return; }
      if (target.closest('button, a, input, label')) { return; }
      var row = target.closest('tr[data-alert-row]');
      if (!row) { return; }
      toggleAlertDetail(row);
    });
    body.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') { return; }
      var target = event.target;
      if (!target || !target.closest) { return; }
      var row = target.closest('tr[data-alert-row]');
      if (!row) { return; }
      event.preventDefault();
      toggleAlertDetail(row);
    });
  }

  // ---- v0.1.91 告警时间分布 ----
  var TIMELINE_RANGES = {
    '24h': { hours: 24, stepHours: 1, label: '24 小时' },
    '7d': { hours: 24 * 7, stepHours: 24, label: '7 天' },
    '30d': { hours: 24 * 30, stepHours: 24, label: '30 天' }
  };
  var timelineRange = '7d';
  var alertBucket = 0;

  function timelineBuckets(range) {
    var spec = TIMELINE_RANGES[range] || TIMELINE_RANGES['24h'];
    var stepMs = spec.stepHours * 3600 * 1000;
    var now = Date.now();
    var end = Math.floor(now / stepMs) * stepMs;
    var start = end - (spec.hours / spec.stepHours - 1) * stepMs;
    var buckets = [];
    for (var t = start; t <= end; t += stepMs) {
      buckets.push({ start: t, end: t + stepMs, critical: 0, warning: 0, info: 0, total: 0 });
    }
    return buckets;
  }

  function buildAlertTimeline(alerts, range) {
    var buckets = timelineBuckets(range);
    if (!buckets.length) { return buckets; }
    var first = buckets[0].start;
    var step = buckets[0].end - buckets[0].start;
    (alerts || []).forEach(function (alert) {
      var when = Date.parse(alert.created_at || '');
      if (isNaN(when) || when < first) { return; }
      var index = Math.floor((when - first) / step);
      if (index < 0 || index >= buckets.length) { return; }
      var bucket = buckets[index];
      var level = alert.severity === 'critical' || alert.severity === 'warning' ? alert.severity : 'info';
      bucket[level] += 1;
      bucket.total += 1;
    });
    return buckets;
  }

  function timelineLabel(bucket, range) {
    var date = new Date(bucket.start);
    var pad = function (value) { return value < 10 ? '0' + value : String(value); };
    var day = (date.getMonth() + 1) + '-' + pad(date.getDate());
    if ((TIMELINE_RANGES[range] || {}).stepHours === 1) {
      return day + ' ' + pad(date.getHours()) + ':00';
    }
    return day;
  }

  function renderAlertTimeline(alerts) {
    var container = document.getElementById('alert-timeline');
    if (!container) { return; }
    var buckets = buildAlertTimeline(alerts, timelineRange);
    var max = 1;
    buckets.forEach(function (bucket) { if (bucket.total > max) { max = bucket.total; } });
    container.textContent = '';
    var total = 0;
    buckets.forEach(function (bucket) {
      total += bucket.total;
      var bar = document.createElement('div');
      bar.className = 'timeline-bar';
      bar.setAttribute('data-timeline-bar', timelineLabel(bucket, timelineRange));
      bar.setAttribute('data-timeline-start', String(bucket.start));
      if (alertBucket === bucket.start) { bar.classList.add('is-selected'); }
      if (bucket.total) { bar.classList.add('is-clickable'); }
      var title = timelineLabel(bucket, timelineRange) + ' · 共 ' + bucket.total + ' 条';
      if (bucket.critical) { title += ' · 严重 ' + bucket.critical; }
      if (bucket.warning) { title += ' · 警告 ' + bucket.warning; }
      if (bucket.info) { title += ' · 提示 ' + bucket.info; }
      bar.title = title;
      if (!bucket.total) {
        bar.classList.add('is-empty');
      } else {
        var heightPct = Math.max(6, Math.round((bucket.total / max) * 100));
        bar.style.height = heightPct + '%';
        ['critical', 'warning', 'info'].forEach(function (level) {
          if (!bucket[level]) { return; }
          var seg = document.createElement('span');
          seg.className = 'timeline-seg timeline-seg-' + level;
          seg.style.flexGrow = String(bucket[level]);
          seg.title = level === 'critical' ? '严重' : (level === 'warning' ? '警告' : '提示');
          bar.appendChild(seg);
        });
      }
      container.appendChild(bar);
    });
    var hint = document.getElementById('alert-timeline-hint');
    if (hint) {
      var spec = TIMELINE_RANGES[timelineRange] || TIMELINE_RANGES['24h'];
      hint.textContent = '最近 ' + spec.label + ' · 共 ' + total + ' 条（按当前筛选条件统计）';
    }
  }

  function bindAlertTimeline() {
    var tabs = document.querySelectorAll('[data-timeline-range]');
    Array.prototype.forEach.call(tabs, function (tab) {
      tab.addEventListener('click', function () {
        timelineRange = tab.getAttribute('data-timeline-range') || '24h';
        Array.prototype.forEach.call(tabs, function (other) {
          var active = other === tab;
          other.classList.toggle('active', active);
          other.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        alertBucket = 0;
        updateAlertBucketChip();
        renderAlertRows();
        renderAlertTimeline(filteredAlerts(true));
      });
    });
    var container = document.getElementById('alert-timeline');
    if (container) {
      container.addEventListener('click', function (event) {
        var bar = event.target.closest ? event.target.closest('[data-timeline-start]') : null;
        if (!bar) { return; }
        var start = Number(bar.getAttribute('data-timeline-start'));
        if (!start || bar.classList.contains('is-empty')) { return; }
        alertBucket = alertBucket === start ? 0 : start;
        updateAlertBucketChip();
        renderAlertRows();
        renderAlertTimeline(filteredAlerts(true));
      });
    }
    var chip = document.getElementById('alert-bucket-chip');
    if (chip) {
      chip.addEventListener('click', function () {
        alertBucket = 0;
        updateAlertBucketChip();
        renderAlertRows();
        renderAlertTimeline(filteredAlerts(true));
      });
    }
    updateAlertBucketChip();
  }

  function updateAlertBucketChip() {
    var chip = document.getElementById('alert-bucket-chip');
    if (!chip) { return; }
    if (!alertBucket) {
      chip.hidden = true;
      chip.textContent = '';
      return;
    }
    var spec = TIMELINE_RANGES[timelineRange] || TIMELINE_RANGES['24h'];
    var label = timelineLabel({ start: alertBucket }, timelineRange);
    var scope = spec.stepHours === 1 ? '该小时' : '该天';
    chip.hidden = false;
    chip.textContent = label + ' ' + scope + ' ×';
  }

  function updateAlerts(alerts, counts) {
    if (!Array.isArray(alerts)) { return; }
    updateFocusAlerts(alerts);
    lastAlerts = alerts;
    populateAlertCategories(alerts);
    renderAlertStatusCounts(counts);
    var activeIds = {};
    alerts.forEach(function (alert) {
      if (alert && alert.status === 'active' && alert.id != null) { activeIds[alert.id] = true; }
    });
    Object.keys(selectedAlertIds).forEach(function (alertId) {
      if (!activeIds[alertId]) { delete selectedAlertIds[alertId]; }
    });
    renderAlertRows();
    renderAlertTimeline(filteredAlerts(true));
  }

  function updateAlertSelectionSummary() {
    var count = Object.keys(selectedAlertIds).length;
    var button = document.getElementById('alert-bulk-ack');
    if (button) {
      button.disabled = count === 0;
      button.textContent = count ? '批量确认 (' + count + ')' : '批量确认';
    }
    var selectAll = document.getElementById('alert-select-all');
    if (selectAll) {
      var boxes = document.querySelectorAll('.alert-select');
      selectAll.checked = boxes.length > 0 && count === boxes.length;
      selectAll.indeterminate = count > 0 && count < boxes.length;
    }
  }

  function setAlertSelected(checkbox) {
    var alertId = checkbox.getAttribute('data-alert-id');
    if (!alertId) { return; }
    if (checkbox.checked) { selectedAlertIds[alertId] = true; }
    else { delete selectedAlertIds[alertId]; }
    updateAlertSelectionSummary();
  }

  function setAllAlertsSelected(checked) {
    selectedAlertIds = {};
    var boxes = document.querySelectorAll('.alert-select');
    Array.prototype.forEach.call(boxes, function (box) {
      box.checked = checked;
      if (checked) {
        var alertId = box.getAttribute('data-alert-id');
        if (alertId) { selectedAlertIds[alertId] = true; }
      }
    });
    updateAlertSelectionSummary();
  }

  function bulkAckSelected() {
    var ids = Object.keys(selectedAlertIds);
    if (!ids.length) { return; }
    var button = document.getElementById('alert-bulk-ack');
    if (button) { button.disabled = true; }
    Promise.all(ids.map(function (alertId) {
      return fetchJson('/api/alerts/' + encodeURIComponent(alertId) + '/ack', { method: 'POST' });
    })).then(function () {
      selectedAlertIds = {};
      showToast('已确认 ' + ids.length + ' 条告警', 'success');
      return refreshAlerts();
    }).catch(function () {
      showToast('批量确认失败，请重试', 'error');
      if (button) { button.disabled = false; }
    });
  }

  function exportAlertsCsv() {
    var rows = filteredAlerts();
    if (!rows.length) { showToast('没有可导出的告警', 'error'); return; }
    var headers = ['级别', '类别', '主机', '标题', '内容', '时间', '状态'];
    var lines = [headers.join(',')];
    rows.forEach(function (alert) {
      var cells = [alert.severity, alert.category, alert.host_name, alert.title,
        alert.message, alert.created_at, alert.status].map(function (value) {
        var text = value === null || value === undefined ? '' : String(value);
        return '"' + text.replace(/"/g, '""') + '"';
      });
      lines.push(cells.join(','));
    });
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'alerts-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('已导出 ' + rows.length + ' 条告警', 'success');
  }

  function showLoadBanner(id, text) {
    var banner = document.getElementById(id);
    if (!banner) { return; }
    var label = banner.querySelector('.load-banner-text');
    if (label && text) { label.textContent = text; }
    banner.hidden = false;
  }

  function hideLoadBanner(id) {
    var banner = document.getElementById(id);
    if (banner) { banner.hidden = true; }
  }

  function hideSkeleton(id) {
    var skeleton = document.getElementById(id);
    if (skeleton) { skeleton.hidden = true; }
  }

  function refreshOverview() {
    return fetchJson('/api/overview').then(function (data) {
      if (!data) {
        hideSkeleton('host-skeleton');
        showLoadBanner('host-load-banner', '主机数据加载失败，点击重试或检查后台服务是否在运行。');
        return;
      }
      hideLoadBanner('host-load-banner');
      updateSummary(data.summary, data.hosts);
      updateHosts(data.hosts);
      renderCapacityForecast(data.capacity || []);
    }).catch(function () {
      hideSkeleton('host-skeleton');
      showLoadBanner('host-load-banner', '主机数据加载失败，点击重试或检查后台服务是否在运行。');
    });
  }

  function alertsUrl(status) {
    var params = [];
    if (!status || status === 'active') {
      params.push('status=active');
    } else if (status !== 'all') {
      params.push('status=' + encodeURIComponent(status));
    }
    if (alertTimeRange) {
      params.push('range=' + encodeURIComponent(alertTimeRange));
    }
    return '/api/alerts' + (params.length ? '?' + params.join('&') : '');
  }

  function syncAlertUrl() {
    var params = [];
    if (alertStatus !== 'active') { params.push('status=' + encodeURIComponent(alertStatus)); }
    if (alertKeyword.trim()) { params.push('q=' + encodeURIComponent(alertKeyword.trim())); }
    if (alertSeverity) { params.push('severity=' + encodeURIComponent(alertSeverity)); }
    if (alertHost) { params.push('host=' + encodeURIComponent(alertHost)); }
    if (alertCategory) { params.push('category=' + encodeURIComponent(alertCategory)); }
    if (alertTimeRange) { params.push('range=' + encodeURIComponent(alertTimeRange)); }
    if (alertSortOrder === 'asc') { params.push('sort=asc'); }
    var url = '/alerts' + (params.length ? '?' + params.join('&') : '');
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', url);
    }
  }

  function clearAlertFilters() {
    alertStatus = 'active';
    alertKeyword = '';
    alertSeverity = '';
    alertHost = '';
    alertCategory = '';
    alertTimeRange = '';
    alertBucket = 0;
    alertSortOrder = 'desc';
    alertPage = 1;
    selectedAlertIds = {};
    var search = document.getElementById('alert-search');
    if (search) { search.value = ''; }
    var severity = document.getElementById('alert-severity-filter');
    if (severity) { severity.value = ''; }
    var host = document.getElementById('alert-host-filter');
    if (host) { host.value = ''; }
    var category = document.getElementById('alert-category-filter');
    if (category) { category.value = ''; }
    var range = document.getElementById('alert-range-filter');
    if (range) { range.value = ''; }
    var sort = document.getElementById('alert-sort');
    if (sort) { sort.value = 'desc'; }
    updateAlertBucketChip();
    renderAlertStatusTabs();
    renderAlertRows();
    syncAlertUrl();
    refreshAlerts().catch(function () {});
  }

  function refreshAlerts() {
    return fetchJson(alertsUrl(alertStatus)).then(function (data) {
      if (!data) {
        hideSkeleton('alert-skeleton');
        showLoadBanner('alert-load-banner', '告警数据加载失败，点击重试或检查后台服务是否在运行。');
        return;
      }
      hideLoadBanner('alert-load-banner');
      updateAlerts(data.alerts, data.counts);
    }).catch(function () {
      hideSkeleton('alert-skeleton');
      showLoadBanner('alert-load-banner', '告警数据加载失败，点击重试或检查后台服务是否在运行。');
    });
  }

  function renderSystemChecks(payload) {
    var list = document.getElementById('system-check-list');
    var summary = document.getElementById('system-check-summary');
    if (!list || !summary) { return; }
    list.textContent = '';
    var diagnostics = payload && payload.diagnostics;
    if (!diagnostics || !Array.isArray(diagnostics.checks)) {
      summary.className = 'check-summary warning';
      summary.textContent = '检查不可用';
      var fallback = document.createElement('p');
      fallback.className = 'empty';
      fallback.textContent = '系统状态读取失败。';
      list.appendChild(fallback);
      return;
    }
    var overall = diagnostics.status === 'error' ? 'error'
      : (diagnostics.status === 'warning' ? 'warning' : 'ok');
    summary.className = 'check-summary ' + overall;
    summary.textContent = overall === 'ok' ? '全部正常'
      : (overall === 'error' ? '存在异常' : '有提醒');
    diagnostics.checks.forEach(function (check) {
      var row = document.createElement('div');
      row.className = 'check-row';
      var dot = document.createElement('span');
      var state = check.status === 'error' ? 'error'
        : (check.status === 'warning' ? 'warning' : 'ok');
      dot.className = 'check-dot ' + state;
      var label = document.createElement('span');
      label.className = 'check-label';
      label.textContent = check.label || check.key || '';
      var message = document.createElement('span');
      message.className = 'check-message';
      message.textContent = check.message || '';
      row.appendChild(dot);
      row.appendChild(label);
      row.appendChild(message);
      list.appendChild(row);
    });
  }

  function refreshSystemChecks() {
    var list = document.getElementById('system-check-list');
    if (!list) { return Promise.resolve(); }
    return fetchJson('/api/system/health').then(renderSystemChecks).catch(function () {
      renderSystemChecks(null);
    });
  }

  function renderAlertStatusTabs() {
    var filters = document.querySelectorAll('.alert-filter');
    for (var i = 0; i < filters.length; i += 1) {
      var isActive = filters[i].getAttribute('data-status') === alertStatus;
      if (isActive) {
        filters[i].classList.add('active');
      } else {
        filters[i].classList.remove('active');
      }
      filters[i].setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  }

  function setAlertFilter(status) {
    alertStatus = ALERT_STATUS_FILTERS.indexOf(status) >= 0 ? status : 'active';
    alertPage = 1;
    selectedAlertIds = {};
    renderAlertStatusTabs();
    syncAlertUrl();
    refreshAlerts().catch(function () {});
  }

  function refreshAll() {
    // 请求互相独立；各自吞掉错误，互不影响。
    refreshOverview().catch(function () {});
    refreshAlerts().catch(function () {});
    refreshSystemChecks().catch(function () {});
  }

  function hasDashboard() {
    return document.getElementById('summary-online') !== null ||
      document.getElementById('host-table-body') !== null ||
      document.getElementById('alerts-body') !== null;
  }

  function ackAlert(button) {
    var alertId = button.getAttribute('data-alert-id');
    if (!alertId) { return; }
    button.disabled = true;
    fetchJson('/api/alerts/' + encodeURIComponent(alertId) + '/ack', { method: 'POST' })
      .then(function (result) {
        if (result === null) { return; }
        showToast('告警已确认', 'success');
        return refreshAlerts();
      })
      .catch(function () {
        button.disabled = false;
        showToast('确认失败，请重试', 'error');
      });
  }

  function openSilenceDialog(button) {
    var dialog = document.getElementById('silence-dialog');
    if (!dialog) { return; }
    silenceTarget = {
      alertId: button.getAttribute('data-alert-id'),
      host: button.getAttribute('data-host-name') || ''
    };
    var hostEl = document.getElementById('silence-host');
    if (hostEl) { hostEl.textContent = silenceTarget.host || '全部主机'; }
    var reason = document.getElementById('silence-reason');
    if (reason) { reason.value = ''; }
    var duration = document.getElementById('silence-duration');
    if (duration) { duration.value = '3600'; }
    if (typeof dialog.showModal === 'function') { dialog.showModal(); }
    else { dialog.setAttribute('open', 'open'); }
  }

  function closeSilenceDialog() {
    var dialog = document.getElementById('silence-dialog');
    if (!dialog) { return; }
    if (typeof dialog.close === 'function') { dialog.close(); }
    else { dialog.removeAttribute('open'); }
    silenceTarget = null;
  }

  function submitSilence() {
    if (!silenceTarget) { return; }
    var durationEl = document.getElementById('silence-duration');
    var reasonEl = document.getElementById('silence-reason');
    var seconds = durationEl ? Number(durationEl.value) : 3600;
    if (!seconds || seconds < 60) { seconds = 3600; }
    var start = new Date();
    var end = new Date(start.getTime() + seconds * 1000);
    var payload = {
      scope_type: 'host',
      scope: silenceTarget.host,
      reason: reasonEl ? reasonEl.value : '',
      starts_at: start.toISOString(),
      ends_at: end.toISOString()
    };
    var confirmButton = document.getElementById('silence-confirm');
    if (confirmButton) { confirmButton.disabled = true; }
    fetchJson('/api/settings/silences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (result) {
      if (confirmButton) { confirmButton.disabled = false; }
      if (result === null) {
        showToast('静默失败，请检查设置权限', 'error');
        return;
      }
      showToast('已静默 ' + (silenceTarget ? silenceTarget.host : '') , 'success');
      closeSilenceDialog();
      return refreshAlerts();
    }).catch(function () {
      if (confirmButton) { confirmButton.disabled = false; }
      showToast('静默失败，请重试', 'error');
    });
  }

  var CONNECTION_WATCH_MS = 15000;
  var connectionTimer = null;
  var connectionLost = false;

  function setConnectionBanner(lost, recovered) {
    var banner = document.getElementById('conn-banner');
    if (!banner) { return; }
    var text = document.getElementById('conn-text');
    if (!lost) {
      if (connectionLost && recovered) {
        banner.className = 'conn-banner conn-banner-ok';
        if (text) { text.textContent = '已恢复与后台的连接'; }
        banner.hidden = false;
        setTimeout(function () {
          if (!connectionLost) { banner.hidden = true; }
        }, 4000);
      } else {
        banner.hidden = true;
      }
      connectionLost = false;
      return;
    }
    connectionLost = true;
    banner.className = 'conn-banner';
    if (text) { text.textContent = '与后台的连接已断开，正在自动重试…'; }
    banner.hidden = false;
  }

  function checkConnection() {
    return fetch('/api/runtime', { cache: 'no-store' })
      .then(function (response) {
        setConnectionBanner(!response.ok, response.ok);
        return response.ok;
      })
      .catch(function () {
        setConnectionBanner(true, false);
        return false;
      });
  }

  function startConnectionWatch() {
    if (connectionTimer) { return; }
    connectionTimer = setInterval(checkConnection, CONNECTION_WATCH_MS);
    window.addEventListener('online', checkConnection);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { checkConnection(); }
    });
  }

  function init() {
    startConnectionWatch();
    if (!hasDashboard()) { return; }

    setupCardCollapse();
    setupAlertRowExpansion();
    bindHostView();
    bindDensity();
    restoreHostSort();

    // 供全局命令面板调用当前页面的快捷操作。
    window.serverMonitorActions = {
      refresh: function () { refreshAll(); },
      collectAll: function () {
        var button = document.getElementById('collect-all-hosts');
        if (button) { collectAllHosts(button); }
      },
      collectAbnormal: function () {
        var button = document.getElementById('collect-abnormal-hosts');
        if (button) { collectAbnormalHosts(button); }
      }
    };

    // 事件委托：兼容服务端渲染的按钮与轮询后重建的按钮。
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (target && target.classList && target.classList.contains('ack-btn')) {
        ackAlert(target);
        return;
      }
      if (target && target.classList && target.classList.contains('silence-btn')) {
        openSilenceDialog(target);
        return;
      }
      if (target && target.classList && target.classList.contains('host-collect')) {
        collectHost(target.getAttribute('data-host-name'), target);
        return;
      }
      var sortHead = target && target.closest ? target.closest('th[data-sort-key]') : null;
      if (sortHead) {
        setHostSort(sortHead.getAttribute('data-sort-key'));
      }
    });

    var silenceCancel = document.getElementById('silence-cancel');
    var silenceConfirm = document.getElementById('silence-confirm');
    if (silenceCancel) { silenceCancel.addEventListener('click', closeSilenceDialog); }
    if (silenceConfirm) { silenceConfirm.addEventListener('click', submitSilence); }

    // 概览页筛选条：纯客户端过滤，事件绑定一次即可。
    var groupFilter = document.getElementById('filter-group');
    var statusFilter = document.getElementById('filter-status');
    var keywordFilter = document.getElementById('filter-keyword');
    if (groupFilter) { groupFilter.addEventListener('change', applyHostFilters); }
    if (statusFilter) { statusFilter.addEventListener('change', applyHostFilters); }
    if (keywordFilter) { keywordFilter.addEventListener('input', applyHostFilters); }
    var clearFilterButton = document.getElementById('filter-clear');
    if (clearFilterButton) {
      clearFilterButton.addEventListener('click', function () {
        if (groupFilter) { groupFilter.value = ''; }
        if (statusFilter) { statusFilter.value = ''; }
        if (keywordFilter) { keywordFilter.value = ''; }
        applyHostFilters();
      });
    }
    restoreHostFilters();
    applyHostFilters();

    var collectAllButton = document.getElementById('collect-all-hosts');
    var collectAbnormalButton = document.getElementById('collect-abnormal-hosts');
    var exportHostsButton = document.getElementById('export-hosts');
    if (collectAllButton) {
      collectAllButton.addEventListener('click', function () {
        collectAllHosts(collectAllButton);
      });
    }
    if (collectAbnormalButton) {
      collectAbnormalButton.addEventListener('click', function () {
        collectAbnormalHosts(collectAbnormalButton);
      });
    }
    if (exportHostsButton) {
      exportHostsButton.addEventListener('click', exportHostsCsv);
    }

    // 告警页状态筛选（活动 / 已确认 / 已解决 / 全部）：切换后按状态重新拉取。
    var alertFilterBar = document.getElementById('alert-status-filter');
    if (alertFilterBar) {
      var initialStatusTab = alertFilterBar.querySelector('.alert-filter.active');
      if (initialStatusTab) {
        alertStatus = initialStatusTab.getAttribute('data-status') || 'active';
      }
      alertFilterBar.addEventListener('click', function (event) {
        var target = event.target;
        if (target && target.classList && target.classList.contains('alert-filter')) {
          setAlertFilter(target.getAttribute('data-status'));
        }
      });
    }

    var alertSearch = document.getElementById('alert-search');
    var alertSeverityFilter = document.getElementById('alert-severity-filter');
    var alertHostFilter = document.getElementById('alert-host-filter');
    var alertCategoryFilter = document.getElementById('alert-category-filter');
    var alertRangeFilter = document.getElementById('alert-range-filter');
    var alertSort = document.getElementById('alert-sort');
    var alertPageSizeSelect = document.getElementById('alert-page-size');
    var alertPrevPage = document.getElementById('alert-prev-page');
    var alertNextPage = document.getElementById('alert-next-page');
    var alertSummary = document.getElementById('alert-summary');
    var alertExport = document.getElementById('alert-export');
    var alertClearFilters = document.getElementById('alert-clear-filters');
    // 支持从命令面板/外部链接带 q、severity 参数进入告警页时直接带上筛选条件。
    if (alertSearch && alertSearch.value) {
      alertKeyword = alertSearch.value;
    }
    if (alertSeverityFilter && alertSeverityFilter.value) {
      alertSeverity = alertSeverityFilter.value;
    } else if (!alertSeverity && window.URLSearchParams) {
      var severityParam = new URLSearchParams(window.location.search).get('severity');
      if (severityParam === 'critical' || severityParam === 'warning' || severityParam === 'info') {
        alertSeverity = severityParam;
      }
    }
    if (alertHostFilter && alertHostFilter.value) {
      alertHost = alertHostFilter.value;
    }
    if (alertCategoryFilter && alertCategoryFilter.value) {
      alertCategory = alertCategoryFilter.value;
    }
    if (alertRangeFilter && alertRangeFilter.value) {
      alertTimeRange = alertRangeFilter.value;
    }
    if (alertSort && alertSort.value) {
      alertSortOrder = alertSort.value;
    }
    if (alertPageSizeSelect && alertPageSizeSelect.value) {
      alertPageSize = Number(alertPageSizeSelect.value) || alertPageSize;
    }
    if (alertSearch) {
      alertSearch.addEventListener('input', function () {
        alertKeyword = alertSearch.value || '';
        alertPage = 1;
        renderAlertRows();
        syncAlertUrl();
      });
    }
    document.addEventListener('change', function (event) {
      var target = event.target;
      if (!target) { return; }
      if (target.classList && target.classList.contains('alert-select')) {
        setAlertSelected(target);
      } else if (target.id === 'alert-select-all') {
        setAllAlertsSelected(Boolean(target.checked));
      }
    });
    var bulkAck = document.getElementById('alert-bulk-ack');
    if (bulkAck) { bulkAck.addEventListener('click', bulkAckSelected); }
    var hostRetry = document.getElementById('host-load-retry');
    if (hostRetry) {
      hostRetry.addEventListener('click', function () { refreshOverview(); });
    }
    var alertRetry = document.getElementById('alert-load-retry');
    if (alertRetry) {
      alertRetry.addEventListener('click', function () { refreshAlerts(); });
    }
    var groupToggle = document.getElementById('alert-group-toggle');
    if (groupToggle) {
      groupToggle.addEventListener('click', function () { setAlertGrouping(!alertGrouped); });
    }
    var groupExpand = document.getElementById('alert-group-expand');
    if (groupExpand) {
      groupExpand.addEventListener('click', function () {
        toggleAllGroups(filteredAlerts(true));
      });
    }
    document.addEventListener('click', function (event) {
      var row = event.target && event.target.closest
        ? event.target.closest('[data-alert-group]')
        : null;
      if (!row) { return; }
      var hostKey = row.getAttribute('data-alert-group');
      collapsedHosts[hostKey] = !collapsedHosts[hostKey];
      renderAlertRows();
    });
    readAlertGrouping();
    if (alertSeverityFilter) {
      alertSeverityFilter.addEventListener('change', function () {
        alertSeverity = alertSeverityFilter.value || '';
        alertPage = 1;
        renderAlertRows();
        syncAlertUrl();
      });
    }
    if (alertHostFilter) {
      alertHostFilter.addEventListener('change', function () {
        alertHost = alertHostFilter.value || '';
        alertPage = 1;
        renderAlertRows();
        syncAlertUrl();
      });
    }
    if (alertCategoryFilter) {
      alertCategoryFilter.addEventListener('change', function () {
        alertCategory = alertCategoryFilter.value || '';
        alertPage = 1;
        renderAlertRows();
        syncAlertUrl();
      });
    }
    if (alertRangeFilter) {
      alertRangeFilter.addEventListener('change', function () {
        alertTimeRange = alertRangeFilter.value || '';
        alertPage = 1;
        syncAlertUrl();
        refreshAlerts().catch(function () {});
      });
    }
    if (alertSort) {
      alertSort.addEventListener('change', function () {
        alertSortOrder = alertSort.value || 'desc';
        alertPage = 1;
        renderAlertRows();
        syncAlertUrl();
      });
    }
    if (alertSummary) {
      alertSummary.addEventListener('click', function (event) {
        var target = event.target && event.target.closest ? event.target.closest('.alert-stat') : null;
        if (!target) { return; }
        alertSeverity = target.getAttribute('data-alert-stat') || '';
        if (alertSeverityFilter) { alertSeverityFilter.value = alertSeverity; }
        alertPage = 1;
        renderAlertRows();
        syncAlertUrl();
      });
    }
    if (alertPageSizeSelect) {
      alertPageSizeSelect.addEventListener('change', function () {
        alertPageSize = Number(alertPageSizeSelect.value) || 25;
        alertPage = 1;
        renderAlertRows();
      });
    }
    if (alertPrevPage) {
      alertPrevPage.addEventListener('click', function () {
        alertPage = Math.max(1, alertPage - 1);
        renderAlertRows();
      });
    }
    if (alertNextPage) {
      alertNextPage.addEventListener('click', function () {
        alertPage += 1;
        renderAlertRows();
      });
    }
    if (alertClearFilters) { alertClearFilters.addEventListener('click', clearAlertFilters); }
    if (alertExport) { alertExport.addEventListener('click', exportAlertsCsv); }

    bindOverviewRanges();
    bindOverviewExport();
    bindHostColumns();
    bindFocusHosts();
    bindAttentionChips();
    bindAlertRanges();
    bindAlertTimeline();
    bindAlertColumns();
    bindResourceRankTabs();
    refreshAll();
    window.setInterval(refreshAll, REFRESH_MS);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { refreshAll(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
