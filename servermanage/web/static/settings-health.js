/* 系统状态：版本、运行状态、数据库体积、调度任务。纯原生 JS。 */
(function () {
  'use strict';

  function fetchJson(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (response) {
        if (response.status === 401) {
          window.location.assign('/login');
          return null;
        }
        return response.ok ? response.json() : null;
      });
  }

  function formatBytes(value) {
    var num = Number(value || 0);
    if (!num) { return '0 B'; }
    if (num < 1024) { return num + ' B'; }
    if (num < 1024 * 1024) { return (num / 1024).toFixed(1) + ' KB'; }
    if (num < 1024 * 1024 * 1024) { return (num / (1024 * 1024)).toFixed(1) + ' MB'; }
    return (num / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function card(label, value, hint) {
    var div = document.createElement('div');
    div.className = 'health-item';
    var title = document.createElement('span');
    title.className = 'health-label';
    title.textContent = label;
    var main = document.createElement('strong');
    main.className = 'health-value';
    main.textContent = value == null ? '—' : String(value);
    div.appendChild(title);
    div.appendChild(main);
    if (hint) {
      var small = document.createElement('span');
      small.className = 'health-hint';
      small.textContent = hint;
      div.appendChild(small);
    }
    return div;
  }

  function renderDiagnostics(payload) {
    var container = document.getElementById('health-diagnostics');
    if (!container) { return; }
    container.textContent = '';
    var diagnostics = payload && payload.diagnostics;
    if (!diagnostics || !Array.isArray(diagnostics.checks)) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '检查不可用。';
      container.appendChild(empty);
      return;
    }
    diagnostics.checks.forEach(function (check) {
      var row = document.createElement('div');
      row.className = 'check-row';
      var dot = document.createElement('span');
      var state = check.status === 'error' ? 'error'
        : (check.status === 'warning' ? 'warning' : 'ok');
      dot.className = 'check-dot ' + state;
      var label = document.createElement('span');
      label.className = 'check-label';
      label.textContent = check.label || check.key || '';
      var message = document.createElement('span');
      message.className = 'check-message';
      message.textContent = check.message || '';
      row.appendChild(dot);
      row.appendChild(label);
      row.appendChild(message);
      container.appendChild(row);
    });
  }

  function render(payload) {
    renderDiagnostics(payload);
    var summary = document.getElementById('health-summary');
    if (!summary) { return; }
    summary.textContent = '';
    if (!payload) {
      var error = document.createElement('p');
      error.className = 'empty';
      error.textContent = '系统状态读取失败。';
      summary.appendChild(error);
      return;
    }
    summary.appendChild(card('版本', payload.version));
    summary.appendChild(card('运行状态', payload.runtime && payload.runtime.url ? '运行中' : '未运行', payload.runtime && payload.runtime.url ? payload.runtime.url : ''));
    summary.appendChild(card('主机数量', payload.hosts_configured));
    summary.appendChild(card('数据库体积', formatBytes(payload.db_size_bytes), payload.db_path || ''));
    summary.appendChild(card('状态历史行数', payload.history_rows));
    summary.appendChild(card('磁盘批次', payload.disk_batches));
    summary.appendChild(card('活动告警', payload.alerts_active));

    var tbody = document.getElementById('health-tasks-body');
    if (!tbody) { return; }
    tbody.textContent = '';
    var tasks = payload.tasks || [];
    if (!tasks.length) {
      var row = document.createElement('tr');
      var cell = document.createElement('td');
      cell.colSpan = 3;
      cell.className = 'empty';
      cell.textContent = '暂无调度记录';
      row.appendChild(cell);
      tbody.appendChild(row);
      return;
    }
    tasks.forEach(function (task) {
      var row = document.createElement('tr');
      [task.task_name, task.last_run_at, task.last_result].forEach(function (value) {
        var cell = document.createElement('td');
        cell.textContent = value == null || value === '' ? '—' : String(value);
        row.appendChild(cell);
      });
      tbody.appendChild(row);
    });
  }

  function renderStorage(payload) {
    var container = document.getElementById('storage-usage');
    if (!container) { return; }
    container.textContent = '';
    var usage = (payload && payload.usage) || {};
    var rows = [
      ['数据库', usage.database],
      ['日志', usage.logs],
      ['更新包', usage.updates],
      ['界面缓存', usage.electron],
      ['应用总占用', usage.total]
    ];
    rows.forEach(function (pair) {
      container.appendChild(card(pair[0], formatBytes(pair[1]), pair[0] === '应用总占用' ? '' : ''));
    });
  }

  function loadStorage() {
    var button = document.getElementById('storage-refresh-button');
    if (button) { button.disabled = true; }
    fetchJson('/api/system/storage').then(renderStorage).catch(function () {
      var container = document.getElementById('storage-usage');
      if (container) {
        container.textContent = '';
        var error = document.createElement('p');
        error.className = 'empty';
        error.textContent = '磁盘占用读取失败。';
        container.appendChild(error);
      }
    }).then(function () {
      if (button) { button.disabled = false; }
    });
  }

  function runMaintenance(target, button) {
    var status = document.getElementById('maintenance-status');
    var root = document.getElementById('settings-root');
    if (!target || !status) { return; }
    var labels = {
      logs: '正在清理超过 24 小时的日志…',
      updates: '正在清理已下载的更新包…',
      cache: '正在清理界面缓存…',
      database: '正在压缩数据库…'
    };
    if (button) { button.disabled = true; }
    status.textContent = labels[target] || '正在清理…';
    fetch('/api/system/maintenance', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': root ? root.getAttribute('data-csrf') : ''
      },
      body: JSON.stringify({ target: target })
    }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (body) {
        if (!response.ok) {
          throw new Error((body && body.error) || '清理失败');
        }
        return body;
      });
    }).then(function (payload) {
      var result = payload.result || {};
      var freed = result.bytes != null ? formatBytes(result.bytes) : '';
      status.textContent = '完成' + (freed ? '，释放 ' + freed : '') + '。';
      renderStorage(payload);
    }).catch(function (error) {
      status.textContent = error.message || '清理失败，请稍后重试。';
    }).then(function () {
      if (button) { button.disabled = false; }
    });
  }

  function setupStorage() {
    var refresh = document.getElementById('storage-refresh-button');
    if (refresh) { refresh.addEventListener('click', loadStorage); }
    var buttons = document.querySelectorAll('[data-maintenance-target]');
    Array.prototype.forEach.call(buttons, function (button) {
      button.addEventListener('click', function () {
        runMaintenance(button.getAttribute('data-maintenance-target'), button);
      });
    });
    loadStorage();
  }

  function load() {
    var button = document.getElementById('health-refresh-button');
    if (button) { button.disabled = true; }
    fetchJson('/api/system/health').then(render).catch(function () { render(null); }).then(function () {
      if (button) { button.disabled = false; }
    });
  }

  var button = document.getElementById('health-refresh-button');
  if (button) { button.addEventListener('click', load); }
  var tab = document.querySelector('[data-settings-tab="health"]');
  if (tab) {
    tab.addEventListener('click', function () {
      load();
      loadStorage();
    });
  }

  function setupRestore() {
    var fileInput = document.getElementById('restore-file');
    var restoreButton = document.getElementById('restore-button');
    var status = document.getElementById('restore-status');
    if (!fileInput || !restoreButton || !status) { return; }
    restoreButton.addEventListener('click', function () {
      if (!fileInput.files || !fileInput.files.length) {
        status.textContent = '请先选择 .db 备份文件。';
        return;
      }
      if (!window.confirm('恢复会覆盖当前配置和历史数据。当前数据库会先自动备份，确定继续吗？')) {
        return;
      }
      var root = document.getElementById('settings-root');
      var form = new FormData();
      form.append('file', fileInput.files[0]);
      restoreButton.disabled = true;
      status.textContent = '正在恢复…';
      fetch('/api/system/restore', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': root ? root.getAttribute('data-csrf') : '' },
        body: form
      }).then(function (response) {
        return response.json().catch(function () { return null; }).then(function (body) {
          if (!response.ok) {
            throw new Error((body && body.error) || '恢复失败，请检查备份文件。');
          }
          return body;
        });
      }).then(function (payload) {
        status.textContent = payload.message || '恢复完成。';
        if (window.desktopBridge && window.desktopBridge.restartBackend) {
          status.textContent = '恢复完成，正在重启服务…';
          window.desktopBridge.restartBackend().then(function (result) {
            if (!result || result.ok !== true) {
              status.textContent = '数据库已恢复，但服务重启失败，请手动关闭并重新打开工具。';
            }
          }).catch(function () {
            status.textContent = '数据库已恢复，但服务重启失败，请手动关闭并重新打开工具。';
          });
        } else {
          window.alert('数据库已恢复，请关闭并重新打开工具使配置生效。');
        }
      }).catch(function (error) {
        status.textContent = error.message || '恢复失败。';
      }).then(function () {
        restoreButton.disabled = false;
      });
    });
  }
  setupRestore();
  setupStorage();
  load();
})();
