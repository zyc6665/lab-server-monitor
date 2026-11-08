/* 全局命令面板：Ctrl/Cmd+K 打开，快速跳转页面、主机和常用操作。
 * 纯原生 JS，无第三方依赖；所有文本使用 textContent，绝不拼接 HTML。 */
(function () {
  'use strict';

  var overlay = document.getElementById('command-palette');
  var input = document.getElementById('command-input');
  var results = document.getElementById('command-results');
  var trigger = document.getElementById('command-trigger');
  if (!overlay || !input || !results || !trigger) { return; }

  var PAGES = [
    { label: '概览', meta: '页面', href: '/', keywords: 'overview 汇总 仪表盘' },
    { label: '主机列表', meta: '页面', href: '/hosts', keywords: 'hosts 服务器 列表' },
    { label: '磁盘健康', meta: '页面', href: '/disk-health', keywords: 'disk 磁盘 阵列 storcli' },
    { label: '告警', meta: '页面', href: '/alerts', keywords: 'alerts 告警 通知' },
    { label: '终端', meta: '页面', href: '/terminal', keywords: 'terminal ssh 终端' },
    { label: '设置', meta: '页面', href: '/settings', keywords: 'settings 配置 主机 导入' }
  ];

  var ACTIONS = [
    { label: '刷新当前页', meta: '操作 · 重新加载数据', keywords: 'refresh reload 刷新 重新加载', action: 'refresh' },
    { label: '切换深浅色主题', meta: '操作 · 外观', keywords: 'theme dark light 主题 深色 浅色', action: 'theme' },
    { label: '采集全部主机', meta: '操作 · 立即采集', keywords: 'collect 采集 全部 主机', action: 'collect-all' },
    { label: '采集异常主机', meta: '操作 · 只采集异常', keywords: 'collect 采集 异常 离线 告警 主机', action: 'collect-abnormal' },
    { label: '查看严重告警', meta: '操作 · 只看 critical', href: '/alerts?severity=critical', keywords: 'critical 严重 告警 alerts' },
    { label: '打开系统状态', meta: '操作 · 设置页系统状态', href: '/settings#system', keywords: 'health 状态 系统 自检 diagnostics' },
    { label: '全网巡检报告', meta: '操作 · 下载文本报告', href: '/api/overview/report', keywords: 'report 巡检 报告 导出' }
  ];

  var hosts = null;
  var hostsLoadedAt = 0;
  var alerts = null;
  var alertsLoadedAt = 0;
  var items = [];
  var activeIndex = 0;
  var currentQuery = '';

  function normalise(value) {
    return String(value === null || value === undefined ? '' : value).toLowerCase();
  }

  function hostMatches(host, query) {
    var haystack = [
      host.name, host.host, host.group, host.owner, host.location,
      Array.isArray(host.tags) ? host.tags.join(' ') : ''
    ].map(normalise).join(' ');
    return haystack.indexOf(query) !== -1;
  }

  function alertMatches(alert, query) {
    var haystack = [
      alert.host_name, alert.title, alert.message, alert.category, alert.severity
    ].map(normalise).join(' ');
    return haystack.indexOf(query) !== -1;
  }

  function severityLabel(severity) {
    if (severity === 'critical') { return '严重'; }
    if (severity === 'warning') { return '警告'; }
    if (severity === 'info') { return '提示'; }
    return '告警';
  }

  // 某些操作只在概览/主机列表存在，打开面板时按页面能力过滤。
  function actionAvailable(action) {
    if (action === 'collect-all') { return !!document.getElementById('collect-all-hosts'); }
    if (action === 'collect-abnormal') { return !!document.getElementById('collect-abnormal-hosts'); }
    return true;
  }

  function runAction(action) {
    var bridge = window.serverMonitorActions || {};
    if (action === 'refresh') {
      if (typeof bridge.refresh === 'function') { bridge.refresh(); }
      else { window.location.reload(); }
      return;
    }
    if (action === 'theme') {
      var themeButton = document.getElementById('theme-toggle');
      if (themeButton) { themeButton.click(); }
      return;
    }
    if (action === 'collect-all' && typeof bridge.collectAll === 'function') {
      bridge.collectAll();
      return;
    }
    if (action === 'collect-abnormal' && typeof bridge.collectAbnormal === 'function') {
      bridge.collectAbnormal();
    }
  }

  function buildItems(query) {
    var q = normalise(query).trim();
    var next = [];
    PAGES.forEach(function (page) {
      var haystack = normalise(page.label + ' ' + page.meta + ' ' + page.keywords);
      if (!q || haystack.indexOf(q) !== -1) {
        next.push({ type: 'page', label: page.label, meta: page.meta, href: page.href });
      }
    });
    ACTIONS.forEach(function (entry) {
      if (!actionAvailable(entry.action)) { return; }
      var haystack = normalise(entry.label + ' ' + entry.meta + ' ' + entry.keywords);
      if (!q || haystack.indexOf(q) !== -1) {
        next.push({
          type: 'action',
          label: entry.label,
          meta: entry.meta,
          href: entry.href,
          action: entry.action
        });
      }
    });
    var hostLimit = q ? 12 : 6;
    var added = 0;
    (hosts || []).forEach(function (host) {
      if (added >= hostLimit) { return; }
      if (q && !hostMatches(host, q)) { return; }
      var meta = [host.host || '', host.group || '未分组', host.owner || ''].filter(Boolean).join(' · ');
      next.push({
        type: 'host',
        label: host.name || '未命名主机',
        meta: meta,
        href: '/host/' + encodeURIComponent(host.name || ''),
        online: host.online
      });
      added += 1;
    });
    var alertLimit = q ? 8 : 3;
    var addedAlerts = 0;
    (alerts || []).forEach(function (alert) {
      if (addedAlerts >= alertLimit) { return; }
      if (q && !alertMatches(alert, q)) { return; }
      var label = severityLabel(alert.severity);
      var alertParams = [];
      if (alert.host_name) { alertParams.push('host=' + encodeURIComponent(alert.host_name)); }
      if (q) { alertParams.push('q=' + encodeURIComponent(q)); }
      next.push({
        type: 'alert',
        label: alert.title || alert.message || '告警',
        meta: [alert.host_name || '', label, alert.created_at || ''].filter(Boolean).join(' · '),
        severity: alert.severity || 'info',
        severityLabel: label,
        href: '/alerts' + (alertParams.length ? '?' + alertParams.join('&') : '')
      });
      addedAlerts += 1;
    });
    return next;
  }

  function createItem(item, index) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'command-item' + (index === activeIndex ? ' active' : '');
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false');
    button.setAttribute('data-command-index', String(index));

    var text = document.createElement('span');
    text.className = 'command-item-text';
    var label = document.createElement('span');
    label.className = 'command-item-label';
    label.textContent = item.label;
    text.appendChild(label);
    var meta = document.createElement('span');
    meta.className = 'command-item-meta';
    meta.textContent = item.meta || '';
    text.appendChild(meta);
    button.appendChild(text);

    if (item.type === 'host') {
      var badge = document.createElement('span');
      badge.className = 'command-item-badge ' + (item.online === false ? 'is-offline' : 'is-online');
      badge.textContent = item.online === false ? '离线' : '在线';
      button.appendChild(badge);
    } else if (item.type === 'alert') {
      var severityBadge = document.createElement('span');
      severityBadge.className = 'command-item-badge severity-' + item.severity;
      severityBadge.textContent = item.severityLabel || '告警';
      button.appendChild(severityBadge);
    } else {
      var kind = document.createElement('span');
      kind.className = 'command-item-kind';
      kind.textContent = item.type === 'page' ? '页面' : '操作';
      button.appendChild(kind);
    }

    button.addEventListener('click', function () { openItem(item); });
    button.addEventListener('mouseenter', function () { setActive(index); });
    return button;
  }

  function setActive(index) {
    if (!items.length) { activeIndex = 0; return; }
    activeIndex = Math.max(0, Math.min(items.length - 1, index));
    var nodes = results.querySelectorAll('.command-item');
    for (var i = 0; i < nodes.length; i += 1) {
      var active = i === activeIndex;
      nodes[i].classList.toggle('active', active);
      nodes[i].setAttribute('aria-selected', active ? 'true' : 'false');
      if (active && nodes[i].scrollIntoView) { nodes[i].scrollIntoView({ block: 'nearest' }); }
    }
  }

  function render() {
    items = buildItems(currentQuery);
    if (activeIndex >= items.length) { activeIndex = Math.max(0, items.length - 1); }
    while (results.firstChild) { results.removeChild(results.firstChild); }
    if (!items.length) {
      var empty = document.createElement('p');
      empty.className = 'command-empty';
      empty.textContent = currentQuery ? '没有匹配的主机、告警或页面' : '暂无可搜索内容';
      results.appendChild(empty);
      return;
    }
    items.forEach(function (item, index) {
      results.appendChild(createItem(item, index));
    });
    setActive(activeIndex);
  }

  function openItem(item) {
    if (!item) { return; }
    closePalette();
    if (item.action) { runAction(item.action); return; }
    window.location.assign(item.href);
  }

  function loadHosts() {
    var fresh = hosts && Date.now() - hostsLoadedAt < 60 * 1000;
    if (fresh) { return Promise.resolve(); }
    return fetch('/api/overview', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }).then(function (response) {
      if (!response.ok) { return null; }
      return response.json();
    }).then(function (payload) {
      hosts = (payload && payload.hosts) || [];
      hostsLoadedAt = Date.now();
      if (!overlay.hidden) { render(); }
    }).catch(function () {
      hosts = hosts || [];
    });
  }

  function loadAlerts() {
    var fresh = alerts && Date.now() - alertsLoadedAt < 60 * 1000;
    if (fresh) { return Promise.resolve(); }
    return fetch('/api/alerts?status=active', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }).then(function (response) {
      if (!response.ok) { return null; }
      return response.json();
    }).then(function (payload) {
      alerts = (payload && payload.alerts) || [];
      alertsLoadedAt = Date.now();
      if (!overlay.hidden) { render(); }
    }).catch(function () {
      alerts = alerts || [];
    });
  }

  function loadContext() {
    return Promise.all([loadHosts(), loadAlerts()]);
  }

  function openPalette() {
    currentQuery = '';
    input.value = '';
    activeIndex = 0;
    overlay.hidden = false;
    document.body.classList.add('command-open');
    render();
    window.requestAnimationFrame(function () { input.focus(); });
    loadContext();
  }

  function closePalette() {
    overlay.hidden = true;
    document.body.classList.remove('command-open');
    if (document.activeElement === input) { input.blur(); }
  }

  function move(delta) {
    if (!items.length) { return; }
    setActive((activeIndex + delta + items.length) % items.length);
  }

  input.addEventListener('input', function () {
    currentQuery = input.value || '';
    activeIndex = 0;
    render();
  });

  input.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      openItem(items[activeIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
    }
  });

  trigger.addEventListener('click', openPalette);
  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) { closePalette(); }
  });

  document.addEventListener('keydown', function (event) {
    var isShortcut = (event.ctrlKey || event.metaKey) && normalise(event.key) === 'k';
    if (isShortcut) {
      event.preventDefault();
      if (overlay.hidden) { openPalette(); } else { closePalette(); }
      return;
    }
    if (event.key === 'Escape' && !overlay.hidden) {
      event.preventDefault();
      closePalette();
    }
  });
})();
