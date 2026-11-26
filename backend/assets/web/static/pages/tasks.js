/**
 * 任务中心 page module: poll `GET /api/system/tasks` every 5 s, render the
 * task table with textContent only (no innerHTML) and trigger a manual run via
 * `POST /api/system/tasks/{name}/run`.
 */
import { fetchJson } from '../lib/api.js';
import { failToast, showToast } from '../lib/ui.js';
import { formatRelative, formatStamp } from '../lib/format.js';

const REFRESH_MS = 5000;
const API_TASKS = '/api/system/tasks';
const TABLE_COLUMNS = 8;

const rowsEl = document.getElementById('task-rows');
const updatedEl = document.getElementById('tasks-updated');
const refreshBtn = document.getElementById('tasks-refresh');

let loading = false;
let pollFailed = false;

/** Human-readable duration for `task_runs.duration_ms`. */
function formatDuration(ms) {
  if (ms === null || ms === undefined) { return '—'; }
  const value = Number(ms);
  if (isNaN(value) || value < 0) { return '—'; }
  if (value < 1000) { return value + ' ms'; }
  if (value < 60000) { return (value / 1000).toFixed(1) + ' 秒'; }
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return minutes + ' 分 ' + seconds + ' 秒';
}

/** Create a `<td>` with text content and an optional class. */
function cell(text, className) {
  const td = document.createElement('td');
  if (className) { td.className = className; }
  td.textContent = text;
  return td;
}

/** Running / idle badge. */
function statusBadge(task) {
  const badge = document.createElement('span');
  badge.className = task.running ? 'badge badge-online' : 'badge';
  badge.textContent = task.running ? '运行中' : '空闲';
  return badge;
}

/** Last-result cell; the full text (often a long error) lives in the tooltip. */
function resultCell(task) {
  const text = task.last_result ? String(task.last_result) : '—';
  const td = cell(text);
  if (task.last_result) { td.title = text; }
  return td;
}

/** Manual trigger button (disabled while the task is running). */
function triggerButton(task) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-secondary';
  button.textContent = task.running ? '运行中…' : '立即运行';
  button.disabled = Boolean(task.running);
  button.addEventListener('click', function () {
    button.disabled = true;
    triggerTask(task.name);
  });
  return button;
}

/** POST the trigger, toast the outcome, then refresh the table. */
function triggerTask(name) {
  const url = '/api/system/tasks/' + encodeURIComponent(name) + '/run';
  fetchJson(url, { method: 'POST' }).then(function (payload) {
    if (!payload) {
      failToast('触发任务失败');
    } else {
      showToast('已触发「' + name + '」', 'ok');
    }
    loadTasks();
  });
}

/** One table row for a task summary. */
function renderRow(task) {
  const tr = document.createElement('tr');
  tr.appendChild(cell(task.name, 'mono'));
  tr.appendChild(cell(task.schedule || '—'));
  tr.appendChild(cell(task.next_run_at ? formatStamp(task.next_run_at) : '—'));
  tr.appendChild(cell(task.last_run_at ? formatRelative(task.last_run_at) : '—'));
  tr.appendChild(resultCell(task));
  const statusTd = document.createElement('td');
  statusTd.appendChild(statusBadge(task));
  tr.appendChild(statusTd);
  tr.appendChild(cell(formatDuration(task.last_duration_ms), 'mono'));
  const actionTd = document.createElement('td');
  actionTd.appendChild(triggerButton(task));
  tr.appendChild(actionTd);
  return tr;
}

/** Replace the table body with the current payload. */
function renderTasks(tasks) {
  if (!rowsEl) { return; }
  if (!tasks.length) {
    const tr = document.createElement('tr');
    const td = cell('暂无已注册的定时任务。', 'empty');
    td.colSpan = TABLE_COLUMNS;
    tr.appendChild(td);
    rowsEl.replaceChildren(tr);
    return;
  }
  const fragment = document.createDocumentFragment();
  tasks.forEach(function (task) {
    fragment.appendChild(renderRow(task));
  });
  rowsEl.replaceChildren(fragment);
}

/** Fetch + render the task list. */
function loadTasks() {
  if (loading) { return Promise.resolve(); }
  loading = true;
  return fetchJson(API_TASKS).then(function (payload) {
    loading = false;
    if (!payload) {
      if (!pollFailed) {
        failToast('加载任务失败');
        pollFailed = true;
      }
      if (updatedEl) { updatedEl.textContent = '刷新失败，稍后重试'; }
      return;
    }
    pollFailed = false;
    renderTasks(payload.tasks || []);
    if (updatedEl) { updatedEl.textContent = '更新于 ' + formatStamp(new Date().toISOString()); }
  });
}

if (refreshBtn) {
  refreshBtn.addEventListener('click', function () {
    loadTasks();
  });
}

loadTasks();
setInterval(loadTasks, REFRESH_MS);