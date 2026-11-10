/* 磁盘健康：只看异常主机。
 * 状态记在 localStorage，刷新和轮询后保持；隐藏的是主机区块和对应跳转芯片。 */
(function () {
  'use strict';

  var STORAGE_KEY = 'disk:onlyIssues';

  var toggle = document.getElementById('disk-only-issues');
  if (!toggle) { return; }

  var emptyHint = document.getElementById('disk-filter-empty');
  var items = Array.prototype.slice.call(
    document.querySelectorAll('[data-disk-issues]')
  );
  var hosts = items.filter(function (el) { return el.classList.contains('disk-host'); });

  function isIssue(el) {
    return el.getAttribute('data-disk-issues') === '1';
  }

  function apply(onlyIssues) {
    var visibleHosts = 0;
    items.forEach(function (el) {
      var hide = onlyIssues && !isIssue(el);
      el.hidden = hide;
      if (!hide && el.classList.contains('disk-host')) { visibleHosts += 1; }
    });
    if (emptyHint) { emptyHint.hidden = !onlyIssues || visibleHosts > 0; }
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
})();
