/**
 * Alerts page enhancements (Track C, P1-3).
 *
 * `app.js` owns the alert list rendering, filtering and per-alert ack/silence.
 * This module layers three things on top without touching that monolith:
 *
 *   1. a bulk-action bar (server-side render) that reflects the checkbox
 *      selection and posts `/api/alerts/bulk/silence`;
 *   2. a delivery-failure indicator per alert plus a 「重发失败通道」 button
 *      backed by `GET /api/alerts/delivery-failures` and
 *      `POST /api/alerts/:id/resend`;
 *   3. a MutationObserver so the decorations survive the 30s table rebuild
 *      performed by `buildAlertRow`.
 *
 * No `innerHTML`: every node is built with `createElement`/`textContent`.
 */
import { fetchJson } from '../lib/api.js';
import { failToast, showToast, servermonitorConfirm } from '../lib/ui.js';

const BULK_HOURS_MIN = 1;
const BULK_HOURS_MAX = 720;
const FAILURE_REFRESH_MS = 30000;

/** alert id -> { count, channels: string[] } */
const failuresByAlert = new Map();

function intAttr(node, name) {
  if (!node || typeof node.getAttribute !== 'function') { return null; }
  const raw = node.getAttribute(name);
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Checked alert ids in the current table, in DOM order. */
function selectedAlertIds() {
  const ids = [];
  const nodes = document.querySelectorAll('#alerts-body .alert-select:checked');
  nodes.forEach(function (node) {
    const id = intAttr(node, 'data-alert-id');
    if (id !== null && ids.indexOf(id) === -1) { ids.push(id); }
  });
  return ids;
}

/** Ask app.js to refresh, falling back to a reload outside the dashboard. */
function refreshPage() {
  const actions = window.serverMonitorActions;
  if (actions && typeof actions.refresh === 'function') {
    actions.refresh();
    return;
  }
  window.location.reload();
}

function syncBulkBar() {
  const bar = document.getElementById('alert-bulk-bar');
  const count = document.getElementById('alert-bulk-count');
  const ack = document.getElementById('alert-bulk-ack');
  const silence = document.getElementById('alert-bulk-silence');
  const total = selectedAlertIds().length;
  if (count) { count.textContent = String(total); }
  if (bar) { bar.hidden = total === 0; }
  if (ack) { ack.disabled = total === 0; }
  if (silence) { silence.disabled = total === 0; }
}

/** Rebuilds the per-alert delivery-failure decorations from the cached map. */
function decorateRow(row) {
  const alertId = intAttr(row, 'data-alert-row');
  const actions = row.querySelector('.alert-actions');
  if (alertId === null || !actions) { return; }
  const info = failuresByAlert.get(alertId);
  const existing = actions.querySelector('.delivery-failure');
  if (!info) {
    if (existing) { existing.remove(); }
    return;
  }
  if (existing) {
    const badge = existing.querySelector('.delivery-failure-badge');
    if (badge) { badge.textContent = '通道失败 ' + info.count; }
    existing.setAttribute('title', info.channels.join('、'));
    return;
  }
  const wrap = document.createElement('span');
  wrap.className = 'delivery-failure';
  wrap.setAttribute('title', info.channels.join('、'));
  const badge = document.createElement('span');
  badge.className = 'delivery-failure-badge muted';
  badge.textContent = '通道失败 ' + info.count;
  wrap.appendChild(badge);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'resend-btn btn-link';
  button.setAttribute('data-alert-id', String(alertId));
  button.textContent = '重发失败通道';
  wrap.appendChild(button);
  actions.appendChild(wrap);
}

function decorateAll() {
  const rows = document.querySelectorAll('#alerts-body tr[data-alert-row]');
  rows.forEach(decorateRow);
}

/** Fetches the failure ledger and repaints indicators. */
function loadFailures() {
  return fetchJson('/api/alerts/delivery-failures').then(function (data) {
    failuresByAlert.clear();
    if (data && Array.isArray(data.failures)) {
      data.failures.forEach(function (failure) {
        const alertId = Number(failure.alertId);
        if (!Number.isInteger(alertId) || alertId <= 0) { return; }
        let info = failuresByAlert.get(alertId);
        if (!info) {
          info = { count: 0, channels: [] };
          failuresByAlert.set(alertId, info);
        }
        info.count += 1;
        if (failure.channel && info.channels.indexOf(failure.channel) === -1) {
          info.channels.push(failure.channel);
        }
      });
    }
    decorateAll();
  }).catch(function () {
    // Failure visibility is best-effort; never break the page.
  });
}

function bulkSilence(button) {
  const ids = selectedAlertIds();
  if (ids.length === 0) { return; }
  const input = document.getElementById('alert-bulk-hours');
  const hours = input ? Number(input.value) : NaN;
  if (!Number.isInteger(hours) || hours < BULK_HOURS_MIN || hours > BULK_HOURS_MAX) {
    showToast('静默时长需为 ' + BULK_HOURS_MIN + '-' + BULK_HOURS_MAX + ' 小时', 'error');
    return;
  }
  servermonitorConfirm({
    message: '确认静默所选 ' + ids.length + ' 条告警对应主机 ' + hours + ' 小时？',
    confirmLabel: '开始静默',
  }).then(function (ok) {
    if (!ok) { return; }
    button.disabled = true;
    return fetchJson('/api/alerts/bulk/silence', {
      method: 'POST',
      body: JSON.stringify({ ids: ids, hours: hours }),
    }).then(function (data) {
      button.disabled = false;
      if (!data || data.ok !== true) {
        failToast('批量静默失败');
        return;
      }
      showToast('已静默 ' + String(data.silenced || ids.length) + ' 条告警', 'success');
      refreshPage();
    }).catch(function () {
      button.disabled = false;
      failToast('批量静默失败');
    });
  });
}

function resendAlert(alertId) {
  fetchJson('/api/alerts/' + String(alertId) + '/resend', {
    method: 'POST',
    body: JSON.stringify({}),
  }).then(function (data) {
    if (!data || data.ok !== true) {
      failToast('重发失败');
      return;
    }
    const resent = Array.isArray(data.resent) ? data.resent : [];
    if (resent.length === 0) {
      showToast('没有失败的通道需要重发', 'info');
    } else {
      showToast('已重发：' + resent.join('、'), 'success');
    }
    return loadFailures().then(refreshPage);
  }).catch(function () {
    failToast('重发失败');
  });
}

function bind() {
  const silenceButton = document.getElementById('alert-bulk-silence');
  if (silenceButton) {
    silenceButton.addEventListener('click', function () { bulkSilence(silenceButton); });
  }

  // Selection changes (individual checkboxes fire `change`, select-all is
  // managed by app.js; re-sync on the next tick to observe its writes).
  document.addEventListener('change', function (event) {
    const target = event.target;
    if (target && target.classList && target.classList.contains('alert-select')) {
      syncBulkBar();
    }
  });
  const selectAll = document.getElementById('alert-select-all');
  if (selectAll) {
    selectAll.addEventListener('click', function () {
      window.setTimeout(syncBulkBar, 0);
    });
  }

  // Resend delegation (rows are rebuilt by app.js, so bind on the document).
  document.addEventListener('click', function (event) {
    const target = event.target;
    if (target && target.classList && target.classList.contains('resend-btn')) {
      const alertId = intAttr(target, 'data-alert-id');
      if (alertId !== null) { resendAlert(alertId); }
    }
  });

  const tbody = document.getElementById('alerts-body');
  if (tbody && typeof MutationObserver === 'function') {
    const observer = new MutationObserver(function () {
      syncBulkBar();
      decorateAll();
    });
    observer.observe(tbody, { childList: true, subtree: true });
  }

  syncBulkBar();
  loadFailures();
  window.setInterval(loadFailures, FAILURE_REFRESH_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bind);
} else {
  bind();
}
