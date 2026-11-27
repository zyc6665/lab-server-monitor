/* 轮询与可见性刷新：把定时器生命周期从页面装配逻辑里分离。 */

export function startPolling(fn, intervalMs, opts) {
  var timer = null;
  var win = (opts && opts.window) || (typeof window !== 'undefined' ? window : null);
  if (!win || typeof fn !== 'function') { return function () {}; }
  timer = win.setInterval(function () {
    try { fn(); } catch (error) { /* 保持轮询不断 */ }
  }, intervalMs);
  return function stop() {
    if (timer != null) { win.clearInterval(timer); timer = null; }
  };
}

export function refreshWhenVisible(doc, fn) {
  if (!doc || typeof fn !== 'function') { return function () {}; }
  var handler = function () { if (!doc.hidden) { try { fn(); } catch (error) { /* ignore */ } } };
  doc.addEventListener('visibilitychange', handler);
  return function stop() { doc.removeEventListener('visibilitychange', handler); };
}
