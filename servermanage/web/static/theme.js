/* Light/dark theme persistence. Applies before first paint via a synchronous
 * script in <head>, then wires the topbar toggle. */
(function () {
  'use strict';
  var KEY = 'servermonitor-theme';
  var root = document.documentElement;

  function preferred() {
    try {
      var saved = window.localStorage.getItem(KEY);
      if (saved === 'dark' || saved === 'light') { return saved; }
    } catch (err) { /* localStorage can be unavailable */ }
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
      }
    } catch (err) { /* matchMedia can be unavailable */ }
    return 'light';
  }

  function apply(theme) {
    if (theme === 'dark') { root.setAttribute('data-theme', 'dark'); }
    else { root.removeAttribute('data-theme'); }
    var button = document.getElementById('theme-toggle');
    if (button) {
      button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
      button.title = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
    }
  }

  apply(preferred());

  document.addEventListener('DOMContentLoaded', function () {
    var button = document.getElementById('theme-toggle');
    if (!button) { return; }
    button.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      apply(next);
      try { window.localStorage.setItem(KEY, next); } catch (err) { /* ignore */ }
    });
  });
})();
