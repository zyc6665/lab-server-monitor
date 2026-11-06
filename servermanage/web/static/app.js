/* 服务器轮询监测 - 静态轮询脚本
 * 每 30 秒拉取 /api/overview 与 /api/alerts?status=active，原位更新 DOM。
 * 无框架、无外部依赖；任何网络/解析错误都被吞掉，绝不抛出未捕获异常。
 * 会话失效（401）时优雅跳转到 /login。 */
(function () {
  'use strict';

  var REFRESH_MS = 30000;

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
    if (method !== 'GET' && method !== 'HEAD') {
      var token = csrfToken();
      if (token) { headers['X-CSRF-Token'] = token; }
    }
    var base = {
      credentials: 'same-origin',
      headers: headers
    };
    if (opts.method) { base.method = opts.method; }

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

  function booleanBadge(online) {
    var badge = document.createElement('span');
    badge.className = 'badge ' + (online ? 'badge-online' : 'badge-offline');
    badge.textContent = online ? '在线' : '离线';
    return badge;
  }

  function updateSummary(summary) {
    if (!summary) { return; }
    setText('summary-online', summary.online == null ? 0 : summary.online);
    setText('summary-offline', summary.offline == null ? 0 : summary.offline);
    setText('summary-alerts', summary.active_alerts == null ? 0 : summary.active_alerts);
  }

  function buildHostRow(host) {
    var tr = document.createElement('tr');
    if (host.name) { tr.setAttribute('data-host', host.name); }

    var nameCell = document.createElement('td');
    var link = document.createElement('a');
    link.href = '/host/' + encodeURIComponent(host.name || '');
    link.textContent = host.name || '—';
    nameCell.appendChild(link);
    tr.appendChild(nameCell);

    tr.appendChild(textCell(host.host, 'mono'));

    var statusCell = document.createElement('td');
    statusCell.appendChild(booleanBadge(!!host.online));
    tr.appendChild(statusCell);

    tr.appendChild(textCell(formatPercent(host.cpu_percent)));
    tr.appendChild(textCell(formatPercent(host.memory_percent)));
    tr.appendChild(textCell(formatPercent(host.disk_percent)));
    tr.appendChild(textCell(formatPercent(host.gpu_memory_percent)));
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
    return tr;
  }

  function updateHosts(hosts) {
    if (!Array.isArray(hosts)) { return; }
    var tbody = document.getElementById('host-table-body');
    var table = document.getElementById('host-table');
    var empty = document.getElementById('empty-state');
    if (!tbody || !table) { return; }

    while (tbody.firstChild) { tbody.removeChild(tbody.firstChild); }
    for (var i = 0; i < hosts.length; i += 1) {
      tbody.appendChild(buildHostRow(hosts[i] || {}));
    }

    var hasData = hosts.length > 0;
    table.hidden = !hasData;
    if (empty) { empty.hidden = hasData; }
    setText('host-count', '共 ' + hosts.length + ' 台');
  }

  function buildAlertRow(alert) {
    var tr = document.createElement('tr');
    if (alert.id != null) { tr.setAttribute('data-alert-row', alert.id); }

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
    if (alert.status === 'active') {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'ack-btn';
      button.setAttribute('data-alert-id', alert.id);
      button.textContent = '确认';
      actionCell.appendChild(button);
    } else {
      var dash = document.createElement('span');
      dash.className = 'muted';
      dash.textContent = '—';
      actionCell.appendChild(dash);
    }
    tr.appendChild(actionCell);
    return tr;
  }

  function updateAlerts(alerts) {
    if (!Array.isArray(alerts)) { return; }
    var body = document.getElementById('alerts-body');
    var table = document.getElementById('alerts-table');
    var empty = document.getElementById('alerts-empty');
    if (!body || !table) { return; }

    while (body.firstChild) { body.removeChild(body.firstChild); }
    for (var i = 0; i < alerts.length; i += 1) {
      body.appendChild(buildAlertRow(alerts[i] || {}));
    }

    var hasData = alerts.length > 0;
    table.hidden = !hasData;
    if (empty) { empty.hidden = hasData; }
    setText('alert-count', '共 ' + alerts.length + ' 条');
  }

  function refreshOverview() {
    return fetchJson('/api/overview').then(function (data) {
      if (!data) { return; }
      updateSummary(data.summary);
      updateHosts(data.hosts);
    });
  }

  function refreshAlerts() {
    return fetchJson('/api/alerts?status=active').then(function (data) {
      if (!data) { return; }
      updateAlerts(data.alerts);
    });
  }

  function refreshAll() {
    // 两个请求互相独立；各自吞掉错误，互不影响。
    refreshOverview().catch(function () {});
    refreshAlerts().catch(function () {});
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
        return refreshAlerts();
      })
      .catch(function () {
        button.disabled = false;
      });
  }

  function init() {
    if (!hasDashboard()) { return; }

    // 事件委托：兼容服务端渲染的按钮与轮询后重建的按钮。
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (target && target.classList && target.classList.contains('ack-btn')) {
        ackAlert(target);
      }
    });

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
