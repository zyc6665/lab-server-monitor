/* 磁盘健康：只看异常主机。
 * 状态记在 localStorage，刷新和轮询后保持；隐藏的是主机区块和对应跳转芯片。 */
(function () {
  'use strict';

  var STORAGE_KEY = 'disk:onlyIssues';

  var toggle = document.getElementById('disk-only-issues');
  if (!toggle) { return; }

  var emptyHint = document.getElementById('disk-filter-empty');
  var searchEmpty = document.getElementById('disk-search-empty');
  var search = document.getElementById('disk-search');
  var items = Array.prototype.slice.call(
    document.querySelectorAll('[data-disk-issues]')
  );
  var hosts = items.filter(function (el) { return el.classList.contains('disk-host'); });

  function isIssue(el) {
    return el.getAttribute('data-disk-issues') === '1';
  }

  function keyword() {
    return search ? (search.value || '').trim().toLowerCase() : '';
  }

  function matchesSearch(el, needle) {
    if (!needle) { return true; }
    var haystack = el.getAttribute('data-disk-search');
    if (haystack === null) { haystack = (el.textContent || '').toLowerCase(); }
    return haystack.indexOf(needle) !== -1;
  }

  // 分组折叠：收起某个分组时只留分组标题，成员主机全部隐藏。
  var GROUP_KEY = 'disk:collapsed-groups';

  function readGroups() {
    try {
      var raw = window.localStorage.getItem(GROUP_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function saveGroups(list) {
    try {
      window.localStorage.setItem(GROUP_KEY, JSON.stringify(list));
    } catch (error) {
      /* 隐私模式忽略 */
    }
  }

  function groupOf(el) {
    return el.getAttribute('data-disk-group-member') || '';
  }

  // 三个条件叠加：只看异常 + 关键字 + 分组折叠，谁筛掉了都要同步隐藏跳转芯片；
  // 分组标题在该组没有任何匹配主机时也一起隐藏。
  function apply(onlyIssues) {
    var needle = keyword();
    var collapsedGroups = readGroups();
    var visibleHosts = 0;
    var matchedGroups = {};
    var groupHits = {};
    items.forEach(function (el) {
      var matched = !((onlyIssues && !isIssue(el)) || !matchesSearch(el, needle));
      if (matched && el.classList.contains('disk-host')) {
        matchedGroups[groupOf(el)] = true;
        groupHits[groupOf(el)] = (groupHits[groupOf(el)] || 0) + 1;
      }
      // 跳转芯片属于导航，分组收起时也要保留，否则想跳进去反而找不到入口。
      if (el.classList.contains('disk-jump-link')) {
        el.hidden = !matched;
        return;
      }
      var collapsed = el.classList.contains('disk-host') && collapsedGroups.indexOf(groupOf(el)) !== -1;
      el.hidden = !matched || collapsed;
      if (!el.hidden && el.classList.contains('disk-host')) { visibleHosts += 1; }
    });
    Array.prototype.forEach.call(
      document.querySelectorAll('.disk-group-head'),
      function (head) {
        var name = head.getAttribute('data-disk-group') || '';
        head.hidden = !matchedGroups[name];
      }
    );
    if (emptyHint) { emptyHint.hidden = !onlyIssues || visibleHosts > 0; }
    if (searchEmpty) { searchEmpty.hidden = !needle || visibleHosts > 0; }
    // 搜索时给每个分组标出命中台数，并给一条总数提示，省得逐组点开找。
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-group-count]'),
      function (label) {
        var head = label.closest('.disk-group-head');
        var name = head ? (head.getAttribute('data-disk-group') || '') : '';
        var size = Number(label.getAttribute('data-group-size') || 0) || 0;
        if (!needle) {
          label.textContent = size + ' 台主机';
          return;
        }
        var hits = groupHits[name] || 0;
        label.textContent = hits ? ('命中 ' + hits + ' / ' + size + ' 台') : ('0 / ' + size + ' 台');
      }
    );
    var searchCount = document.getElementById('disk-search-count');
    if (searchCount) {
      searchCount.hidden = !needle || visibleHosts === 0;
      searchCount.textContent = '搜索命中 ' + visibleHosts + ' 台主机';
    }
  }

  function setGroupCollapsed(head, collapsed) {
    var name = head.getAttribute('data-disk-group') || '';
    var list = readGroups().filter(function (item) { return item !== name; });
    if (collapsed) { list.push(name); }
    saveGroups(list);
    head.classList.toggle('is-collapsed', collapsed);
    var button = head.querySelector('[data-disk-group-collapse]');
    if (button) { button.setAttribute('aria-expanded', collapsed ? 'false' : 'true'); }
    var caret = head.querySelector('.disk-group-caret');
    if (caret) { caret.textContent = collapsed ? '▸' : '▾'; }
    apply(toggle.checked);
  }

  function read() {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch (error) {
      return false;
    }
  }

  function save(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    } catch (error) {
      /* 隐私模式写不进去就算了，不影响本次筛选。 */
    }
  }

  toggle.checked = read();
  apply(toggle.checked);

  toggle.addEventListener('change', function () {
    apply(toggle.checked);
    save(toggle.checked);
  });

  if (search) {
    search.addEventListener('input', function () { apply(toggle.checked); });
    search.addEventListener('search', function () { apply(toggle.checked); });
  }

  // 分组被收起时点跳转芯片 / 打开带锚点的链接，先把目标所在分组展开，
  // 这样"跳过去"不会跳到一个看不见的主机。
  function expandGroupOf(el) {
    var name = groupOf(el);
    if (!name) { return false; }
    if (readGroups().indexOf(name) === -1) { return false; }
    var head = null;
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-disk-group]'),
      function (candidate) {
        if (!head && candidate.getAttribute('data-disk-group') === name) { head = candidate; }
      }
    );
    if (head) {
      setGroupCollapsed(head, false);
      return true;
    }
    return false;
  }

  function revealTarget(el) {
    if (!el) { return; }
    expandGroupOf(el);
    if (el.hidden && toggle.checked && !isIssue(el)) {
      toggle.checked = false;
      apply(false);
      save(false);
    }
    if (el.hidden) { apply(toggle.checked); }
  }

  function revealHash() {
    if (!window.location.hash) { return; }
    revealTarget(document.getElementById(window.location.hash.replace('#', '')));
  }

  // 直接跳到某个主机锚点时，别让筛选或折叠把目标藏起来。
  revealHash();

  // 跳转芯片：拦截默认滚动，先展开分组再滚过去，滚动位置更准。
  Array.prototype.forEach.call(
    document.querySelectorAll('.disk-jump-link'),
    function (link) {
      link.addEventListener('click', function (event) {
        var id = (link.getAttribute('href') || '').replace('#', '');
        var target = id ? document.getElementById(id) : null;
        if (!target) { return; }
        event.preventDefault();
        revealTarget(target);
        window.requestAnimationFrame(function () {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', '#' + id);
        }
      });
    }
  );

  window.addEventListener('hashchange', revealHash);

  if (!hosts.length) { toggle.disabled = true; }

  // 每台主机的盘位明细可以折叠，盘多时先看摘要；折叠状态记在 localStorage，
  // 下次打开还是你上次收好的样子。
  var COLLAPSE_KEY = 'disk:collapsed';

  function readCollapsed() {
    try {
      var raw = window.localStorage.getItem(COLLAPSE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function saveCollapsed(list) {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(list));
    } catch (error) {
      /* 隐私模式忽略 */
    }
  }

  function setCollapsed(button, collapsed) {
    var block = button.closest('.disk-host');
    if (!block) { return; }
    var body = block.querySelector('.table-wrap') || block.querySelector('.empty');
    if (body) { body.hidden = collapsed; }
    block.classList.toggle('is-collapsed', collapsed);
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    var caret = button.querySelector('.disk-caret');
    if (caret) { caret.textContent = collapsed ? '▸' : '▾'; }
    var anchor = block.id || '';
    if (anchor) {
      var list = readCollapsed().filter(function (item) { return item !== anchor; });
      if (collapsed) { list.push(anchor); }
      saveCollapsed(list);
    }
  }

  var collapsed = readCollapsed();
  if (collapsed.length) {
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-disk-collapse]'),
      function (button) {
        var block = button.closest('.disk-host');
        if (block && collapsed.indexOf(block.id) !== -1) {
          setCollapsed(button, true);
        }
      }
    );
  }

  document.addEventListener('click', function (event) {
    var groupButton = event.target.closest('[data-disk-group-collapse]');
    if (groupButton) {
      event.preventDefault();
      var head = groupButton.closest('.disk-group-head');
      if (head) { setGroupCollapsed(head, groupButton.getAttribute('aria-expanded') !== 'false'); }
      return;
    }
    var button = event.target.closest('[data-disk-collapse]');
    if (!button) { return; }
    event.preventDefault();
    setCollapsed(button, button.getAttribute('aria-expanded') !== 'false');
  });

  // 刷新后把上次收起来的分组恢复。
  var groupsCollapsed = readGroups();
  if (groupsCollapsed.length) {
    Array.prototype.forEach.call(
      document.querySelectorAll('.disk-group-head'),
      function (head) {
        if (groupsCollapsed.indexOf(head.getAttribute('data-disk-group') || '') !== -1) {
          setGroupCollapsed(head, true);
        }
      }
    );
  }

  // 从别处跳到某台主机时，别让折叠把它藏起来。
  if (window.location.hash) {
    var jumpTarget = document.getElementById(window.location.hash.replace('#', ''));
    if (jumpTarget) {
      var jumpButton = jumpTarget.querySelector('[data-disk-collapse]');
      if (jumpButton && jumpButton.getAttribute('aria-expanded') === 'false') {
        setCollapsed(jumpButton, false);
      }
    }
  }

  var exportButton = document.getElementById('disk-export');
  if (exportButton) {
    exportButton.addEventListener('click', function () {
      exportCsv(exportButton);
    });
  }

  function csvCell(value) {
    var text = String(value === undefined || value === null ? '' : value);
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function rowTexts(row) {
    return Array.prototype.map.call(row.children, function (cell) {
      return (cell.textContent || '').trim();
    });
  }

  function collectCsv() {
    var lines = [];
    var hostBlocks = Array.prototype.slice.call(document.querySelectorAll('.disk-host'));
    hostBlocks.forEach(function (block) {
      if (block.hidden) { return; }
      var nameNode = block.querySelector('.disk-host-id a');
      var hostName = nameNode ? (nameNode.textContent || '').trim() : '';
      var table = block.querySelector('table.disk-table');
      if (!table) { return; }
      var header = rowTexts(table.querySelector('thead tr'));
      if (!lines.length) {
        lines.push(['主机'].concat(header).map(csvCell).join(','));
      }
      Array.prototype.forEach.call(table.querySelectorAll('tbody tr'), function (row) {
        lines.push([hostName].concat(rowTexts(row)).map(csvCell).join(','));
      });
    });
    return lines;
  }

  function exportCsv(button) {
    var lines = collectCsv();
    if (lines.length < 2) {
      if (emptyHint) { emptyHint.hidden = false; }
      return;
    }
    var csv = '\ufeff' + lines.join('\r\n') + '\r\n';
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    var stamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = 'disk-health-' + stamp + '.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    var original = button.textContent;
    button.textContent = '已导出 ' + (lines.length - 1) + ' 块盘';
    window.setTimeout(function () { button.textContent = original; }, 2400);
  }
})();

