/* 页面状态小工具：加载横幅、骨架屏开关、数据新鲜度（纯 DOM，无业务依赖）。 */

export function showLoadBanner(id, text) {
  var banner = document.getElementById(id);
  if (!banner) { return; }
  var label = banner.querySelector('.load-banner-text');
  if (label && text) { label.textContent = text; }
  banner.hidden = false;
}

export function hideLoadBanner(id) {
  var banner = document.getElementById(id);
  if (banner) { banner.hidden = true; }
}

export function hideSkeleton(id) {
  var skeleton = document.getElementById(id);
  if (skeleton) { skeleton.hidden = true; }
}

export function markFreshness(now) {
  var el = document.getElementById('data-freshness');
  if (!el) { return; }
  var stamp = now || new Date();
  var pad = function (value) { return value < 10 ? '0' + value : '' + value; };
  el.textContent = '更新于 ' + pad(stamp.getHours()) + ':' + pad(stamp.getMinutes()) + ':' + pad(stamp.getSeconds());
  el.setAttribute('data-updated-at', stamp.toISOString());
}
