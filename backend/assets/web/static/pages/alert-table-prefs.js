/* 告警表格列宽/列显示偏好：localStorage 持久化 + 拖拽调整。 */

export var ALERT_COLUMNS = ['category', 'host', 'message'];
export var ALERT_COLUMNS_STORE = 'alerts:columns';

export function readAlertColumns() {
  try {
    var parsed = JSON.parse(localStorage.getItem(ALERT_COLUMNS_STORE) || 'null');
    if (!parsed || typeof parsed !== 'object') { return {}; }
    return parsed;
  } catch (err) {
    return {};
  }
}

export var HOST_WIDTHS_KEY = 'overview:colwidths';

export function readTableWidths(key) {
  try {
    var raw = window.localStorage.getItem(key);
    var parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

export function applyTableWidths(tableId, key) {
  var table = document.getElementById(tableId);
  if (!table) { return; }
  var widths = readTableWidths(key);
  var heads = table.querySelectorAll('thead th');
  table.style.tableLayout = widths.length ? 'fixed' : '';
  for (var i = 0; i < heads.length; i += 1) {
    var width = Number(widths[i]);
    heads[i].style.width = width > 0 ? width + 'px' : '';
  }
}

export function bindTableResizers(tableId, key) {
  var table = document.getElementById(tableId);
  if (!table) { return; }
  var heads = table.querySelectorAll('thead th');
  Array.prototype.forEach.call(heads, function (head, index) {
    if (index === heads.length - 1) { return; }
    if (head.querySelector('.col-resizer')) { return; }
    var grip = document.createElement('span');
    grip.className = 'col-resizer';
    grip.setAttribute('aria-hidden', 'true');
    head.appendChild(grip);
    grip.addEventListener('mousedown', function (event) {
      event.preventDefault();
      var startX = event.clientX;
      var startWidth = head.getBoundingClientRect().width;
      function onMove(moveEvent) {
        var width = Math.max(48, Math.round(startWidth + moveEvent.clientX - startX));
        table.style.tableLayout = 'fixed';
        head.style.width = width + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        var next = [];
        var headsNow = table.querySelectorAll('thead th');
        for (var i = 0; i < headsNow.length; i += 1) {
          next.push(Math.round(headsNow[i].getBoundingClientRect().width));
        }
        try { window.localStorage.setItem(key, JSON.stringify(next)); } catch (err) { /* ignore */ }
        applyTableWidths(tableId, key);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

var ALERT_WIDTHS_KEY = 'alerts:colwidths';

export function applyAlertWidths() {
  applyTableWidths('alerts-table', ALERT_WIDTHS_KEY);
}

export function bindAlertResizers() {
  bindTableResizers('alerts-table', ALERT_WIDTHS_KEY);
}

export function applyAlertColumns(hidden) {
  var table = document.getElementById('alerts-table');
  if (!table) { return; }
  for (var i = 0; i < ALERT_COLUMNS.length; i += 1) {
    var name = ALERT_COLUMNS[i];
    table.classList.toggle('hide-' + name, Boolean(hidden && hidden[name]));
  }
}

export function bindAlertColumns() {
  var menu = document.getElementById('alert-columns');
  var table = document.getElementById('alerts-table');
  if (!menu || !table) { return; }
  var hidden = readAlertColumns();
  var boxes = menu.querySelectorAll('[data-alert-col]');
  for (var i = 0; i < boxes.length; i += 1) {
    var name = boxes[i].getAttribute('data-alert-col');
    boxes[i].checked = !hidden[name];
  }
  applyAlertColumns(hidden);
  menu.addEventListener('change', function (event) {
    var box = event.target.closest('[data-alert-col]');
    if (!box) { return; }
    var key = box.getAttribute('data-alert-col');
    var next = readAlertColumns();
    if (box.checked) { delete next[key]; } else { next[key] = true; }
    try { localStorage.setItem(ALERT_COLUMNS_STORE, JSON.stringify(next)); } catch (err) {}
    applyAlertColumns(next);
  });
}