// -- v0.1.154 磁盘表按列排序（纯前端，只读） --
(function () {
  var STORE = 'disk:sort';
  var HEALTH_RANK = { ok: 0, warning: 1, error: 2, critical: 3 };
  var state = { key: '', dir: 1 };
  try {
    var saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved && saved.key) { state = { key: saved.key, dir: saved.dir === -1 ? -1 : 1 }; }
  } catch (err) { state = { key: '', dir: 1 }; }

  function valueOf(row, key) {
    var raw = row.getAttribute('data-' + key) || '';
    if (key === 'health') { return HEALTH_RANK[raw] === undefined ? 9 : HEALTH_RANK[raw]; }
    var num = parseFloat(raw);
    return isNaN(num) ? null : num;
  }

  function apply() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-disk-sort]'), function (th) {
      if (th.getAttribute('data-disk-sort') === state.key) {
        th.setAttribute('aria-sort', state.dir === 1 ? 'ascending' : 'descending');
      } else {
        th.removeAttribute('aria-sort');
      }
    });
    if (!state.key) { return; }
    Array.prototype.forEach.call(document.querySelectorAll('table.disk-table tbody'), function (body) {
      var rows = Array.prototype.slice.call(body.querySelectorAll('[data-disk-row]'));
      rows.sort(function (a, b) {
        var va = valueOf(a, state.key);
        var vb = valueOf(b, state.key);
        if (va === null && vb === null) { return 0; }
        if (va === null) { return 1; }
        if (vb === null) { return -1; }
        return (va - vb) * state.dir;
      });
      rows.forEach(function (row) { body.appendChild(row); });
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-disk-sort]'), function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-disk-sort');
      state.dir = state.key === key && state.dir === 1 ? -1 : 1;
      state.key = key;
      try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (err) { /* 忽略 */ }
      apply();
    });
  });

  apply();
})();
