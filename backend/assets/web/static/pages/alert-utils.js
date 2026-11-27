/* 告警页纯工具：时间分桶、类别标签。无 DOM、无全局状态。 */

export var ALERT_CATEGORY_LABELS = {
  cpu: 'CPU',
  memory: '内存',
  disk: '磁盘',
  gpu: 'GPU',
  offline: '主机离线',
  host: '主机',
  system: '系统',
  user: '服务器账号',
  availability: '服务检查',
  batch: '批量采集',
  storage: '存储'
};

export var TIMELINE_RANGES = {
  '24h': { hours: 24, stepHours: 1, label: '24 小时' },
  '7d': { hours: 24 * 7, stepHours: 24, label: '7 天' },
  '30d': { hours: 24 * 30, stepHours: 24, label: '30 天' },
  '90d': { hours: 24 * 90, stepHours: 24, label: '90 天' }
};

export function alertCategoryLabel(category) {
  return ALERT_CATEGORY_LABELS[category] || category;
}

export function bucketStartFor(value, range) {
  var when = typeof value === 'number' ? value : Date.parse(value || '');
  if (isNaN(when)) { return 0; }
  var spec = TIMELINE_RANGES[range] || TIMELINE_RANGES['24h'];
  var stepMs = spec.stepHours * 3600 * 1000;
  return Math.floor(when / stepMs) * stepMs;
}

export function timelineBuckets(range) {
  var spec = TIMELINE_RANGES[range] || TIMELINE_RANGES['24h'];
  var stepMs = spec.stepHours * 3600 * 1000;
  var now = Date.now();
  var end = Math.floor(now / stepMs) * stepMs;
  var start = end - (spec.hours / spec.stepHours - 1) * stepMs;
  var buckets = [];
  for (var t = start; t <= end; t += stepMs) {
    buckets.push({ start: t, end: t + stepMs, critical: 0, warning: 0, info: 0, total: 0 });
  }
  return buckets;
}

export function buildAlertTimeline(alerts, range) {
  var buckets = timelineBuckets(range);
  if (!buckets.length) { return buckets; }
  var first = buckets[0].start;
  var step = buckets[0].end - buckets[0].start;
  (alerts || []).forEach(function (alert) {
    var when = Date.parse(alert.created_at || '');
    if (isNaN(when) || when < first) { return; }
    var index = Math.floor((when - first) / step);
    if (index < 0 || index >= buckets.length) { return; }
    var bucket = buckets[index];
    var level = alert.severity === 'critical' || alert.severity === 'warning' ? alert.severity : 'info';
    bucket[level] += 1;
    bucket.total += 1;
  });
  return buckets;
}

export function timelineLabel(bucket, range) {
  var date = new Date(bucket.start);
  var pad = function (value) { return value < 10 ? '0' + value : String(value); };
  var day = (date.getMonth() + 1) + '-' + pad(date.getDate());
  if ((TIMELINE_RANGES[range] || {}).stepHours === 1) {
    return day + ' ' + pad(date.getHours()) + ':00';
  }
  return day;
}
