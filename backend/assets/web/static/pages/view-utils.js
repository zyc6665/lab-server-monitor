/* 视图纯工具：主机排序键取值、结构指纹。无 DOM。 */

export function hostSortValue(host, key) {
  if (key === 'cpu') { return Number(host.cpu_percent); }
  if (key === 'memory') { return Number(host.memory_percent); }
  if (key === 'disk') { return Number(host.disk_percent); }
  if (key === 'gpu') { return Number(host.gpu_memory_percent); }
  if (key === 'users') { return Number(host.logged_in_user_count); }
  if (key === 'status') { return host.online ? 1 : 0; }
  if (key === 'alerts') { return Number(host.active_alert_count || 0); }
  if (key === 'health') {
    var status = (host.disk_health || {}).status || '';
    return status === 'critical' ? 3 : (status === 'warning' ? 2 : (status === 'ok' ? 1 : 0));
  }
  if (key === 'group') { return String(host.group || '未分组').toLowerCase(); }
  if (key === 'collected') { return String(host.collected_at || ''); }
  return String(host[key] || '').toLowerCase();
}

export function payloadSignature(value) {
  try { return JSON.stringify(value); } catch (err) { return ''; }
}
