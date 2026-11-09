/* 服务器用户页：/users 的主机汇总、单机账号明细与手动刷新。
 * 纯原生 JS，无第三方依赖；所有文本使用 textContent，绝不拼接 HTML。
 * 数据来源 GET /api/users（q / status 过滤），刷新按钮触发一次只读采集并轮询
 * /api/users/refresh-status，缺失账号可从本地基线移除。
 *
 * 页面分两层：默认显示按主机汇总的卡片，点某台主机后在同一页切换到该主机的
 * 账号明细（地址栏保留 ?host=），返回按钮回到汇总。账号明细用紧凑行卡而不是
 * 宽表格，避免账号多时左右拖动。 */
(function () {
  'use strict';

  var REFRESH_POLL_MS = 2000;
  var REFRESH_MAX_MS = 600000;
  var SEARCH_DEBOUNCE_MS = 250;

  var payloadState = null;
  var activeHost = '';
  var entryFilter = 'all';

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

  function numberText(value) {
    return value === null || value === undefined ? '—' : String(value);
  }

  function makeBadge(text, badgeClass) {
    var badge = document.createElement('span');
    badge.className = 'badge ' + badgeClass;
    badge.textContent = text;
    return badge;
  }

  // 三态徽标：true/false 显示是否，null/undefined（例如账号已消失且没有历史）
  // 显示破折号，避免把“未知”误显示为“否”。
  function triBadge(value) {
    if (value === null || value === undefined) {
      var unknown = makeBadge('—', 'badge-muted');
      unknown.setAttribute('title', '未知');
      return unknown;
    }
    return makeBadge(value ? '是' : '否', value ? 'badge-ok' : 'badge-muted');
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

  function hostStatusText(status) {
    if (status === 'error') { return '采集异常'; }
    if (status === 'unknown') { return '等待首次采集'; }
    if (status === 'disabled') { return '未启用'; }
    return '正常';
  }

  function hostStatusClass(status) {
    if (status === 'error') { return 'badge-warning'; }
    if (status === 'disabled') { return 'badge-muted'; }
    return 'badge-ok';
  }

  function issueCount(host) {
    return (host.docker_issues || 0) + (host.directory_issues || 0) + (host.missing || 0);
  }

  function matchesKeyword(text, keyword) {
    if (!keyword) { return true; }
    return String(text || '').toLowerCase().indexOf(keyword) !== -1;
  }

  function hostMatches(host, keyword, status) {
    if (keyword) {
      var haystack = [host.name, host.address].join(' ');
      if (!matchesKeyword(haystack, keyword)) { return false; }
    }
    var issues = issueCount(host);
    if (status === 'ok') { return issues === 0 && host.status !== 'error'; }
    if (status === 'warning') { return issues > 0 || host.status === 'error'; }
    if (status === 'error') { return host.status === 'error'; }
    return true;
  }

  function currentFilters() {
    var search = document.getElementById('user-search');
    var status = document.getElementById('user-status-filter');
    return {
      keyword: search && search.value.trim() ? search.value.trim().toLowerCase() : '',
      status: status && status.value ? status.value : 'all'
    };
  }

  // ---------------------------------------------------------------------------
  // 主机汇总
  // ---------------------------------------------------------------------------

  function buildHostCard(host) {
    var card = document.createElement('button');
    card.type = 'button';
    card.className = 'user-host-card';
    if (issueCount(host) > 0 || host.status === 'error') {
      card.className += ' has-issues';
    }
    card.setAttribute('data-host', host.name || '');
    card.setAttribute('aria-label', '查看 ' + (host.name || '') + ' 的账号');

    var head = document.createElement('div');
    head.className = 'user-host-head';
    var name = document.createElement('span');
    name.className = 'user-host-name';
    name.textContent = host.name || '—';
    head.appendChild(name);
    head.appendChild(makeBadge(hostStatusText(host.status), hostStatusClass(host.status)));
    card.appendChild(head);

    var address = document.createElement('div');
    address.className = 'user-host-address mono';
    address.textContent = host.address || '—';
    card.appendChild(address);

    var counts = document.createElement('div');
    counts.className = 'user-host-counts';
    counts.appendChild(metric('账号', String(host.accounts || 0)));
    counts.appendChild(metric('在线', String(host.present || 0)));
    counts.appendChild(metric('缺失', String(host.missing || 0), host.missing ? 'is-warn' : ''));
    counts.appendChild(metric('docker 异常', String(host.docker_issues || 0), host.docker_issues ? 'is-warn' : ''));
    counts.appendChild(metric('目录异常', String(host.directory_issues || 0), host.directory_issues ? 'is-warn' : ''));
    card.appendChild(counts);

    var foot = document.createElement('div');
    foot.className = 'user-host-foot';
    var usage = document.createElement('span');
    usage.className = 'mono';
    usage.textContent = formatBytes(host.bytes || 0) + (host.usage_readable === false ? '（部分不可读）' : '');
    foot.appendChild(usage);
    var seen = document.createElement('span');
    seen.className = 'muted';
    seen.textContent = host.last_scan_at ? '采集 ' + formatTimestamp(host.last_scan_at) : '尚未采集';
    foot.appendChild(seen);
    card.appendChild(foot);

    if (host.last_error) {
      var error = document.createElement('div');
      error.className = 'user-host-error';
      error.textContent = host.last_error;
      card.appendChild(error);
    }

    card.addEventListener('click', function () { selectHost(host.name || ''); });
    return card;
  }

  function metric(label, value, extraClass) {
    var box = document.createElement('span');
    box.className = 'user-host-metric' + (extraClass ? ' ' + extraClass : '');
    var val = document.createElement('strong');
    val.textContent = value;
    box.appendChild(val);
    var lab = document.createElement('span');
    lab.className = 'muted';
    lab.textContent = label;
    box.appendChild(lab);
    return box;
  }

  function renderHosts(data) {
    var filters = currentFilters();
    var grid = document.getElementById('user-host-grid');
    var empty = document.getElementById('user-hosts-empty');
    var hosts = (data.hosts || []).filter(function (host) {
      return hostMatches(host, filters.keyword, filters.status);
    });
    if (grid) {
      while (grid.firstChild) { grid.removeChild(grid.firstChild); }
      hosts.forEach(function (host) { grid.appendChild(buildHostCard(host)); });
    }
    if (empty) {
      empty.hidden = hosts.length > 0;
      if (!hosts.length) { empty.textContent = '没有符合筛选条件的主机。'; }
    }
    setText('user-host-count', '共 ' + hosts.length + ' 台主机');
  }

  // ---------------------------------------------------------------------------
  // 单台主机明细
  // ---------------------------------------------------------------------------

  function buildAccountCard(row) {
    var item = document.createElement('article');
    item.className = 'user-acct';
    if (row.state === 'missing') { item.className += ' user-row-missing'; }
    else if (row.issues && row.issues.length) { item.className += ' has-issues'; }

    var head = document.createElement('div');
    head.className = 'user-acct-head';
    var name = document.createElement('span');
    name.className = 'user-acct-name';
    name.textContent = row.username || '—';
    head.appendChild(name);
    head.appendChild(makeBadge(statusBadgeText(row), statusBadgeClass(row)));
    var groups = document.createElement('span');
    groups.className = 'user-acct-badges';
    var dockerWrap = document.createElement('span');
    dockerWrap.className = 'user-acct-tag';
    dockerWrap.appendChild(document.createTextNode('docker '));
    dockerWrap.appendChild(triBadge(row.in_docker));
    groups.appendChild(dockerWrap);
    var sudoWrap = document.createElement('span');
    sudoWrap.className = 'user-acct-tag';
    sudoWrap.appendChild(document.createTextNode('sudo '));
    sudoWrap.appendChild(triBadge(row.in_sudo));
    groups.appendChild(sudoWrap);
    head.appendChild(groups);
    item.appendChild(head);

    var meta = document.createElement('div');
    meta.className = 'user-acct-meta';
    meta.appendChild(metaItem('UID', numberText(row.uid), 'mono'));
    meta.appendChild(metaItem('GID', numberText(row.gid), 'mono'));
    meta.appendChild(metaItem('主组', row.primary_group || '—'));
    var extra = (row.groups || []);
    meta.appendChild(metaItem('附加组', extra.length ? extra.join(', ') : '—'));
    item.appendChild(meta);

    var dirs = document.createElement('div');
    dirs.className = 'user-acct-dirs';
    dirs.appendChild(dirItem('家目录', directoryText(row, 'home'), row.state !== 'missing' && !row.home_exists));
    dirs.appendChild(dirItem('数据目录', directoryText(row, 'data'), row.state !== 'missing' && row.data_supported !== false && !row.data_exists));
    item.appendChild(dirs);

    var foot = document.createElement('div');
    foot.className = 'user-acct-foot';
    var seen = document.createElement('span');
    seen.className = 'muted mono';
    seen.textContent = row.collected_at ? '采集 ' + formatTimestamp(row.collected_at) : '尚未采集';
    foot.appendChild(seen);
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
      foot.appendChild(button);
    }
    item.appendChild(foot);
    return item;
  }

  function metaItem(label, value, extraClass) {
    var box = document.createElement('span');
    box.className = 'user-acct-meta-item';
    var lab = document.createElement('span');
    lab.className = 'muted';
    lab.textContent = label;
    box.appendChild(lab);
    var val = document.createElement('span');
    if (extraClass) { val.className = extraClass; }
    val.textContent = value;
    box.appendChild(val);
    return box;
  }

  function dirItem(label, value, isIssue) {
    var box = document.createElement('div');
    box.className = 'user-acct-dir' + (isIssue ? ' is-warn' : '');
    var lab = document.createElement('span');
    lab.className = 'user-acct-dir-label';
    lab.textContent = label;
    box.appendChild(lab);
    var val = document.createElement('span');
    val.className = 'mono';
    val.textContent = value;
    box.appendChild(val);
    return box;
  }

  function hostByName(name) {
    var hosts = (payloadState && payloadState.hosts) || [];
    for (var i = 0; i < hosts.length; i += 1) {
      if (hosts[i].name === name) { return hosts[i]; }
    }
    return null;
  }

  function accountMatches(row, keyword, status, entry) {
    if (entry === 'issue' && !(row.issues && row.issues.length) && row.state !== 'missing') {
      return false;
    }
    if (entry === 'missing' && row.state !== 'missing') { return false; }
    if (status === 'ok' && (row.issues && row.issues.length)) { return false; }
    if (status === 'warning' && (!(row.issues && row.issues.length) && row.state !== 'missing')) {
      return false;
    }
    if (!keyword) { return true; }
    var haystack = [
      row.username,
      row.host_name,
      row.primary_group,
      (row.groups || []).join(' ')
    ].join(' ');
    return matchesKeyword(haystack, keyword);
  }

  function renderDetail(data) {
    var host = hostByName(activeHost);
    var filters = currentFilters();
    var rows = (data.accounts || []).filter(function (row) {
      if (row.host_name !== activeHost) { return false; }
      return accountMatches(row, filters.keyword, filters.status, entryFilter);
    });

    var title = document.getElementById('user-detail-title');
    if (title) { title.textContent = activeHost; }
    var meta = document.getElementById('user-detail-meta');
    if (meta && host) {
      var parts = [];
      if (host.address) { parts.push(host.address); }
      parts.push(hostStatusText(host.status));
      parts.push('账号 ' + (host.accounts || 0));
      if (host.last_scan_at) { parts.push('采集 ' + formatTimestamp(host.last_scan_at)); }
      meta.textContent = parts.join(' · ');
    }
    var link = document.getElementById('user-detail-host-link');
    if (link) { link.setAttribute('href', '/host/' + encodeURIComponent(activeHost)); }

    var all = (data.accounts || []).filter(function (row) { return row.host_name === activeHost; });
    setText('chip-count-all', String(all.length));
    setText(
      'chip-count-issue',
      String(all.filter(function (row) {
        return (row.issues && row.issues.length) || row.state === 'missing';
      }).length)
    );
    setText(
      'chip-count-missing',
      String(all.filter(function (row) { return row.state === 'missing'; }).length)
    );

    var list = document.getElementById('user-acct-list');
    if (list) {
      while (list.firstChild) { list.removeChild(list.firstChild); }
      rows.forEach(function (row) { list.appendChild(buildAccountCard(row)); });
    }
    var empty = document.getElementById('user-detail-empty');
    if (empty) {
      empty.hidden = rows.length > 0;
      if (!rows.length) {
        empty.textContent = all.length
          ? '没有符合筛选条件的账号。'
          : '这台主机还没有采集到普通账号，可点击“立即刷新”触发一次只读采集。';
      }
    }
  }

  function setEntryFilter(value) {
    entryFilter = value || 'all';
    var chips = document.querySelectorAll('.user-chip');
    Array.prototype.forEach.call(chips, function (chip) {
      var active = chip.getAttribute('data-user-state') === entryFilter;
      chip.className = 'user-chip' + (active ? ' active' : '');
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (payloadState) { renderDetail(payloadState); }
  }

  function selectHost(name) {
    activeHost = name || '';
    if (activeHost) { entryFilter = 'all'; }
    syncUrl();
    renderAll();
  }

  function syncUrl() {
    try {
      var url = activeHost
        ? '/users?host=' + encodeURIComponent(activeHost)
        : '/users';
      window.history.replaceState(null, '', url);
    } catch (err) {
      /* history API 不可用时忽略，仅影响地址栏。 */
    }
  }

  // ---------------------------------------------------------------------------
  // 渲染入口
  // ---------------------------------------------------------------------------

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

  function renderAll() {
    if (!payloadState) { return; }
    renderStats(payloadState.summary);
    var hostsView = document.getElementById('user-hosts');
    var detailView = document.getElementById('user-detail');
    var known = activeHost ? hostByName(activeHost) : null;
    if (activeHost && !known) { activeHost = ''; }

    if (activeHost) {
      if (hostsView) { hostsView.hidden = true; }
      if (detailView) { detailView.hidden = false; }
      renderDetail(payloadState);
    } else {
      if (hostsView) { hostsView.hidden = false; }
      if (detailView) { detailView.hidden = true; }
      renderHosts(payloadState);
    }
  }

  function renderUserRows(payload) {
    if (payload) { payloadState = payload; }
    renderAll();
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

  function currentQuery() {
    var filters = currentFilters();
    var params = [];
    if (filters.keyword) { params.push('q=' + encodeURIComponent(filters.keyword)); }
    if (filters.status && filters.status !== 'all') {
      params.push('status=' + encodeURIComponent(filters.status));
    }
    return params.length ? '?' + params.join('&') : '';
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
    var back = document.getElementById('user-detail-back');
    if (back) { back.addEventListener('click', function () { selectHost(''); }); }
    var chips = document.querySelectorAll('.user-chip');
    Array.prototype.forEach.call(chips, function (chip) {
      chip.addEventListener('click', function () {
        setEntryFilter(chip.getAttribute('data-user-state') || 'all');
      });
    });
  }

  function init() {
    if (!document.getElementById('user-host-grid')) { return; }
    try {
      activeHost = new URLSearchParams(window.location.search).get('host') || '';
    } catch (err) {
      activeHost = '';
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
  window.selectUserHost = selectHost;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
