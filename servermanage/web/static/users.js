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
  var FILTER_STORE = 'users:filters';

  function readFilters() {
    try {
      var raw = JSON.parse(localStorage.getItem(FILTER_STORE) || 'null');
      if (raw && typeof raw.status === 'string') {
        return { status: raw.status, entry: raw.entry || 'all' };
      }
    } catch (err) { /* 忽略损坏的存储 */ }
    return { status: '', entry: 'all' };
  }

  function saveFilters() {
    var status = document.getElementById('user-status-filter');
    try {
      localStorage.setItem(FILTER_STORE, JSON.stringify({
        status: status ? status.value : '',
        entry: entryFilter
      }));
    } catch (err) { /* 存不了就算了，不影响筛选 */ }
  }

  var currentPlan = null;

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
    if (num >= 1099511627776) { return (num / 1099511627776).toFixed(2) + ' TB'; }
    if (num >= 1073741824) { return (num / 1073741824).toFixed(1) + ' GB'; }
    if (num >= 1048576) { return (num / 1048576).toFixed(1) + ' MB'; }
    if (num >= 1024) { return (num / 1024).toFixed(1) + ' KB'; }
    return num + ' B';
  }

  // 占用变化：只有拿到两次以上采样才显示，避免把"还没量过"说成 0。
  function gpuChip(memoryMb, procs, user) {
    if (!memoryMb) { return null; }
    var chip = document.createElement('a');
    chip.className = 'usage-gpu';
    chip.setAttribute('href', '/compute' + (user ? '#gpu-user-' + encodeURIComponent(user) : ''));
    var gb = memoryMb / 1024;
    chip.textContent = '显存 ' + (gb >= 1 ? gb.toFixed(1) + ' GB' : Math.round(memoryMb) + ' MB')
      + (procs ? ' · ' + procs + ' 进程' : '');
    chip.title = '来自最近一次 nvidia-smi 快照；点击查看算力概览里的占用明细';
    return chip;
  }

  function deltaChip(bytes, days) {
    if (bytes === null || bytes === undefined) { return null; }
    var num = Number(bytes);
    if (isNaN(num)) { return null; }
    var chip = document.createElement('span');
    var window_ = days ? '近 ' + days + ' 天 ' : '';
    if (num === 0) {
      chip.className = 'usage-delta';
      chip.textContent = window_ + '无变化';
      return chip;
    }
    var up = num > 0;
    chip.className = 'usage-delta ' + (up ? 'is-up' : 'is-down');
    chip.textContent = window_ + (up ? '+' : '−') + formatBytes(Math.abs(num));
    chip.setAttribute('title', up ? '占用在增加' : '占用在减少');
    return chip;
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
      text += ' · ' + (row.usage_hint || '暂时无法统计占用');
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

  // ---------------------------------------------------------------------------
  // 占用趋势：30 天小图与增长榜
  // ---------------------------------------------------------------------------

  function sparkline(points, options) {
    var opts = options || {};
    var width = opts.width || 132;
    var height = opts.height || 30;
    var values = (points || []).map(function (point) {
      return Number(point.total || 0);
    });
    if (values.length < 2) { return null; }
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = max - min || 1;
    var stepX = width / (values.length - 1);
    var coords = values.map(function (value, index) {
      var x = (index * stepX).toFixed(1);
      var y = (height - 3 - ((value - min) / span) * (height - 6)).toFixed(1);
      return x + ',' + y;
    });
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'usage-spark');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('role', 'img');
    var first = values[0];
    var last = values[values.length - 1];
    var change = last - first;
    var sign = change > 0 ? '+' : (change < 0 ? '−' : '');
    svg.setAttribute('aria-label', '近 30 天占用 ' + sign + formatBytes(Math.abs(change)));
    var area = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    area.setAttribute('class', 'usage-spark-area');
    area.setAttribute('points', '0,' + height + ' ' + coords.join(' ') + ' ' + width + ',' + height);
    svg.appendChild(area);
    var line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('class', 'usage-spark-line' + (change < 0 ? ' is-down' : ''));
    line.setAttribute('points', coords.join(' '));
    svg.appendChild(line);
    var title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = '近 30 天从 ' + formatBytes(first) + ' 到 ' + formatBytes(last)
      + '（' + sign + formatBytes(Math.abs(change)) + '）';
    svg.appendChild(title);
    return svg;
  }

  function fillTrends(hostName, accounts) {
    var nodes = document.querySelectorAll('[data-trend-host]');
    Array.prototype.forEach.call(nodes, function (node) {
      var account = node.getAttribute('data-trend-account') || '';
      var points = accounts && accounts[account];
      var chart = sparkline(points, { width: 132, height: 30 });
      while (node.firstChild) { node.removeChild(node.firstChild); }
      if (!chart) { node.hidden = true; return; }
      node.hidden = false;
      node.appendChild(chart);
      var first = Number(points[0].total || 0);
      var last = Number(points[points.length - 1].total || 0);
      var change = last - first;
      var label = document.createElement('span');
      label.className = 'usage-spark-text' + (change < 0 ? ' is-down' : '');
      label.textContent = (change > 0 ? '+' : (change < 0 ? '−' : '±'))
        + formatBytes(Math.abs(change));
      node.appendChild(label);
      node.setAttribute(
        'title',
        '近 30 天：' + formatBytes(first) + ' → ' + formatBytes(last)
      );
    });
  }

  var lastScan = null;
  var lastScanHint = '';

  function markScanningAccounts(scan) {
    var cards = document.querySelectorAll('.user-acct[data-account]');
    Array.prototype.forEach.call(cards, function (card) {
      var existing = card.querySelector('.user-acct-scan');
      if (existing) { existing.parentNode.removeChild(existing); }
      card.classList.remove('is-scanning', 'is-queued');
      if (!scan || !scan.running) { return; }
      var account = card.getAttribute('data-account') || '';
      var pending = card.getAttribute('data-usage-pending') === '1';
      if (!pending && scan.current_account !== account) { return; }
      var badge = document.createElement('span');
      if (scan.current_account === account) {
        badge.className = 'user-acct-scan is-active';
        badge.textContent = '正在统计占用…';
        card.classList.add('is-scanning');
      } else {
        badge.className = 'user-acct-scan';
        badge.textContent = '等待统计';
        card.classList.add('is-queued');
      }
      var head = card.querySelector('.user-acct-head');
      if (head) { head.appendChild(badge); }
    });
  }

  function loadTrends(hostName) {
    var accountHost = hostName || activeHost;
    if (!accountHost) { return Promise.resolve(); }
    return fetchJson('/api/users/history?host=' + encodeURIComponent(accountHost) + '&days=30')
      .then(function (payload) {
        fillTrends(accountHost, payload && payload.accounts);
      })
      .catch(function () {
        Array.prototype.forEach.call(document.querySelectorAll('[data-trend-host]'), function (node) {
          node.hidden = true;
        });
      });
  }

  function renderTopGrowth() {
    var list = document.getElementById('user-top-list');
    var card = document.getElementById('user-top-card');
    if (!list || !card) { return Promise.resolve(); }
    return fetchJson('/api/users/top?days=7&limit=8')
      .then(function (payload) {
        var items = (payload && payload.items) || [];
        while (list.firstChild) { list.removeChild(list.firstChild); }
        card.hidden = items.length === 0;
        items.forEach(function (item, index) {
          var row = document.createElement('li');
          row.className = 'user-top-row';
          var rank = document.createElement('span');
          rank.className = 'user-top-rank mono';
          rank.textContent = String(index + 1);
          row.appendChild(rank);
          var who = document.createElement('span');
          who.className = 'user-top-who';
          var account = document.createElement('strong');
          account.textContent = item.account || '—';
          who.appendChild(account);
          var hostLabel = document.createElement('span');
          hostLabel.className = 'muted small';
          hostLabel.textContent = item.host || '';
          who.appendChild(hostLabel);
          row.appendChild(who);
          var chip = deltaChip(item.delta, 7);
          if (chip) { row.appendChild(chip); }
          var total = document.createElement('span');
          total.className = 'user-top-total mono muted';
          total.textContent = formatBytes(item.current || 0);
          row.appendChild(total);
          list.appendChild(row);
        });
        return items.length;
      })
      .catch(function () { card.hidden = true; });
  }

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

    var trend = document.createElement('span');
    trend.className = 'user-host-trend';
    trend.setAttribute('data-trend-host', host.name);
    card.appendChild(trend);

    var foot = document.createElement('div');
    foot.className = 'user-host-foot';
    var usage = document.createElement('span');
    usage.className = 'mono';
    usage.textContent = formatBytes(host.bytes || 0) + (host.usage_readable === false ? '（部分不可读）' : '');
    foot.appendChild(usage);
    var hostDelta = deltaChip(host.delta_bytes, host.delta_days);
    if (hostDelta) { foot.appendChild(hostDelta); }
    if (host.gpu_memory_mb) {
      var hostGpu = document.createElement('span');
      hostGpu.className = 'user-host-gpu';
      hostGpu.textContent = '显存 ' + (host.gpu_memory_mb / 1024).toFixed(1) + ' GB';
      hostGpu.title = '该主机上所有账号当前占用的显存合计';
      foot.appendChild(hostGpu);
    }
    var seen = document.createElement('span');
    seen.className = 'muted';
    seen.textContent = host.last_scan_at ? '采集 ' + formatTimestamp(host.last_scan_at) : '尚未采集';
    if (host.last_usage_at) {
      seen.textContent += ' · 占用 ' + formatTimestamp(host.last_usage_at);
    }
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

  function renderUsageHint(text, scan) {
    var hint = document.getElementById('usage-hint');
    if (!hint) { return; }
    var running = !!(scan && scan.running);
    var message = text || '';
    if (running) {
      var total = scan.hosts_total || 0;
      var done = scan.hosts_done || 0;
      var progress = total ? done + '/' + total + ' 台主机' : '';
      var current = scan.current_account
        ? '（当前：' + (scan.current_host ? scan.current_host + ' 的 ' : '')
          + scan.current_account + '）'
        : '';
      message = '正在统计 /home、/data 占用'
        + current
        + (progress ? '，已完成 ' + progress : '')
        + '，首次统计大目录需要几十分钟，结果会逐台出现。';
    }
    hint.textContent = message;
    hint.hidden = !message;
    hint.classList.toggle('is-running', running);
  }

  var SORT_STORE = 'users:sort';

  function readSort() {
    try {
      var value = window.localStorage.getItem(SORT_STORE) || 'name';
      return ['name', 'usage', 'growth', 'gpu'].indexOf(value) === -1 ? 'name' : value;
    } catch (error) {
      return 'name';
    }
  }

  function saveSort(value) {
    try { window.localStorage.setItem(SORT_STORE, value); } catch (error) { /* 忽略 */ }
  }

  function sortHosts(list, mode) {
    var rows = list.slice();
    if (mode === 'name') {
      rows.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh-CN'); });
      return rows;
    }
    var key = mode === 'gpu' ? 'gpu_memory_mb' : (mode === 'growth' ? 'delta_bytes' : 'bytes');
    rows.sort(function (a, b) {
      var diff = (Number(b[key]) || 0) - (Number(a[key]) || 0);
      if (diff !== 0) { return diff; }
      return String(a.name).localeCompare(String(b.name), 'zh-CN');
    });
    return rows;
  }

  function currentSortMode() {
    var select = document.getElementById('user-sort');
    return select ? select.value : readSort();
  }

  function renderHosts(data) {
    var filters = currentFilters();
    var grid = document.getElementById('user-host-grid');
    var empty = document.getElementById('user-hosts-empty');
    var hosts = sortHosts(
      (data.hosts || []).filter(function (host) {
        return hostMatches(host, filters.keyword, filters.status);
      }),
      currentSortMode()
    );
    if (grid) {
      while (grid.firstChild) { grid.removeChild(grid.firstChild); }
      var totals = data.usage_totals || {};
      hosts.forEach(function (host) {
        var card = buildHostCard(host);
        grid.appendChild(card);
        var trend = card.querySelector('[data-trend-host]');
        if (!trend) { return; }
        var points = totals[host.name] || [];
        var chart = sparkline(points, { width: 120, height: 26 });
        if (chart) {
          trend.appendChild(chart);
        } else if (points.length === 1) {
          trend.textContent = '仅 1 次采样';
          trend.classList.add('is-pending');
        }
      });
    }
    if (empty) {
      empty.hidden = hosts.length > 0;
      if (!hosts.length) { empty.textContent = '没有符合筛选条件的主机。'; }
    }
    setText('user-host-count', '共 ' + hosts.length + ' 台主机');
    lastScan = data.usage_scan || null;
    lastScanHint = data.usage_hint || '';
    renderUsageHint(lastScanHint, lastScan);
    markScanningAccounts(lastScan);
  }

  // ---------------------------------------------------------------------------
  // 单台主机明细
  // ---------------------------------------------------------------------------

  function buildAccountCard(row) {
    var item = document.createElement('article');
    item.className = 'user-acct';
    item.setAttribute('data-account', row.username || '');
    if (row.home_size_bytes == null && row.data_size_bytes == null) {
      item.setAttribute('data-usage-pending', '1');
    }
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

    var trend = document.createElement('div');
    trend.className = 'user-acct-trend';
    trend.hidden = true;
    trend.setAttribute('data-trend-host', row.host_name || '');
    trend.setAttribute('data-trend-account', row.username || '');
    item.appendChild(trend);

    var foot = document.createElement('div');
    foot.className = 'user-acct-foot';
    var gpu = gpuChip(row.gpu_memory_mb, row.gpu_process_count, row.username);
    if (gpu) { foot.appendChild(gpu); }
    var accountDelta = deltaChip(row.usage_delta_bytes, row.usage_delta_days);
    if (accountDelta) {
      if (row.usage_delta_since) {
        accountDelta.setAttribute('title', '自 ' + formatTimestamp(row.usage_delta_since) + ' 起');
      }
      foot.appendChild(accountDelta);
    }
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
    } else {
      // 写操作入口始终可见：闸门未开时点击会弹出说明，告诉用户缺哪一项，
      // 而不是把按钮藏起来让人无从发现这个功能。
      [
        { operation: 'password', label: '重置密码' },
        { operation: 'docker', label: '加入 docker 组' },
        { operation: 'data', label: '建 data 目录' }
      ].forEach(function (action) {
        var actionButton = document.createElement('button');
        actionButton.type = 'button';
        actionButton.className = 'btn-link user-acct-action';
        actionButton.textContent = action.label;
        actionButton.setAttribute('data-user-admin', action.operation);
        actionButton.setAttribute('data-user-account', row.username || '');
        foot.appendChild(actionButton);
      });
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
    if (data.usage_scan) { lastScan = data.usage_scan; }
    if (data.usage_hint) { lastScanHint = data.usage_hint; }
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
      parts.push(host.last_usage_at
        ? '占用统计 ' + formatTimestamp(host.last_usage_at)
        : '占用未统计');
      meta.textContent = parts.join(' · ');
    }
    var link = document.getElementById('user-detail-host-link');
    if (link) { link.setAttribute('href', '/host/' + encodeURIComponent(activeHost)); }
    var createButton = document.getElementById('user-detail-create');
    if (createButton) { createButton.hidden = !host; }

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
    if (rows.length) { loadTrends(activeHost); }
    renderUsageHint(lastScanHint, lastScan);
    markScanningAccounts(lastScan);
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
    setTimeout(function () { loadTrends(name); }, 0);
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

  function refreshUsers(forceUsage) {
    setRefreshBusy(true);
    setRefreshStatus('正在提交刷新任务…');
    return fetchJson('/api/users/refresh', {
      method: 'POST',
      body: JSON.stringify({ usage: !!forceUsage })
    }).then(function (payload) {
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
    var sort = document.getElementById('user-sort');
    if (sort) {
      sort.value = readSort();
      sort.addEventListener('change', function () {
        saveSort(sort.value);
        fetchUsers();
      });
    }
    var status = document.getElementById('user-status-filter');
    if (status) {
      var saved = readFilters();
      if (saved.status) { status.value = saved.status; }
      if (saved.entry) { entryFilter = saved.entry; }
      Array.prototype.forEach.call(document.querySelectorAll('.user-chip'), function (chip) {
        var active = chip.getAttribute('data-user-state') === entryFilter;
        chip.className = 'user-chip' + (active ? ' active' : '');
        chip.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      status.addEventListener('change', function () {
        saveFilters();
        fetchUsers();
      });
    }
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
        saveFilters();
      });
    });
  }

  // ---------------------------------------------------------------------
  // 账号写操作（默认关闭；需全局开关 + 主机开关 + 已配置 sudo 密码）
  // ---------------------------------------------------------------------

  function adminHost() {
    if (!activeHost || !payloadState) { return null; }
    var list = payloadState.hosts || [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].name === activeHost) { return list[i]; }
    }
    return null;
  }

  function canWriteHost(host) {
    return Boolean(host && payloadWriteEnabled() && host.allow_user_write && host.sudo_configured);
  }

  function payloadWriteEnabled() {
    return Boolean(payloadState && payloadState.write_enabled);
  }

  function adminEl(id) { return document.getElementById(id); }

  function setAdminStatus(text, isError) {
    var node = adminEl('user-admin-status');
    if (!node) { return; }
    node.textContent = text || '';
    node.className = isError ? 'muted user-admin-error' : 'muted';
  }

  function writeBlocker(host) {
    if (!payloadWriteEnabled()) {
      return {
        text: '账号写操作的总开关还没打开（设置 → 服务器用户监控 → 允许账号写操作）。',
        href: '/settings#user-monitoring'
      };
    }
    if (!host.allow_user_write) {
      return {
        text: '这台主机还没有允许账号写操作（设置 → 主机 → 编辑 → 允许账号写操作）。',
        href: '/settings#hosts'
      };
    }
    if (!host.sudo_configured) {
      return {
        text: '这台主机还没有配置 sudo 密码，写操作需要提权才能执行。',
        href: '/settings#hosts'
      };
    }
    return null;
  }

  function openAdminDialog(defaults) {
    var dialog = adminEl('user-admin-dialog');
    if (!dialog) { return; }
    var host = adminHost();
    if (!host) {
      setRefreshStatus('请先选择一台主机');
      return;
    }
    var blocker = writeBlocker(host);
    var options = defaults || {};
    adminEl('user-admin-host').textContent = '目标主机：' + host.name + '（' + (host.address || '') + '）';
    var hint = adminEl('user-admin-hint');
    if (hint) {
      hint.hidden = !blocker;
      if (blocker) {
        setText('user-admin-hint-text', blocker.text + ' 开启后即可在这里预览执行计划。');
        var hintLink = adminEl('user-admin-hint-link');
        if (hintLink) { hintLink.setAttribute('href', blocker.href); }
      }
    }
    ['user-admin-operation', 'user-admin-account', 'user-admin-password',
      'user-admin-with-docker', 'user-admin-with-data'].forEach(function (id) {
      var node = adminEl(id);
      if (node) { node.disabled = Boolean(blocker); }
    });
    var previewButton = adminEl('user-admin-preview');
    if (previewButton) { previewButton.disabled = Boolean(blocker); }
    adminEl('user-admin-account').value = options.account || '';
    adminEl('user-admin-password').value = '';
    adminEl('user-admin-operation').value = options.operation || 'create';
    adminEl('user-admin-with-docker').checked = true;
    adminEl('user-admin-with-data').checked = true;
    adminEl('user-admin-plan').hidden = true;
    adminEl('user-admin-result').hidden = true;
    adminEl('user-admin-blocked').hidden = true;
    adminEl('user-admin-warnings').hidden = true;
    adminEl('user-admin-confirm-host').value = '';
    adminEl('user-admin-confirm-account').value = '';
    adminEl('user-admin-execute').disabled = true;
    setAdminStatus('');
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', 'open');
    }
    adminEl('user-admin-account').focus();
  }

  function closeAdminDialog() {
    var dialog = adminEl('user-admin-dialog');
    if (!dialog) { return; }
    if (typeof dialog.close === 'function') {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
    currentPlan = null;
  }

  function adminPost(url, body) {
    var token = csrfToken();
    var headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (token) { headers['X-CSRF-Token'] = token; }
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: headers,
      body: JSON.stringify(body || {})
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        return { status: response.status, ok: response.ok, data: data || {} };
      });
    });
  }

  function renderList(container, items, className) {
    container.textContent = '';
    (items || []).forEach(function (text) {
      var item = document.createElement('li');
      item.textContent = text;
      if (className) { item.className = className; }
      container.appendChild(item);
    });
    container.hidden = !(items && items.length);
  }

  function previewPlan() {
    var host = adminHost();
    if (!canWriteHost(host)) { return; }
    var payload = {
      host: host.name,
      operation: adminEl('user-admin-operation').value,
      account: adminEl('user-admin-account').value,
      with_docker: adminEl('user-admin-with-docker').checked,
      with_data: adminEl('user-admin-with-data').checked
    };
    var password = adminEl('user-admin-password').value;
    if (password) { payload.password = password; }
    setAdminStatus('正在生成执行计划…');
    adminPost('/api/users/plan', payload).then(function (result) {
      if (result.status === 401) { redirectToLogin(); return; }
      if (!result.ok) {
        setAdminStatus(result.data.message || '无法生成执行计划', true);
        return;
      }
      currentPlan = result.data.plan;
      renderPlan(currentPlan, host);
    }).catch(function () {
      setAdminStatus('无法生成执行计划，请检查网络后重试', true);
    });
  }

  function renderPlan(plan, host) {
    adminEl('user-admin-plan').hidden = false;
    adminEl('user-admin-result').hidden = true;
    adminEl('user-admin-plan-title').textContent = plan.operation_label + ' · ' + plan.account;
    adminEl('user-admin-plan-meta').textContent = '计划编号 ' + plan.plan_hash.slice(0, 12) +
      '，10 分钟内有效；密码只通过 SSH 标准输入传递，不会写入日志或浏览器。';

    var steps = adminEl('user-admin-steps');
    steps.textContent = '';
    (plan.steps || []).forEach(function (step) {
      var item = document.createElement('li');
      var title = document.createElement('strong');
      title.textContent = step.title + (step.elevated ? '（需要 root）' : '');
      item.appendChild(title);
      if (step.command) {
        var code = document.createElement('code');
        code.textContent = step.command;
        item.appendChild(code);
      }
      if (step.stdin_label) {
        var note = document.createElement('span');
        note.className = 'muted';
        note.textContent = ' · ' + step.stdin_label;
        item.appendChild(note);
      }
      steps.appendChild(item);
    });

    renderList(adminEl('user-admin-blocked'), plan.blocked_reasons || []);
    renderList(adminEl('user-admin-warnings'), plan.warnings || []);
    adminEl('user-admin-rollback').textContent = plan.rollback_hint || '';

    var confirm = adminEl('user-admin-confirm');
    confirm.hidden = Boolean(plan.blocked);
    adminEl('user-admin-confirm-host').value = '';
    adminEl('user-admin-confirm-account').value = '';
    adminEl('user-admin-execute').disabled = true;
    if (plan.blocked) {
      setAdminStatus('这个计划不能执行，请按上面的原因处理后重新预览', true);
      return;
    }
    setAdminStatus('计划已生成，请核对命令后输入确认文本');
    adminEl('user-admin-confirm-host').placeholder = host.name;
    adminEl('user-admin-confirm-account').placeholder = plan.account;
    adminEl('user-admin-confirm-host').focus();
  }

  function updateExecuteState() {
    if (!currentPlan || currentPlan.blocked) { return; }
    var hostOk = adminEl('user-admin-confirm-host').value.trim() === currentPlan.host;
    var accountOk = adminEl('user-admin-confirm-account').value.trim() === currentPlan.account;
    adminEl('user-admin-execute').disabled = !(hostOk && accountOk);
  }

  function executePlan() {
    if (!currentPlan || currentPlan.blocked) { return; }
    var button = adminEl('user-admin-execute');
    button.disabled = true;
    setAdminStatus('正在执行，请不要关闭窗口…');
    adminPost('/api/users/execute', {
      plan_hash: currentPlan.plan_hash,
      confirm_host: adminEl('user-admin-confirm-host').value.trim(),
      confirm_account: adminEl('user-admin-confirm-account').value.trim()
    }).then(function (result) {
      if (result.status === 401) { redirectToLogin(); return; }
      var outcome = result.data.result || {};
      var steps = outcome.steps || [];
      var list = adminEl('user-admin-result-steps');
      list.textContent = '';
      steps.forEach(function (step) {
        var item = document.createElement('li');
        item.className = step.status === 'ok' ? 'user-admin-step-ok' : 'user-admin-step-failed';
        item.textContent = (step.status === 'ok' ? '✓ ' : '✗ ') + step.title +
          (step.stderr ? '：' + step.stderr : '');
        list.appendChild(item);
      });
      adminEl('user-admin-result').hidden = false;
      if (result.ok) {
        setAdminStatus('执行成功，正在刷新账号列表…');
        currentPlan = null;
        fetchUsers();
      } else {
        setAdminStatus(result.data.message || outcome.error || '执行失败，请查看每一步的输出', true);
      }
    }).catch(function () {
      setAdminStatus('执行请求失败，请检查网络后重试', true);
      updateExecuteState();
    });
  }

  function bindAdminDialog() {
    var dialog = adminEl('user-admin-dialog');
    if (!dialog) { return; }
    adminEl('user-admin-close').addEventListener('click', closeAdminDialog);
    adminEl('user-admin-preview').addEventListener('click', previewPlan);
    adminEl('user-admin-execute').addEventListener('click', executePlan);
    var hostInput = adminEl('user-admin-confirm-host');
    var accountInput = adminEl('user-admin-confirm-account');
    hostInput.addEventListener('input', updateExecuteState);
    accountInput.addEventListener('input', updateExecuteState);
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) { return; }
      var trigger = target.closest('[data-user-admin]');
      if (!trigger) { return; }
      event.preventDefault();
      openAdminDialog({
        operation: trigger.getAttribute('data-user-admin') || 'create',
        account: trigger.getAttribute('data-user-account') || ''
      });
    });
  }

  function applyKeywordFromUrl() {
    var incoming = '';
    try {
      incoming = new URLSearchParams(window.location.search).get('q') || '';
    } catch (err) {
      incoming = '';
    }
    var search = document.getElementById('user-search');
    if (!search || !incoming) { return; }
    search.value = incoming;
  }

  function init() {
    renderTopGrowth();
    if (!document.getElementById('user-host-grid')) { return; }
    try {
      activeHost = new URLSearchParams(window.location.search).get('host') || '';
    } catch (err) {
      activeHost = '';
    }
    bindFilters();
    applyKeywordFromUrl();
    bindAdminDialog();
    var button = document.getElementById('user-refresh');
    if (button) { button.addEventListener('click', function () { refreshUsers(false); }); }
    var usageButton = document.getElementById('user-refresh-usage');
    if (usageButton) {
      usageButton.addEventListener('click', function () { refreshUsers(true); });
    }
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
