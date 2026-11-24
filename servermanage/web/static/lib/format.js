export function formatBytesShared(value) {
  if (value === null || value === undefined || value === '') { return '—'; }
  const num = Number(value);
  if (isNaN(num) || num < 0) { return '—'; }
  if (num >= 1099511627776) { return (num / 1099511627776).toFixed(2) + ' TB'; }
  if (num >= 1073741824) { return (num / 1073741824).toFixed(1) + ' GB'; }
  if (num >= 1048576) { return (num / 1048576).toFixed(1) + ' MB'; }
  if (num >= 1024) { return (num / 1024).toFixed(1) + ' KB'; }
  return num.toFixed(0) + ' B';
}

export function formatStampShared(value) {
  const text = String(value || '');
  if (!text) { return '—'; }
  const date = new Date(text);
  if (isNaN(date.getTime())) { return text; }
  const pad = (n) => n < 10 ? '0' + n : '' + n;
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

export function formatPercent(value) {
  if (value === null || value === undefined || value === '') { return '—'; }
  const num = Number(value);
  if (isNaN(num)) { return '—'; }
  return num.toFixed(1) + '%';
}

export function formatStamp(value) {
  if (!value) { return '—'; }
  const text = String(value);
  const date = new Date(text);
  if (isNaN(date.getTime())) { return text; }
  const pad = (n) => n < 10 ? '0' + n : String(n);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return (sameYear ? '' : date.getFullYear() + '-') +
    pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

export function formatRelative(value) {
  if (!value) { return '—'; }
  const date = new Date(String(value));
  if (isNaN(date.getTime())) { return String(value); }
  let seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 0) { seconds = 0; }
  if (seconds < 45) { return '刚刚'; }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) { return minutes + ' 分钟前'; }
  const hours = Math.round(minutes / 60);
  if (hours < 24) { return hours + ' 小时前'; }
  const days = Math.round(hours / 24);
  if (days <= 7) { return days + ' 天前'; }
  return formatStamp(value);
}

export function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return '"' + text.split('"').join('""') + '"';
}
