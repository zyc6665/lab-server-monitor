/* 告警筛选与排序的纯逻辑（无 DOM），供 app.js 与单测共用。 */
/* 说明：时间分桶函数由调用方经 opts.bucketStartFor 注入，保持本模块零依赖、可独立测试。 */
export function matchAlerts(alerts, filters, opts) {
  var f = filters || {};
  var o = opts || {};
  var keyword = String(f.keyword || '').trim().toLowerCase();
  var groups = o.hostGroups || {};
  return (alerts || []).filter(function (alert) {
    if (!o.ignoreBucket && f.bucket && o.timelineRange
      && o.bucketStartFor && o.bucketStartFor(alert.created_at, o.timelineRange) !== f.bucket) { return false; }
    if (!o.ignoreSeverity && f.severity && (alert.severity || '') !== f.severity) { return false; }
    if (f.host && (alert.host_name || '') !== f.host) { return false; }
    if (f.group && (groups[alert.host_name] || '未分组') !== f.group) { return false; }
    if (f.category && (alert.category || '') !== f.category) { return false; }
    if (!keyword) { return true; }
    return [alert.host_name, alert.title, alert.message, alert.category]
      .filter(function (part) { return part; })
      .join(' ').toLowerCase().indexOf(keyword) >= 0;
  });
}

export function sortAlerts(rows, order) {
  return (rows || []).slice().sort(function (left, right) {
    var a = String(left.created_at || '');
    var b = String(right.created_at || '');
    var cmp = a.localeCompare(b);
    return order === 'asc' ? cmp : -cmp;
  });
}

export function buildAlertsQuery(filters) {
  var f = filters || {};
  var params = new URLSearchParams();
  if (f.status && f.status !== 'active') { params.set('status', f.status); }
  if (f.severity) { params.set('severity', f.severity); }
  if (f.host) { params.set('host', f.host); }
  if (f.group) { params.set('group', f.group); }
  if (f.category) { params.set('category', f.category); }
  if (f.keyword) { params.set('q', f.keyword); }
  return params.toString();
}
