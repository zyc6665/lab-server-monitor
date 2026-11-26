/**
 * 报表页：预览（sandbox iframe + 纯文本）/ 立即发送 / 发送历史。
 * 全部使用 createElement + textContent，禁止 innerHTML 注入报表内容。
 */
import { fetchJson } from '../lib/api.js';
import { failToast, showToast } from '../lib/ui.js';

const API_PREVIEW = '/api/reports/preview';
const API_HISTORY = '/api/reports/history';
const API_SEND = '/api/reports/send';

const variantEl = document.getElementById('report-variant');
const previewBtn = document.getElementById('report-preview-btn');
const sendBtn = document.getElementById('report-send-btn');
const statusEl = document.getElementById('report-status');
const previewBody = document.getElementById('report-preview-body');
const historyRows = document.getElementById('report-history-rows');
const historyUpdated = document.getElementById('report-history-updated');
const historyRefresh = document.getElementById('report-history-refresh');

const VARIANT_LABELS = { technical: '日报（技术版）', executive: '日报（管理层版）', weekly: '周报' };

function setStatus(text) {
  if (statusEl) { statusEl.textContent = text || ''; }
}

function renderPreview(payload) {
  if (!previewBody) { return; }
  previewBody.replaceChildren();

  const subject = document.createElement('h3');
  subject.className = 'report-preview-subject';
  subject.textContent = payload.subject || '(无主题)';
  previewBody.appendChild(subject);

  const frame = document.createElement('iframe');
  frame.className = 'report-preview-frame';
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('title', '报表预览');
  frame.srcdoc = payload.html || '';
  previewBody.appendChild(frame);

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = '纯文本版本';
  details.appendChild(summary);
  const pre = document.createElement('pre');
  pre.className = 'report-preview-text';
  pre.textContent = payload.text || '';
  details.appendChild(pre);
  previewBody.appendChild(details);
}

async function loadPreview() {
  const variant = variantEl ? variantEl.value : 'technical';
  setStatus('生成中…');
  previewBtn.disabled = true;
  try {
    const data = await fetchJson(API_PREVIEW + '?variant=' + encodeURIComponent(variant));
    if (!data) { throw new Error(fetchJson.lastError || '预览失败'); }
    renderPreview(data);
    setStatus('已生成预览');
  } catch (err) {
    setStatus('');
    failToast('报表预览失败：' + (err && err.message ? err.message : '未知错误'));
  } finally {
    previewBtn.disabled = false;
  }
}

async function sendReport() {
  const variant = variantEl ? variantEl.value : 'technical';
  setStatus('发送中…');
  sendBtn.disabled = true;
  try {
    const res = await fetchJson(API_SEND, { method: 'POST', body: JSON.stringify({ variant }) });
    if (!res || res.ok !== true) { throw new Error(fetchJson.lastError || '发送失败'); }
    showToast('已发送' + (VARIANT_LABELS[variant] || '报表'));
    setStatus('已发送');
    loadHistory();
  } catch (err) {
    setStatus('');
    failToast('发送失败：' + (err && err.message ? err.message : '未知错误'));
  } finally {
    sendBtn.disabled = false;
  }
}

function cell(text, className) {
  const td = document.createElement('td');
  if (className) { td.className = className; }
  td.textContent = text == null || text === '' ? '—' : String(text);
  return td;
}

function renderHistory(runs) {
  if (!historyRows) { return; }
  historyRows.replaceChildren();
  if (!Array.isArray(runs) || runs.length === 0) {
    const tr = document.createElement('tr');
    const td = cell('暂无发送记录', 'empty');
    td.colSpan = 6;
    tr.appendChild(td);
    historyRows.appendChild(tr);
    return;
  }
  for (const run of runs) {
    const tr = document.createElement('tr');
    tr.appendChild(cell(run.created_at));
    tr.appendChild(cell(run.kind));
    tr.appendChild(cell(VARIANT_LABELS[run.variant] || run.variant));
    const statusCell = cell(run.status === 'sent' ? '成功' : '失败');
    if (run.status !== 'sent') { statusCell.className = 'text-danger'; }
    tr.appendChild(statusCell);
    tr.appendChild(cell(run.recipients));
    tr.appendChild(cell(run.error));
    historyRows.appendChild(tr);
  }
}

async function loadHistory() {
  try {
    const data = await fetchJson(API_HISTORY);
    renderHistory(data.runs);
    if (historyUpdated) {
      historyUpdated.textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    }
  } catch (err) {
    if (historyUpdated) { historyUpdated.textContent = '加载失败'; }
  }
}

if (previewBtn) { previewBtn.addEventListener('click', loadPreview); }
if (sendBtn) { sendBtn.addEventListener('click', sendReport); }
if (historyRefresh) { historyRefresh.addEventListener('click', loadHistory); }
if (variantEl) {
  variantEl.addEventListener('change', function () {
    setStatus('');
    if (previewBody) {
      previewBody.replaceChildren();
      const hint = document.createElement('p');
      hint.className = 'muted';
      hint.textContent = '点击「预览」生成报表内容。';
      previewBody.appendChild(hint);
    }
  });
}

loadHistory();
