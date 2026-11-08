/* 服务器轮询监测 - 静态轮询脚本
 * 每 30 秒拉取 /api/overview 与 /api/alerts?status=active，原位更新 DOM。
 * 无框架、无外部依赖；任何网络/解析错误都被吞掉，绝不抛出未捕获异常。
 * 会话失效（401）时优雅跳转到 /login。 */
(function () {
  'use strict';

  var REFRESH_MS = 30000;
  // 告警页当前筛选：active（默认，仅活动告警）或 all（全部）。
  var alertStatus = 'active';
  var lastHosts = [];
  var lastAlerts = [];
  var alertSeverity = '';
  var alertKeyword = '';
  var alertHost = '';
  var alertTimeRange = '';
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

  // 百分比单元格：迷你进度条 + 数字，比纯文本更容易扫视。
  function percentCell(value) {
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
    var meter = document.createElement('span');
    meter.className = 'pct-meter';
    meter.setAttribute('aria-hidden', 'true');
    var fill = document.createElement('span');
    fill.className = 'pct-meter-fill';
    fill.style.width = Math.max(0, Math.min(100, num)) + '%';
    meter.appendChild(fill);
    var label = document.createElement('span');
    label.className = 'pct-value';
    label.textContent = formatPercent(num);
    td.appendChild(meter);
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
  var OVERVIEW_COLORS = { cpu: '#2563eb', memory: '#7c3aed', disk: '#059669', gpu_util: '#d97706' };

  function overviewSvgEl(name, attrs) {
    var el = document.createElementNS(OVERVIEW_SVG_NS, name);
    Object.keys(attrs || {}).forEach(function (key) { el.setAttribute(key, attrs[key]); });
    return el;
  }

  function drawOverviewTrend(svg, values, key) {
    if (!svg) { return; }
    while (svg.firstChild) { svg.removeChild(svg.firstChild); }
    var numbers = values.filter(function (v) {
      return v !== null && v !== undefined && !isNaN(Number(v));
    }).map(Number);
    var latest = document.querySelector('[data-overview-latest="' + key + '"]');
    if (latest) { latest.textContent = numbers.length ? formatPercent(numbers[numbers.length - 1]) : ''; }
    if (numbers.length < 2) { return; }
    var width = 300, height = 84, padX = 8, padY = 8;
    var min = Math.min.apply(null, numbers), max = Math.max.apply(null, numbers);
    if (max - min < 1) { max = min + 1; }
    var points = [];
    values.forEach(function (value, index) {
      if (value === null || value === undefined || isNaN(Number(value))) { return; }
      points.push([
        padX + (width - padX * 2) * (index / Math.max(1, values.length - 1)),
        height - padY - (height - padY * 2) * ((Number(value) - min) / (max - min))
      ]);
    });
    [0, 0.5, 1].forEach(function (fraction) {
      var y = padY + (height - padY * 2) * fraction;
      svg.appendChild(overviewSvgEl('line', {
        x1: padX, x2: width - padX, y1: y, y2: y, stroke: '#e8edf5', 'stroke-width': '1'
      }));
    });
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

  function loadOverviewHistory(rangeKey) {
    if (!document.getElementById('overview-trend')) { return; }
    fetchJson('/api/overview/history?range=' + encodeURIComponent(rangeKey)).then(function (payload) {
      var points = (payload && payload.points) || [];
      var empty = document.getElementById('overview-trend-empty');
      if (empty) { empty.hidden = points.length > 0; }
      ['cpu', 'memory', 'disk', 'gpu_util'].forEach(function (key) {
        drawOverviewTrend(
          document.querySelector('[data-overview-trend="' + key + '"]'),
          points.map(function (point) { return point[key]; }),
          key
        );
      });
    }).catch(function () {});
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

  function buildHostRow(host) {
    var tr = document.createElement('tr');
    if (host.name) { tr.setAttribute('data-host', host.name); }
    tr.setAttribute('data-group', host.group || '未分组');
    tr.setAttribute('data-owner', host.owner || '');
    tr.setAttribute('data-online', host.online ? '1' : '0');
    tr.setAttribute('data-silenced', host.silenced ? '1' : '0');
    tr.setAttribute('data-alert-count', host.active_alert_count || 0);
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
    tr.appendChild(nameCell);

    tr.appendChild(textCell(host.host, 'mono'));
    tr.appendChild(textCell(host.group || '未分组'));
    tr.appendChild(textCell(host.owner));

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
    tr.appendChild(statusCell);

    tr.appendChild(percentCell(host.cpu_percent));
    tr.appendChild(percentCell(host.memory_percent));
    tr.appendChild(percentCell(host.disk_percent));
    tr.appendChild(percentCell(host.gpu_memory_percent));
    tr.appendChild(textCell(host.logged_in_user_count == null ? '—' : host.logged_in_user_count));

    var healthCell = document.createElement('td');
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

    tr.appendChild(textCell(host.collected_at, 'mono'));

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

  function hostRowMatches(tr, group, status, keyword) {
    if (group && tr.getAttribute('data-group') !== group) { return false; }
    if (status === 'online' && tr.getAttribute('data-online') !== '1') { return false; }
    if (status === 'offline' && tr.getAttribute('data-online') !== '0') { return false; }
    if (status === 'alert' && Number(tr.getAttribute('data-alert-count') || 0) <= 0) { return false; }
    if (status === 'silenced' && tr.getAttribute('data-silenced') !== '1') { return false; }
    if (keyword) {
      var haystack = (tr.getAttribute('data-search') || tr.textContent || '').toLowerCase();
      if (haystack.indexOf(keyword) === -1) { return false; }
    }
    return true;
  }

  // 纯客户端筛选：只显隐已渲染的 host 行，不触发任何网络请求。
  function applyHostFilters() {
    var tbody = document.getElementById('host-table-body');
    if (!tbody) { return; }
    var groupEl = document.getElementById('filter-group');
    var statusEl = document.getElementById('filter-status');
    var keywordEl = document.getElementById('filter-keyword');
    var group = groupEl ? groupEl.value : '';
    var status = statusEl ? statusEl.value : '';
    var keyword = keywordEl ? keywordEl.value.trim().toLowerCase() : '';
    var rows = tbody.querySelectorAll('tr');
    var visible = 0;
    for (var i = 0; i < rows.length; i += 1) {
      var show = hostRowMatches(rows[i], group, status, keyword);
      rows[i].hidden = !show;
      if (show) { visible += 1; }
    }
    var count = document.getElementById('filter-count');
    if (count) {
      count.textContent = (group || status || keyword)
        ? ('筛选出 ' + visible + ' / ' + rows.length + ' 台')
        : '';
    }
    if (rows.length > 0) {
      var table = document.getElementById('host-table');
      var empty = document.getElementById('empty-state');
      if (table) { table.hidden = visible === 0; }
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
    if (empty) { empty.hidden = hasData; }
    setText('host-count', '共 ' + rows.length + ' 台');
    updateSortIndicators();
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

  function setHostSort(key) {
    if (!key) { return; }
    if (hostSortKey === key) {
      hostSortDir = hostSortDir === 1 ? -1 : 1;
    } else {
      hostSortKey = key;
      hostSortDir = 1;
    }
    renderHosts();
  }

  function buildAlertRow(alert) {
    var tr = document.createElement('tr');
    if (alert.id != null) { tr.setAttribute('data-alert-row', alert.id); }

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

    tr.appendChild(textCell(alert.category));
    tr.appendChild(textCell(alert.host_name));

    var titleCell = document.createElement('td');
    titleCell.className = 'alert-title';
    titleCell.textContent = alert.title || '—';
    tr.appendChild(titleCell);

    var messageCell = document.createElement('td');
    messageCell.className = 'alert-message';
    messageCell.textContent = alert.message || '—';
    tr.appendChild(messageCell);

    tr.appendChild(textCell(alert.created_at, 'mono'));
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

  function updateFocusAlerts(alerts) {
    var list = document.getElementById('focus-alert-list');
    if (!list) { return; }
    var visible = alerts.slice(0, 5);
    while (list.firstChild) { list.removeChild(list.firstChild); }
    for (var i = 0; i < visible.length; i += 1) {
      var alert = visible[i] || {};
      var item = document.createElement('li');
      item.className = 'focus-item';
      var dot = document.createElement('span');
      dot.className = 'focus-dot focus-' + (alert.severity || 'info');
      item.appendChild(dot);
      var content = document.createElement('div');
      content.className = 'focus-content';
      var title = document.createElement('div');
      title.className = 'focus-title';
      title.textContent = alert.title || alert.category || '告警';
      content.appendChild(title);
      var meta = document.createElement('div');
      meta.className = 'focus-meta';
      meta.textContent = [alert.host_name, alert.message, alert.created_at]
        .filter(function (part) { return part; }).join(' · ');
      content.appendChild(meta);
      item.appendChild(content);
      list.appendChild(item);
    }
    var empty = document.getElementById('focus-empty');
    if (empty) { empty.hidden = visible.length > 0; }
  }

  function filteredAlerts() {
    var keyword = (alertKeyword || '').trim().toLowerCase();
    return lastAlerts.filter(function (alert) {
      if (alertSeverity && (alert.severity || '') !== alertSeverity) { return false; }
      if (alertHost && (alert.host_name || '') !== alertHost) { return false; }
      if (!keyword) { return true; }
      return [alert.host_name, alert.title, alert.message, alert.category]
        .filter(function (part) { return part; })
        .join(' ').toLowerCase().indexOf(keyword) >= 0;
    });
  }

  function renderAlertRows() {
    var body = document.getElementById('alerts-body');
    var table = document.getElementById('alerts-table');
    var empty = document.getElementById('alerts-empty');
    if (!body || !table) { return; }
    var visible = filteredAlerts();
    while (body.firstChild) { body.removeChild(body.firstChild); }
    for (var i = 0; i < visible.length; i += 1) {
      body.appendChild(buildAlertRow(visible[i] || {}));
    }
    var hasData = visible.length > 0;
    table.hidden = !hasData;
    if (empty) {
      empty.hidden = hasData;
      empty.textContent = lastAlerts.length ? '没有匹配的告警' : '暂无数据';
    }
    setText(
      'alert-count',
      '共 ' + lastAlerts.length + ' 条' + (visible.length !== lastAlerts.length ? '（显示 ' + visible.length + ' 条）' : '')
    );
    updateAlertSelectionSummary();
  }

  function updateAlerts(alerts) {
    if (!Array.isArray(alerts)) { return; }
    updateFocusAlerts(alerts);
    lastAlerts = alerts;
    var activeIds = {};
    alerts.forEach(function (alert) {
      if (alert && alert.status === 'active' && alert.id != null) { activeIds[alert.id] = true; }
    });
    Object.keys(selectedAlertIds).forEach(function (alertId) {
      if (!activeIds[alertId]) { delete selectedAlertIds[alertId]; }
    });
    renderAlertRows();
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

  function refreshOverview() {
    return fetchJson('/api/overview').then(function (data) {
      if (!data) { return; }
      updateSummary(data.summary, data.hosts);
      updateHosts(data.hosts);
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

  function refreshAlerts() {
    return fetchJson(alertsUrl(alertStatus)).then(function (data) {
      if (!data) { return; }
      updateAlerts(data.alerts);
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

  function setAlertFilter(status) {
    alertStatus = status === 'all' ? 'all' : 'active';
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

  function init() {
    if (!hasDashboard()) { return; }

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

    // 告警页状态筛选（活动 / 全部）：切换后按状态重新拉取。
    var alertFilterBar = document.getElementById('alert-status-filter');
    if (alertFilterBar) {
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
    var alertRangeFilter = document.getElementById('alert-range-filter');
    var alertExport = document.getElementById('alert-export');
    // 支持从命令面板/外部链接带 q、severity 参数进入告警页时直接带上筛选条件。
    if (alertSearch && alertSearch.value) {
      alertKeyword = alertSearch.value;
    }
    if (alertSeverityFilter && alertSeverityFilter.value) {
      alertSeverity = alertSeverityFilter.value;
    }
    if (alertHostFilter && alertHostFilter.value) {
      alertHost = alertHostFilter.value;
    }
    if (alertRangeFilter && alertRangeFilter.value) {
      alertTimeRange = alertRangeFilter.value;
    }
    if (alertSearch) {
      alertSearch.addEventListener('input', function () {
        alertKeyword = alertSearch.value || '';
        renderAlertRows();
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
    if (alertSeverityFilter) {
      alertSeverityFilter.addEventListener('change', function () {
        alertSeverity = alertSeverityFilter.value || '';
        renderAlertRows();
      });
    }
    if (alertHostFilter) {
      alertHostFilter.addEventListener('change', function () {
        alertHost = alertHostFilter.value || '';
        renderAlertRows();
      });
    }
    if (alertRangeFilter) {
      alertRangeFilter.addEventListener('change', function () {
        alertTimeRange = alertRangeFilter.value || '';
        refreshAlerts().catch(function () {});
      });
    }
    if (alertExport) { alertExport.addEventListener('click', exportAlertsCsv); }

    bindOverviewRanges();
    bindAlertRanges();
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
