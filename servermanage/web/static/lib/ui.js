/* Shared UI primitives: toasts and themed dialogs (M2: extracted from app.js).
 * No page state; every function only touches the DOM. */

import { fetchJson } from './api.js';

export function showToast(message, kind) {
  var container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  var toast = document.createElement('div');
  toast.className = 'toast toast-' + (kind || 'info');
  toast.textContent = String(message || '');
  container.appendChild(toast);
  window.setTimeout(function () {
    toast.classList.add('toast-out');
    window.setTimeout(function () {
      if (toast.parentNode) { toast.parentNode.removeChild(toast); }
    }, 220);
  }, 2600);
}

export function failToast(prefix, kind) {
  var detail = fetchJson.lastError;
  showToast(detail ? prefix + '：' + detail : prefix + '，请重试', kind || 'error');
}

export function servermonitorConfirm(options) {
  var opts = options || {};
  return new Promise(function (resolve) {
    var dialog = document.createElement('dialog');
    dialog.className = 'confirm-dialog';
    var text = document.createElement('p');
    text.className = 'confirm-dialog-text';
    text.textContent = String(opts.message || '确定继续吗？');
    var foot = document.createElement('div');
    foot.className = 'user-confirm-foot';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary-button';
    cancel.textContent = opts.cancelLabel || '取消';
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.className = opts.danger ? 'danger-button' : 'primary-button';
    ok.textContent = opts.confirmLabel || '确定';
    foot.appendChild(cancel);
    foot.appendChild(ok);
    dialog.appendChild(text);
    dialog.appendChild(foot);
    document.body.appendChild(dialog);
    var finished = false;
    function finish(result) {
      if (finished) { return; }
      finished = true;
      if (dialog.parentNode) { dialog.parentNode.removeChild(dialog); }
      resolve(result);
    }
    ok.addEventListener('click', function () { finish(true); });
    cancel.addEventListener('click', function () { finish(false); });
    dialog.addEventListener('cancel', function () { finish(false); });
    dialog.addEventListener('close', function () { finish(false); });
    try {
      if (typeof dialog.showModal === 'function') { dialog.showModal(); }
      else { dialog.setAttribute('open', ''); }
    } catch (err) {
      finish(false);
      return;
    }
    if (ok.focus) { ok.focus(); }
  });
}

export function servermonitorPrompt(options) {
  var opts = options || {};
  return new Promise(function (resolve) {
    var dialog = document.createElement('dialog');
    dialog.className = 'confirm-dialog';
    var text = document.createElement('p');
    text.className = 'confirm-dialog-text';
    text.textContent = String(opts.message || '请输入：');
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'confirm-dialog-input';
    input.value = String(opts.value || '');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    var foot = document.createElement('div');
    foot.className = 'user-confirm-foot';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary-button';
    cancel.textContent = opts.cancelLabel || '取消';
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'primary-button';
    ok.textContent = opts.confirmLabel || '确定';
    foot.appendChild(cancel);
    foot.appendChild(ok);
    dialog.appendChild(text);
    dialog.appendChild(input);
    dialog.appendChild(foot);
    document.body.appendChild(dialog);
    var finished = false;
    function finish(result) {
      if (finished) { return; }
      finished = true;
      if (dialog.parentNode) { dialog.parentNode.removeChild(dialog); }
      resolve(result);
    }
    function submit() {
      var value = input.value.trim();
      finish(value || null);
    }
    ok.addEventListener('click', submit);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); submit(); }
    });
    cancel.addEventListener('click', function () { finish(null); });
    dialog.addEventListener('cancel', function () { finish(null); });
    dialog.addEventListener('close', function () { finish(null); });
    try {
      if (typeof dialog.showModal === 'function') { dialog.showModal(); }
      else { dialog.setAttribute('open', ''); }
    } catch (err) {
      finish(null);
      return;
    }
    input.focus();
    input.select();
  });
}
