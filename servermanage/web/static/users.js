/* 服务器用户页：/users 的账号表格、统计与手动刷新。
 * 纯原生 JS，无第三方依赖；所有文本使用 textContent，绝不拼接 HTML。
 * 数据来源 GET /api/users（host / q / status 过滤），刷新按钮触发一次
 * 只读采集并轮询 /api/users/refresh-status，缺失账号可从本地基线移除。 */
(function () {
  'use strict';

  var REFRESH_POLL_MS = 2000;
  var REFRESH_MAX_MS = 600000;
  var SEARCH_DEBOUNCE_MS = 250;

  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? (meta.getAttribute('content') || '') : '';
  }

  function redirectToLogin() {
    if (window.location.pathname !== '/login') {
      window.location.assign('/login');
    }
  }

  function fetchJson(url, options) {
    var opts = options || {};
    var method = (opts.method || 'GET').toUpperCase();
    var headers = { Accept: 'application/json' };
    if (method !== 'GET' && method !== 'HEAD') {
      var token = csrfToken();
      if (token) { headers['X-CSRF-Token'] = token; }
    }
    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: headers
    }).then(function (response) {
      if (response.status === 401) {
        redirectToLogin();
        return null;
      }
      if (!response.ok) { return null; }
      var contentType = response.headers.get('content-type') || '';
      if (contentType.indexOf('application/json') === -1) { return null; }
      return response.json();
    });
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  // 后端返回的是带时区偏移的 ISO 字符串，这里显式转成本地时间展示。
  function formatTimestamp(value) {
    if (!value) { return '—'; }
    var text = String(value);
    // 后端已经格式化成 "YYYY-MM-DD HH:MM" 的本地时间，直接展示。
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) { return text; }
    var date = new Date(text);
    if (isNaN(date.getTime())) { return text; }
    return (
      date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
      ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    );
  }

  function formatBytes(value) {
    if (value === null || value === undefined || value === '') { return '—'; }
    var num = Number(value);
    if (isNaN(num) || num < 0) { return '—'; }
    if (num >= 1073741824) { return (num / 1073741824).toFixed(1) + ' GB'; }
    if (num >= 1048576) { return (num / 1048576).toFixed(1) + ' MB'; }
    if (num >= 1024) { return (num / 1024).toFixed(1) + ' KB'; }
    return num + ' B';
  }

  function setText(elementId, text) {
    var el = document.getElementById(elementId);
    if (el) { el.textContent = text; }
  }

  function appendCell(tr, text, extraClass) {
    var td = document.createElement('td');
    if (extraClass) { td.className = extraClass; }
    td.textContent = text;
    tr.appendChild(td);
    return td;
  }

  function appendBadgeCell(tr, text, badgeClass) {
    var td = document.createElement('td');
    var badge = document.createElement('span');
    badge.className = 'badge ' + badgeClass;
    badge.textContent = text;
    td.appendChild(badge);
    tr.appendChild(td);
    return td;
  }

  // 三态徽标：true/false 显示是否，null/undefined（例如账号已消失且没有历史）
  // 显示破折号，避免把"未知"误显示为"否"。
  function triBadgeCell(tr, value) {
    if (value === null || value === undefined) {
      return appendCell(tr, '—');
    }
    return appendBadgeCell(
      tr,
      value ? '是' : '否',
      value ? 'badge-ok' : 'badge-muted'
    );
  }

  function directoryText(row, prefix) {
    if (prefix === 'data' && row.data_supported === false) { return '不支持'; }
    if (row.state === 'missing') { return '缺失'; }
    if (!row[prefix + '_exists']) { return '缺失'; }
    var owner = row[prefix + '_owner'] || '—';
    var group = row[prefix + '_group'] || '—';
    var mode = row[prefix + '_mode'] || '—';
    var text = owner + ':' + group + ' · ' + mode + ' · ' + formatBytes(row[prefix + '_size_bytes']);
    if (row.usage_readable === false && row[prefix + '_size_bytes'] === null) {
      text += ' · 无权限读取占用';
    }
    return text;
  }

  function statusBadgeClass(row) {
    if (row.state === 'missing') { return 'badge-missing'; }
    if (row.issues && row.issues.length) { return 'badge-warning'; }
    return 'badge-ok';
  }

  function statusBadgeText(row) {
    if (row.state === 'missing') { return '缺失'; }
    if (row.issues && row.issues.length) { return '异常'; }
    return '正常';
  }

  function numberText(value) {
    return value === null || value === undefined ? '—' : String(value);
  }

  function buildRow(row) {
    var tr = document.createElement('tr');
    if (row.state === 'missing') { tr.className = 'user-row-missing'; }

    appendCell(tr, row.host_name || '—');
    appendCell(tr, row.username || '—');
    appendCell(tr, numberText(row.uid), 'mono');
    appendCell(tr, numberText(row.gid), 'mono');
    appendCell(tr, row.primary_group || '—');
    var groups = row.groups || [];
    appendCell(tr, groups.length ? groups.join(', ') : '—');
    appendBadgeCell(tr, statusBadgeText(row), statusBadgeClass(row));

    // 已消失的账号保留最后一次看到的属性，便于判断它当初是否在 docker/sudo 组。
    triBadgeCell(tr, row.in_docker);
    triBadgeCell(tr, row.in_sudo);

    appendCell(tr, directoryText(row, 'home'));
    appendCell(tr, directoryText(row, 'data'));
    appendCell(tr, formatTimestamp(row.collected_at), 'mono');

    var actionCell = document.createElement('td');
    if (row.state === 'missing') {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-link';
      button.textContent = '从基线移除';
      button.addEventListener('click', function () {
        button.disabled = true;
        removeUserBaseline(row.host_name, row.username).then(function (ok) {
          if (!ok) { button.disabled = false; }
        });
      });
      actionCell.appendChild(button);
    } else {
      actionCell.textContent = '—';
    }
    tr.appendChild(actionCell);
    return tr;
  }

  // 主机详情页的“前往用户页”会用 ?host= 预选主机，首帧就带上该过滤条件。
  var pendingHost = '';

  function renderHostOptions(hosts) {
    var select = document.getElementById('user-host-filter');
    if (!select) { return; }
    var current = select.value || pendingHost;
    while (select.options.length > 1) { select.remove(1); }
    (hosts || []).forEach(function (host) {
      var name = host && host.name;
      if (!name) { return; }
      var option = document.createElement('option');
      option.value = name;
      option.textContent = name + (host.status === 'error' ? '（采集异常）' : '');
      select.appendChild(option);
    });
    var exists = false;
    Array.prototype.forEach.call(select.options, function (option) {
      if (option.value === current) { exists = true; }
    });
    select.value = exists ? current : '';
    pendingHost = '';
  }

  function renderStats(summary) {
    var data = summary || {};
    setText('stat-user-total', String(data.total || 0));
    setText('stat-user-present', String(data.present || 0));
    setText('stat-user-missing', String(data.missing || 0));
    setText('stat-user-docker', String(data.docker_issues || 0));
    setText('stat-user-dirs', String(data.directory_issues || 0));
    var homeBytes = Number(data.home_bytes || 0);
    var dataBytes = Number(data.data_bytes || 0);
    setText('stat-user-bytes', formatBytes(homeBytes + dataBytes));
    setText(
      'stat-user-bytes-foot',
      '/home ' + formatBytes(homeBytes) + ' · /data ' + formatBytes(dataBytes)
    );
  }

  function renderUserRows(payload) {
    var data = payload || {};
    var rows = data.accounts || [];
    var body = document.getElementById('user-table-body');
    var table = document.getElementById('user-table');
    var empty = document.getElementById('user-empty');

    if (body) {
      while (body.firstChild) { body.removeChild(body.firstChild); }
      rows.forEach(function (row) { body.appendChild(buildRow(row)); });
    }
    if (table) { table.hidden = rows.length === 0; }
    if (empty) {
      empty.hidden = rows.length > 0;
      if (!rows.length) {
        empty.textContent = '暂无普通账号数据：请等待首次采集，或点击“立即刷新”触发一次只读采集。';
      }
    }

    renderStats(data.summary);
    renderHostOptions(data.hosts);
    setText('user-row-count', '共 ' + rows.length + ' 个账号');
  }

  function currentQuery() {
    var host = document.getElementById('user-host-filter');
    var search = document.getElementById('user-search');
    var status = document.getElementById('user-status-filter');
    var params = [];
    var hostValue = host && host.value ? host.value : pendingHost;
    if (hostValue) { params.push('host=' + encodeURIComponent(hostValue)); }
    if (search && search.value.trim()) { params.push('q=' + encodeURIComponent(search.value.trim())); }
    if (status && status.value) { params.push('status=' + encodeURIComponent(status.value)); }
    return params.length ? '?' + params.join('&') : '';
  }

  function setRefreshStatus(text) {
    setText('user-refresh-status', text || '');
  }

  function setRefreshBusy(busy) {
    var button = document.getElementById('user-refresh');
    if (!button) { return; }
    button.disabled = busy;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function fetchUsers() {
    return fetchJson('/api/users' + currentQuery()).then(function (payload) {
      if (payload) { renderUserRows(payload); }
      return payload;
    }).catch(function () {
      setRefreshStatus('账号数据加载失败，请稍后重试。');
      return null;
    });
  }

  function finishRefresh(message) {
    setRefreshStatus(message);
    setRefreshBusy(false);
  }

  function pollRefreshStatus(deadline) {
    var limit = deadline || (Date.now() + REFRESH_MAX_MS);
    return fetchJson('/api/users/refresh-status').then(function (payload) {
      if (!payload) { finishRefresh('无法获取采集状态。'); return null; }
      if (payload.running) {
        var done = payload.hosts_done || 0;
        var total = payload.hosts_total || 0;
        setRefreshStatus(total ? '采集中 ' + done + '/' + total + '…' : '采集中…');
        if (Date.now() > limit) {
          finishRefresh('采集仍在后台进行，请稍后刷新查看。');
          return null;
        }
        return new Promise(function (resolve) {
          window.setTimeout(resolve, REFRESH_POLL_MS);
        }).then(function () { return pollRefreshStatus(limit); });
      }
      if (payload.error) {
        finishRefresh('采集失败：' + payload.error);
        return null;
      }
      var failed = payload.hosts_failed || 0;
      var done = payload.hosts_done || 0;
      var errors = payload.errors || {};
      var failedHosts = Object.keys(errors);
      setRefreshStatus('采集完成，正在更新…');
      return fetchUsers().then(function () {
        if (failed > 0) {
          var detail = failedHosts.length ? failedHosts.join('、') : (failed + ' 台主机');
          finishRefresh('已更新，但 ' + failed + ' 台主机采集失败：' + detail);
        } else {
          finishRefresh('已更新' + (done ? '（' + done + ' 台主机）' : ''));
        }
        return payload;
      });
    }).catch(function () {
      finishRefresh('无法获取采集状态。');
      return null;
    });
  }

  function refreshUsers() {
    setRefreshBusy(true);
    setRefreshStatus('正在提交刷新任务…');
    return fetchJson('/api/users/refresh', { method: 'POST' }).then(function (payload) {
      if (!payload) { finishRefresh('刷新失败，请稍后重试。'); return null; }
      if (payload.error) { finishRefresh('刷新失败：' + payload.error); return null; }
      if (payload.started === false) { setRefreshStatus('已有采集任务在运行，等待其完成…'); }
      return pollRefreshStatus();
    }).catch(function () {
      finishRefresh('刷新失败，请稍后重试。');
      return null;
    });
  }

  // 只删除本地基线（以及该账号的 user-present 告警），不会触碰服务器。
  function removeUserBaseline(host, username) {
    if (!host || !username) { return Promise.resolve(false); }
    var token = csrfToken();
    var headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (token) { headers['X-CSRF-Token'] = token; }
    return fetch('/api/users/baseline/remove', {
      method: 'POST',
      credentials: 'same-origin',
      headers: headers,
      body: JSON.stringify({ host: host, username: username })
    }).then(function (response) {
      if (response.status === 401) {
        redirectToLogin();
        return false;
      }
      if (!response.ok) {
        setRefreshStatus('移除基线失败：' + username);
        return false;
      }
      setRefreshStatus('已从基线移除 ' + username + '，正在更新…');
      return fetchUsers().then(function () {
        setRefreshStatus('已从基线移除 ' + username);
        return true;
      });
    }).catch(function () {
      setRefreshStatus('移除基线失败：' + username);
      return false;
    });
  }

  function bindFilters() {
    var host = document.getElementById('user-host-filter');
    if (host) { host.addEventListener('change', function () { fetchUsers(); }); }
    var status = document.getElementById('user-status-filter');
    if (status) { status.addEventListener('change', function () { fetchUsers(); }); }
    var search = document.getElementById('user-search');
    if (search) {
      var timer = null;
      search.addEventListener('input', function () {
        if (timer) { window.clearTimeout(timer); }
        timer = window.setTimeout(function () { fetchUsers(); }, SEARCH_DEBOUNCE_MS);
      });
    }
  }

  function init() {
    if (!document.getElementById('user-table-body')) { return; }
    try {
      pendingHost = new URLSearchParams(window.location.search).get('host') || '';
    } catch (err) {
      pendingHost = '';
    }
    bindFilters();
    var button = document.getElementById('user-refresh');
    if (button) { button.addEventListener('click', function () { refreshUsers(); }); }
    fetchUsers();
  }

  window.renderUserRows = renderUserRows;
  window.fetchUsers = fetchUsers;
  window.refreshUsers = refreshUsers;
  window.removeUserBaseline = removeUserBaseline;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
