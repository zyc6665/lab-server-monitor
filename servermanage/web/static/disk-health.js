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

  // 两个筛选条件叠加：只看异常 + 关键字，谁筛掉了都要同步隐藏跳转芯片。
  function apply(onlyIssues) {
    var needle = keyword();
    var visibleHosts = 0;
    items.forEach(function (el) {
      var hide = (onlyIssues && !isIssue(el)) || !matchesSearch(el, needle);
      el.hidden = hide;
      if (!hide && el.classList.contains('disk-host')) { visibleHosts += 1; }
    });
    if (emptyHint) { emptyHint.hidden = !onlyIssues || visibleHosts > 0; }
    if (searchEmpty) { searchEmpty.hidden = !needle || visibleHosts > 0; }
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

  // 直接跳到某个主机锚点时，别让筛选把目标藏起来。
  if (window.location.hash && toggle.checked) {
    var target = document.getElementById(window.location.hash.replace('#', ''));
    if (target && target.hidden) {
      toggle.checked = false;
      apply(false);
      save(false);
    }
  }

  if (!hosts.length) { toggle.disabled = true; }

  // 每台主机的盘位明细可以折叠，盘多时先看摘要。
  function setCollapsed(button, collapsed) {
    var block = button.closest('.disk-host');
    if (!block) { return; }
    var body = block.querySelector('.table-wrap') || block.querySelector('.empty');
    if (body) { body.hidden = collapsed; }
    block.classList.toggle('is-collapsed', collapsed);
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    var caret = button.querySelector('.disk-caret');
    if (caret) { caret.textContent = collapsed ? '▸' : '▾'; }
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-disk-collapse]');
    if (!button) { return; }
    event.preventDefault();
    setCollapsed(button, button.getAttribute('aria-expanded') !== 'false');
  });

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
