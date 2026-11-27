/* 告警表格行构建：从 app.js 拆出的 DOM 工厂，依赖通过 deps 注入便于测试。 */

export function buildAlertRow(alert, deps) {
  var d = deps || {};
  var selectedIds = d.selectedIds || {};
  var textCell = d.textCell;
  var formatRelative = d.formatRelative;
  var formatStamp = d.formatStamp;
  var statusText = d.statusText || {};

  var tr = document.createElement('tr');
  if (alert.id != null) { tr.setAttribute('data-alert-row', alert.id); }
  tr.setAttribute('data-severity', alert.severity || 'info');
  tr.setAttribute('data-status', alert.status || 'active');

  var checkCell = document.createElement('td');
  checkCell.className = 'check-col';
  if (alert.status === 'active' && alert.id != null) {
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'alert-select';
    checkbox.setAttribute('data-alert-id', alert.id);
    checkbox.checked = Boolean(selectedIds[alert.id]);
    checkCell.appendChild(checkbox);
  }
  tr.appendChild(checkCell);

  var severityCell = document.createElement('td');
  var severity = document.createElement('span');
  severity.className = 'severity severity-' + (alert.severity || 'info');
  severity.textContent = alert.severity || '—';
  severityCell.appendChild(severity);
  tr.appendChild(severityCell);

  var categoryCell = textCell(alert.category);
  categoryCell.classList.add('col-secondary', 'col-category');
  tr.appendChild(categoryCell);

  var hostCell = document.createElement('td');
  hostCell.className = 'mono col-host';
  if (alert.host_name) {
    var hostLink = document.createElement('a');
    hostLink.className = 'host-link';
    hostLink.setAttribute('href', '/host/' + encodeURIComponent(alert.host_name));
    hostLink.textContent = alert.host_name;
    hostCell.appendChild(hostLink);
  } else {
    hostCell.textContent = '—';
  }
  tr.appendChild(hostCell);

  var titleCell = document.createElement('td');
  titleCell.className = 'alert-title';
  titleCell.textContent = alert.title || '—';
  tr.appendChild(titleCell);

  var messageCell = document.createElement('td');
  messageCell.className = 'alert-message col-wide col-message';
  messageCell.textContent = alert.message || '—';
  if (alert.message) {
    messageCell.title = String(alert.message);
    if (String(alert.message).length > 48) { messageCell.classList.add('is-clamped'); }
  }
  tr.appendChild(messageCell);

  var timeCell = textCell(formatRelative(alert.created_at), 'mono alert-time');
  if (alert.created_at) { timeCell.title = formatStamp(alert.created_at); }
  tr.appendChild(timeCell);
  var stateCell = textCell(statusText[alert.status] || alert.status || '—', 'alert-state');
  stateCell.setAttribute('data-state', alert.status || 'active');
  tr.appendChild(stateCell);

  var actionCell = document.createElement('td');
  actionCell.className = 'alert-actions';
  if (alert.status === 'active') {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'ack-btn';
    button.setAttribute('data-alert-id', alert.id);
    button.textContent = '确认';
    actionCell.appendChild(button);
    var silenceButton = document.createElement('button');
    silenceButton.type = 'button';
    silenceButton.className = 'silence-btn';
    silenceButton.setAttribute('data-alert-id', alert.id);
    silenceButton.setAttribute('data-host-name', alert.host_name || '');
    silenceButton.textContent = '静默';
    actionCell.appendChild(silenceButton);
  } else {
    var dash = document.createElement('span');
    dash.className = 'muted';
    dash.textContent = '—';
    actionCell.appendChild(dash);
  }
  tr.appendChild(actionCell);
  return tr;
}
