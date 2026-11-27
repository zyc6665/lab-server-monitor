/* 主机列表视图/密度/筛选偏好：从 app.js 拆出的纯 UI 偏好逻辑。 */
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

  function getHostView() { return hostView; }

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

  function hostRowMatches(tr, group, status, keyword, tag) {
    if (group && tr.getAttribute('data-group') !== group) { return false; }
    if (tag) {
      // 标签存储为小写 "|" 连接串；标签本身可能含空格，按 | 切分精确匹配。
      var tags = (tr.getAttribute('data-tags') || '').split('|');
      if (tags.indexOf(tag) === -1) { return false; }
    }
    if (status === 'online' && tr.getAttribute('data-online') !== '1') { return false; }
    if (status === 'offline' && tr.getAttribute('data-online') !== '0') { return false; }
    if (status === 'alert' && Number(tr.getAttribute('data-alert-count') || 0) <= 0) { return false; }
    if (status === 'attention' && Number(tr.getAttribute('data-attention') || 0) <= 0) { return false; }
    if (status === 'silenced' && tr.getAttribute('data-silenced') !== '1') { return false; }
    if (status === 'stale') {
      var uptime = Number(tr.getAttribute('data-uptime'));
      if (!(uptime >= 0 && uptime < 0.9)) { return false; }
    }
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

  function saveHostFilters(group, status, tag) {
    try {
      if (!group && !status && !tag) {
        localStorage.removeItem(HOST_FILTER_KEY);
        return;
      }
      localStorage.setItem(HOST_FILTER_KEY, JSON.stringify({ group: group || '', status: status || '', tag: tag || '' }));
    } catch (err) {}
  }

  function restoreHostFilters() {
    var saved = readHostFilters();
    var groupEl = document.getElementById('filter-group');
    var statusEl = document.getElementById('filter-status');
    var tagEl = document.getElementById('filter-tag');
    var pairs = [[groupEl, saved.group], [statusEl, saved.status], [tagEl, saved.tag]];
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
    var tagEl = document.getElementById('filter-tag');
    var group = groupEl ? groupEl.value : '';
    var status = statusEl ? statusEl.value : '';
    var keyword = keywordEl ? keywordEl.value.trim().toLowerCase() : '';
    var tag = tagEl ? tagEl.value : '';
    var rows = tbody ? tbody.querySelectorAll('tr') : [];
    var cards = grid ? grid.querySelectorAll('[data-host]') : [];
    var i;
    var rowsVisible = 0;
    for (i = 0; i < rows.length; i += 1) {
      var showRow = hostRowMatches(rows[i], group, status, keyword, tag);
      rows[i].hidden = !showRow;
      if (showRow) { rowsVisible += 1; }
    }
    var cardsVisible = 0;
    for (i = 0; i < cards.length; i += 1) {
      var showCard = hostRowMatches(cards[i], group, status, keyword, tag);
      cards[i].hidden = !showCard;
      if (showCard) { cardsVisible += 1; }
    }
    var visible = hostView === 'cards' ? cardsVisible : rowsVisible;
    var totalCount = hostView === 'cards' ? cards.length : rows.length;
    var count = document.getElementById('filter-count');
    if (count) {
      count.textContent = (group || status || keyword || tag)
        ? ('筛选出 ' + visible + ' / ' + totalCount + ' 台')
        : '';
    }
    var clear = document.getElementById('filter-clear');
    if (clear) { clear.hidden = !(group || status || keyword || tag); }
    saveHostFilters(group, status, tag);
    if (totalCount > 0) {
      var table = document.getElementById('host-table');
      var empty = document.getElementById('empty-state');
      var emptyText = document.getElementById('empty-state-text');
      var emptyClear = document.getElementById('empty-state-clear');
      var filtering = Boolean(group || status || keyword || tag);
      if (table) { table.hidden = rowsVisible === 0; }
      if (empty) { empty.hidden = visible !== 0; }
      if (emptyText) {
        if (!filtering) {
          emptyText.textContent = '暂无主机数据';
        } else {
          var picked = [];
          if (group) { picked.push('分组「' + group + '」'); }
          if (tag) { picked.push('标签「' + tag + '」'); }
          if (status) { picked.push('状态「' + status + '」'); }
          if (keyword) { picked.push('关键字「' + keyword + '」'); }
          emptyText.textContent = '没有符合条件的主机：' + picked.join('、');
        }
      }
      if (emptyClear) { emptyClear.hidden = !filtering; }
    }
  }


export {
  readHostView,
  applyHostView,
  bindHostView,
  getHostView,
  readDensity,
  applyDensity,
  bindDensity,
  readHostFilters,
  saveHostFilters,
  restoreHostFilters,
  hostRowMatches,
  applyHostFilters,
};
