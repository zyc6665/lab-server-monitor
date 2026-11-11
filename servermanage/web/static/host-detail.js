/* 主机详情：诊断、立即采集、历史趋势。
 * 纯原生 JS，无第三方依赖；所有文本使用 textContent，绝不拼接 HTML。 */
(function () {
  'use strict';

  var HOST_NAME = window.__HOST_NAME__ || '';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  // {check_name: [oldest…newest status]}，由 /api/host/<name> 返回。
  var checkHistory = {};
  var COLORS = {
    cpu: '#2563eb',
    memory: '#7c3aed',
    disk: '#059669',
    gpu_memory: '#d97706',
    temperature: '#e11d48',
    net_rx: '#0891b2'
  };
  var TITLES = {
    cpu: 'CPU',
    memory: '内存',
    disk: '磁盘',
    gpu_memory: 'GPU 显存',
    temperature: '温度',
    net_rx: '网络下行'
  };

  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? (meta.getAttribute('content') || '') : '';
  }

  function fetchJson(url, options) {
    var opts = options || {};
    var method = (opts.method || 'GET').toUpperCase();
    var headers = { Accept: 'application/json' };
    if (method !== 'GET' && method !== 'HEAD') {
      var token = csrfToken();
      if (token) { headers['X-CSRF-Token'] = token; }
    }
    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: headers
    }).then(function (response) {
      if (response.status === 401) {
        window.location.assign('/login');
        return null;
      }
      if (!response.ok) { return null; }
      return response.json();
    });
  }

  function setStatus(text) {
    var el = document.getElementById('host-action-status');
    if (el) { el.textContent = text || ''; }
  }

  function fmt(value) {
    if (value === null || value === undefined || value === '') { return '—'; }
    var num = Number(value);
    return isNaN(num) ? '—' : num.toFixed(1) + '%';
  }

  // 与服务端 `stamp` 过滤器保持一致：MM-DD HH:MM，原始值放 title。
  function stamp(value) {
    if (!value) { return '—'; }
    var date = new Date(String(value));
    if (isNaN(date.getTime())) { return String(value); }
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function makeSvgEl(name, attrs) {
    var el = document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach(function (key) {
      el.setAttribute(key, attrs[key]);
    });
    return el;
  }

  function formatRate(bytesPerSecond) {
    var num = Number(bytesPerSecond);
    if (isNaN(num) || num < 0) { return '—'; }
    var units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    var index = 0;
    while (num >= 1024 && index < units.length - 1) {
      num = num / 1024;
      index += 1;
    }
    var digits = index === 0 ? 0 : (num >= 100 ? 0 : 1);
    return num.toFixed(digits) + ' ' + units[index];
  }

  function trendText(value, key) {
    if (value === null || value === undefined || value === '') { return '—'; }
    var num = Number(value);
    if (isNaN(num)) { return '—'; }
    if (key === 'temperature') { return num.toFixed(1) + ' °C'; }
    if (key === 'net_rx') { return formatRate(num); }
    return fmt(num);
  }

  function drawTrend(svg, values, key) {
    if (!svg) { return; }
    while (svg.firstChild) { svg.removeChild(svg.firstChild); }
    var numbers = values.filter(function (v) { return v !== null && v !== undefined && !isNaN(Number(v)); }).map(Number);
    var latest = document.querySelector('[data-trend-latest="' + key + '"]');
    if (latest) { latest.textContent = numbers.length ? trendText(numbers[numbers.length - 1], key) : ''; }
    if (numbers.length < 2) { return; }
    var width = 300, height = 84, padX = 8, padY = 8;
    var min = Math.min.apply(null, numbers);
    var max = Math.max.apply(null, numbers);
    if (max - min < 1) { max = min + 1; }
    var points = [];
    values.forEach(function (value, index) {
      if (value === null || value === undefined || isNaN(Number(value))) { return; }
      var x = padX + (width - padX * 2) * (index / Math.max(1, values.length - 1));
      var y = height - padY - (height - padY * 2) * ((Number(value) - min) / (max - min));
      points.push([x, y]);
    });
    // horizontal guide lines
    [0, 0.5, 1].forEach(function (fraction) {
      var y = padY + (height - padY * 2) * fraction;
      svg.appendChild(makeSvgEl('line', {
        x1: padX, x2: width - padX, y1: y, y2: y,
        stroke: '#e8edf5', 'stroke-width': '1'
      }));
    });
    var d = points.map(function (point, index) {
      return (index ? 'L' : 'M') + point[0].toFixed(1) + ' ' + point[1].toFixed(1);
    }).join(' ');
    svg.appendChild(makeSvgEl('path', {
      d: d, fill: 'none', stroke: COLORS[key], 'stroke-width': '2',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    }));
    var last = points[points.length - 1];
    svg.appendChild(makeSvgEl('circle', {
      cx: last[0], cy: last[1], r: '2.8', fill: COLORS[key]
    }));
    svg.appendChild(makeSvgEl('text', {
      x: padX, y: 12, fill: '#8a94a6', 'font-size': '9'
    })).textContent = '最低 ' + trendText(min, key) + ' · 最高 ' + trendText(max, key);
  }

  function loadHistory(rangeKey) {
    var url = '/api/host/' + encodeURIComponent(HOST_NAME) + '/history?range=' + encodeURIComponent(rangeKey);
    fetchJson(url).then(function (payload) {
      var points = (payload && payload.points) || [];
      var empty = document.getElementById('trend-empty');
      if (empty) { empty.hidden = points.length > 0; }
      Object.keys(TITLES).forEach(function (key) {
        var svg = document.querySelector('[data-trend="' + key + '"]');
        var values = points.map(function (point) { return point[key]; });
        drawTrend(svg, values, key);
      });
    }).catch(function () {
      var empty = document.getElementById('trend-empty');
      if (empty) {
        empty.hidden = false;
        empty.textContent = '趋势数据加载失败。';
      }
    });
  }

  function bindRanges() {
    var tabs = document.querySelectorAll('[data-history-range]');
    Array.prototype.forEach.call(tabs, function (tab) {
      tab.addEventListener('click', function () {
        Array.prototype.forEach.call(tabs, function (other) { other.classList.remove('active'); });
        tab.classList.add('active');
        loadHistory(tab.getAttribute('data-history-range'));
      });
    });
  }

  function showProbe(payload) {
    var box = document.getElementById('host-probe-result');
    if (!box) { return; }
    box.hidden = false;
    box.textContent = '';
    if (!payload) {
      box.textContent = '连接测试失败：服务返回异常。';
      return;
    }
    var lines = [];
    lines.push(payload.ok ? '连接成功' : ('连接失败：' + (payload.message || '未知原因')));
    if (payload.hostname) { lines.push('主机名：' + payload.hostname); }
    if (payload.os_release) { lines.push('系统：' + payload.os_release); }
    if (payload.cpu_cores) { lines.push('CPU 核心：' + payload.cpu_cores); }
    if (payload.memory_total_mb) { lines.push('内存：' + payload.memory_total_mb + ' MB'); }
    if (payload.storcli_available !== undefined) {
      lines.push('storcli：' + (payload.storcli_available ? '可用' : '不可用'));
    }
    if (payload.sudo_available !== undefined) {
      lines.push('免密 sudo：' + (payload.sudo_available ? '可用' : '不可用'));
    }
    (payload.warnings || []).forEach(function (warning) { lines.push('提示：' + warning); });
    lines.forEach(function (line) {
      var div = document.createElement('div');
      div.textContent = line;
      box.appendChild(div);
    });
  }

  function pollCollection() {
    var deadline = Date.now() + 60000;
    var url = '/api/settings/hosts/collection-status?names=' + encodeURIComponent(HOST_NAME);
    function tick() {
      fetchJson(url).then(function (payload) {
        var status = payload && payload.statuses && payload.statuses[HOST_NAME];
        if (status && status.state === 'done') {
          setStatus('采集完成，正在刷新…');
          window.location.reload();
          return;
        }
        if (status && status.state === 'error') {
          setStatus('采集失败：' + (status.error || '未知错误'));
          return;
        }
        if (Date.now() < deadline) {
          setStatus('采集中…');
          window.setTimeout(tick, 1000);
        } else {
          setStatus('采集任务已提交，请稍后刷新查看。');
        }
      }).catch(function () { setStatus('无法获取采集状态。'); });
    }
    tick();
  }

  function bindActions() {
    var testButton = document.getElementById('host-test-button');
    if (testButton) {
      testButton.addEventListener('click', function () {
        setStatus('正在测试连接…');
        testButton.disabled = true;
        fetchJson('/api/settings/hosts/' + encodeURIComponent(HOST_NAME) + '/probe', { method: 'POST' })
          .then(function (payload) { showProbe(payload); setStatus(''); })
          .catch(function () { showProbe(null); setStatus('测试连接失败。'); })
          .then(function () { testButton.disabled = false; });
      });
    }
    var collectButton = document.getElementById('host-collect-button');
    if (collectButton) {
      collectButton.addEventListener('click', function () {
        setStatus('正在提交采集任务…');
        collectButton.disabled = true;
        fetchJson('/api/settings/hosts/' + encodeURIComponent(HOST_NAME) + '/collect', { method: 'POST' })
          .then(function (payload) {
            if (payload && payload.ok) { pollCollection(); }
            else { setStatus('采集任务提交失败。'); }
          })
          .catch(function () { setStatus('采集任务提交失败。'); })
          .then(function () { collectButton.disabled = false; });
      });
    }
  }

  function bindAlertAcks() {
    var buttons = document.querySelectorAll('#host-alerts .ack-btn');
    Array.prototype.forEach.call(buttons, function (button) {
      button.addEventListener('click', function () {
        var alertId = button.getAttribute('data-alert-id');
        if (!alertId) { return; }
        button.disabled = true;
        fetchJson('/api/alerts/' + encodeURIComponent(alertId) + '/ack', { method: 'POST' })
          .then(function (payload) {
            if (!payload || !payload.ok) {
              setStatus('告警确认失败');
              button.disabled = false;
              return;
            }
            var row = button.closest('tr');
            if (row) {
              var status = row.querySelector('.alert-status');
              if (status) {
                status.textContent = '已确认';
                status.classList.remove('status-active');
                status.classList.add('status-acknowledged');
              }
              var actions = row.querySelector('.alert-actions');
              if (actions) {
                while (actions.firstChild) { actions.removeChild(actions.firstChild); }
                var placeholder = document.createElement('span');
                placeholder.className = 'muted';
                placeholder.textContent = '—';
                actions.appendChild(placeholder);
              }
            }
            var remaining = document.querySelectorAll('#host-alerts .status-active').length;
            var tab = document.querySelector('[data-host-tab="alerts"]');
            if (tab) { tab.textContent = '最近告警' + (remaining ? ' (' + remaining + ')' : ''); }
            setStatus('告警已确认');
          })
          .catch(function () {
            setStatus('告警确认失败');
            button.disabled = false;
          });
      });
    });
  }

  function fmtLatency(value) {
    if (value === null || value === undefined || value === '') { return '—'; }
    var num = Number(value);
    return isNaN(num) ? '—' : num.toFixed(0) + ' ms';
  }

  function checkText(value) {
    return (value === null || value === undefined || value === '') ? '—' : String(value);
  }

  function appendCheckCell(tr, text, extraClass) {
    var td = document.createElement('td');
    if (extraClass) { td.className = extraClass; }
    td.textContent = text;
    tr.appendChild(td);
    return td;
  }

  function buildHeartbeat(statuses) {
    var list = statuses || [];
    if (!list.length) {
      var none = document.createElement('span');
      none.className = 'muted';
      none.textContent = '—';
      return none;
    }
    var wrap = document.createElement('span');
    wrap.className = 'heartbeat';
    wrap.title = '最近 ' + list.length + ' 次检查';
    list.forEach(function (status) {
      var beat = document.createElement('i');
      beat.className = 'hb hb-' + String(status || 'unknown');
      wrap.appendChild(beat);
    });
    return wrap;
  }

  function renderChecksTable(checks) {
    var body = document.getElementById('host-checks-body');
    if (!body) { return; }
    var list = checks || [];
    while (body.firstChild) { body.removeChild(body.firstChild); }
    var empty = document.getElementById('host-checks-empty');
    var wrap = document.getElementById('host-checks-wrap');
    if (wrap) { wrap.hidden = list.length === 0; }
    if (empty) { empty.hidden = list.length > 0; }
    list.forEach(function (check) {
      var tr = document.createElement('tr');
      appendCheckCell(tr, checkText(check.check_name));
      appendCheckCell(tr, checkText(check.check_type));
      appendCheckCell(tr, checkText(check.target), 'mono');
      var statusCell = document.createElement('td');
      var status = document.createElement('span');
      status.className = 'status status-' + (check.status || 'unknown');
      status.textContent = checkText(check.status);
      statusCell.appendChild(status);
      tr.appendChild(statusCell);
      var beatCell = document.createElement('td');
      beatCell.className = 'heartbeat-cell';
      beatCell.appendChild(buildHeartbeat(checkHistory[check.check_name]));
      tr.appendChild(beatCell);
      appendCheckCell(tr, fmtLatency(check.latency_ms));
      var stampCell = appendCheckCell(tr, stamp(check.checked_at), 'mono');
      if (check.checked_at) { stampCell.title = String(check.checked_at); }
      appendCheckCell(tr, checkText(check.message));
      body.appendChild(tr);
    });
  }

  function loadChecks() {
    fetchJson('/api/host/' + encodeURIComponent(HOST_NAME)).then(function (payload) {
      if (!payload) { return; }
      checkHistory = payload.check_history || {};
      if (payload.checks) {
        renderChecksTable(payload.checks);
      }
    }).catch(function () {});
  }

  function bindHostTabs() {
    var tabs = document.querySelectorAll('[data-host-tab]');
    var panels = document.querySelectorAll('[data-host-panel]');
    if (!tabs.length || !panels.length) { return; }
    var list = Array.prototype.slice.call(tabs);
    function activate(key, focus) {
      var index = 0;
      list.forEach(function (tab, position) {
        var active = tab.getAttribute('data-host-tab') === key;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.setAttribute('tabindex', active ? '0' : '-1');
        if (active) { index = position; }
      });
      Array.prototype.forEach.call(panels, function (panel) {
        panel.hidden = panel.getAttribute('data-host-panel') !== key;
      });
      if (focus && list[index]) { list[index].focus(); }
      // 窄屏时标签条是横向滚动的，把当前分区滚到可见范围中间。
      var bar = list[index] ? list[index].parentNode : null;
      if (bar && list[index] && bar.scrollWidth > bar.clientWidth + 4) {
        list[index].scrollIntoView({ block: 'nearest', inline: 'center' });
      }
    }
    function currentKey() {
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].classList.contains('active')) { return list[i].getAttribute('data-host-tab'); }
      }
      return 'overview';
    }
    function step(delta) {
      var key = currentKey();
      var index = 0;
      list.forEach(function (tab, position) {
        if (tab.getAttribute('data-host-tab') === key) { index = position; }
      });
      var next = (index + delta + list.length) % list.length;
      var target = list[next].getAttribute('data-host-tab') || 'overview';
      activate(target, true);
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', '#tab-' + target);
      }
    }
    list.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var key = tab.getAttribute('data-host-tab') || 'overview';
        activate(key, false);
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', '#tab-' + key);
        }
      });
      tab.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
        else if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
        else if (event.key === 'Home') { event.preventDefault(); activate(list[0].getAttribute('data-host-tab') || 'overview', true); }
        else if (event.key === 'End') { event.preventDefault(); activate(list[list.length - 1].getAttribute('data-host-tab') || 'overview', true); }
      });
    });
    // 别的页面用元素 id 直接跳进来（例如磁盘健康页的 #disk-array），
    // 这时先切到该元素所在的分区，再把元素滚到视口顶部。
    var HASH_PANELS = { 'disk-array': 'storage', 'host-users': 'sessions' };
    function fromHash() {
      var raw = (window.location.hash || '').replace('#', '');
      var key = raw.replace(/^tab-/, '');
      var elementId = '';
      var known = false;
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].getAttribute('data-host-tab') === key) { known = true; break; }
      }
      if (HASH_PANELS[key]) {
        elementId = key;
        key = HASH_PANELS[key];
      } else if (key && !known) {
        elementId = key;
        key = 'overview';
      }
      activate(key || 'overview', false);
      if (elementId) {
        var element = document.getElementById(elementId);
        if (element) { element.scrollIntoView({ block: 'start' }); }
      }
    }
    window.addEventListener('hashchange', fromHash);
    fromHash();
  }

  function diagSummaryText() {
    var card = document.getElementById('host-diagnostics');
    if (!card) return '';
    var hostName = card.getAttribute('data-host-name') || '';
    var lines = ['主机健康诊断 · ' + hostName + ' · ' + stamp(new Date().toISOString())];
    var items = card.querySelectorAll('.diag-item');
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      var level = item.classList.contains('diag-crit')
        ? '严重'
        : item.classList.contains('diag-warn')
          ? '需关注'
          : '正常';
      var titleEl = item.querySelector('strong');
      var detailEl = item.querySelector('.diag-detail');
      var hintEl = item.querySelector('.diag-hint');
      var line = '- [' + level + '] ' + (titleEl ? titleEl.textContent : '')
        + '：' + (detailEl ? detailEl.textContent : '');
      if (hintEl && level !== '正常') {
        line += '（建议：' + hintEl.textContent + '）';
      }
      lines.push(line);
    }
    return lines.join('\n');
  }

  function bindDiagCopy() {
    var button = document.getElementById('host-diag-copy');
    if (!button) return;
    button.addEventListener('click', function () {
      var text = diagSummaryText();
      if (!text) return;
      var done = function () {
        var original = button.textContent;
        button.textContent = '已复制';
        setTimeout(function () { button.textContent = original; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        var area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        try { document.execCommand('copy'); } catch (err) { /* ignore */ }
        document.body.removeChild(area);
        done();
      }
    });
  }

  function bindCollectNow() {
    var button = document.getElementById('host-collect-now');
    var notice = document.getElementById('host-collect-notice');
    if (!button || !notice) { return; }
    var detailEl = document.getElementById('host-collect-detail');
    var titleEl = document.getElementById('host-collect-title');
    var original = button.textContent;
    var timer = null;

    function stop(status, message, failed) {
      if (timer) { window.clearInterval(timer); timer = null; }
      button.disabled = false;
      button.textContent = original;
      if (titleEl) { titleEl.textContent = failed ? '采集失败' : '采集完成'; }
      if (detailEl && message) { detailEl.textContent = message; }
      if (!failed) { window.setTimeout(function () { window.location.reload(); }, 900); }
    }

    function poll() {
      fetchJson('/api/settings/hosts/collection-status?names=' + encodeURIComponent(HOST_NAME))
        .then(function (payload) {
          var entry = (payload && payload.statuses && payload.statuses[HOST_NAME]) || {};
          var state = entry.state || 'unknown';
          if (state === 'done') { stop('done', '采集完成，正在刷新页面…', false); }
          else if (state === 'error') { stop('error', entry.message || '采集失败，请检查 SSH 与 sudo 设置。', true); }
        })
        .catch(function () { /* 单次轮询失败继续等下一次 */ });
    }

    button.addEventListener('click', function () {
      button.disabled = true;
      button.textContent = '采集中…';
      if (titleEl) { titleEl.textContent = '正在重新采集'; }
      if (detailEl) { detailEl.textContent = '正在通过 SSH 读取这台主机的指标，通常需要几秒钟。'; }
      fetchJson('/api/settings/hosts/' + encodeURIComponent(HOST_NAME) + '/collect', { method: 'POST' })
        .then(function () {
          if (timer) { window.clearInterval(timer); }
          timer = window.setInterval(poll, 1500);
          poll();
        })
        .catch(function (error) {
          stop('error', error.message, true);
        });
    });
  }


  function fmtPercent(value) {
    return value === null || value === undefined ? '—' : value.toFixed(1) + '%';
  }

  function bindChecksRun() {
    var button = document.getElementById('host-checks-run');
    var hint = document.getElementById('host-checks-hint');
    if (!button) { return; }
    button.addEventListener('click', function () {
      if (button.disabled) { return; }
      var label = button.textContent;
      button.disabled = true;
      button.textContent = '检查中…';
      if (hint) { hint.hidden = true; }
      var request = HOST_NAME
        ? fetchJson('/api/host/' + encodeURIComponent(HOST_NAME) + '/checks/run', { method: 'POST' })
        : Promise.reject(new Error('缺少主机信息'));
      request
        .then(function (payload) {
          if (!payload || !payload.ok) {
            throw new Error((payload && payload.error) || '检查失败');
          }
          var rows = payload.checks || [];
          var bad = rows.filter(function (row) { return row.status !== 'ok'; }).length;
          if (hint) {
            hint.hidden = false;
            hint.textContent = bad
              ? '已检查 ' + rows.length + ' 项，' + bad + ' 项异常'
              : '已检查 ' + rows.length + ' 项，全部正常';
            hint.className = 'checks-hint' + (bad ? ' is-warn' : '');
          }
          loadChecks();
        })
        .catch(function (error) {
          if (hint) {
            hint.hidden = false;
            hint.textContent = '检查失败：' + error.message;
            hint.className = 'checks-hint is-error';
          }
        })
        .then(function () {
          button.disabled = false;
          button.textContent = label;
        });
    });
  }

  function usageValue(row, selector) {
    var cell = row.querySelector(selector);
    if (!cell) { return -1; }
    var text = (cell.textContent || '').replace('%', '').trim();
    var num = Number(text);
    return isNaN(num) ? -1 : num;
  }

  function sortContainerRowsByUsage() {
    var body = document.getElementById('container-rows');
    if (!body) { return; }
    var rows = Array.prototype.slice.call(body.querySelectorAll('[data-container-row]'));
    if (rows.length < 2) { return; }
    rows.sort(function (a, b) {
      var diff = usageValue(b, '.container-cpu') - usageValue(a, '.container-cpu');
      if (diff) { return diff; }
      return usageValue(b, '.container-mem') - usageValue(a, '.container-mem');
    });
    rows.forEach(function (row) { body.appendChild(row); });
  }

  function bindContainerStats() {
    var button = document.getElementById('container-stats');
    var hint = document.getElementById('container-stats-hint');
    if (!button) { return; }
    button.addEventListener('click', function () {
      var label = button.textContent;
      button.disabled = true;
      button.textContent = '读取中…';
      if (hint) { hint.hidden = true; }
      var request = HOST_NAME
        ? fetchJson('/api/host/' + encodeURIComponent(HOST_NAME) + '/containers/stats', { method: 'POST' })
        : Promise.reject(new Error('缺少主机信息'));
      request
        .then(function (payload) {
          if (!payload || !payload.ok) {
            throw new Error((payload && payload.error) || '读取失败');
          }
          var stats = {};
          (payload.containers || []).forEach(function (row) { stats[row.name] = row; });
          Array.prototype.forEach.call(document.querySelectorAll('[data-container-row]'), function (row) {
            var name = row.querySelector('.container-cpu');
            var data = name ? stats[name.getAttribute('data-container-name')] : null;
            var cpuCell = row.querySelector('.container-cpu');
            var memCell = row.querySelector('.container-mem');
            if (!data) {
              if (cpuCell) { cpuCell.textContent = '—'; }
              if (memCell) { memCell.textContent = '—'; }
              return;
            }
            if (cpuCell) { cpuCell.textContent = fmtPercent(data.cpu_percent); }
            if (memCell) {
              memCell.textContent = fmtPercent(data.memory_percent);
              if (data.memory_usage) { memCell.title = data.memory_usage; }
            }
            row.classList.toggle(
              'is-hot',
              (data.cpu_percent || 0) >= 50 || (data.memory_percent || 0) >= 80
            );
          });
          sortContainerRowsByUsage();
          if (hint) {
            hint.className = 'container-stats-hint';
            hint.textContent = '占用为执行瞬间的单次采样 · 已按 CPU 占用排序';
            hint.hidden = false;
          }
        })
        .catch(function (error) {
          if (hint) {
            hint.className = 'container-stats-hint is-error';
            hint.textContent = '读取失败：' + (error && error.message ? error.message : '未知错误');
            hint.hidden = false;
          }
        })
        .then(function () {
          button.disabled = false;
          button.textContent = label;
        });
    });
  }

  function bindContainerFilter() {
    var search = document.getElementById('container-search');
    var state = document.getElementById('container-state');
    var countEl = document.getElementById('container-count');
    var emptyEl = document.getElementById('container-filter-empty');
    var rows = Array.prototype.slice.call(document.querySelectorAll('[data-container-row]'));
    if (!rows.length) { return; }

    function apply() {
      var keyword = search ? search.value.trim().toLowerCase() : '';
      var wanted = state ? state.value : '';
      var visible = 0;
      rows.forEach(function (row) {
        var haystack = row.getAttribute('data-container-search') || '';
        var rowState = row.getAttribute('data-container-state') || '';
        var ok = (!keyword || haystack.indexOf(keyword) !== -1) && (!wanted || rowState === wanted);
        row.hidden = !ok;
        if (ok) { visible += 1; }
      });
      if (countEl) { countEl.textContent = visible === rows.length ? rows.length + ' 个容器' : visible + ' / ' + rows.length + ' 个容器'; }
      if (emptyEl) { emptyEl.hidden = visible !== 0; }
    }

    if (search) { search.addEventListener('input', apply); }
    if (state) { state.addEventListener('change', apply); }
    apply();
  }

  bindHostTabs();
  bindAlertAcks();
  bindRanges();
  bindActions();
  bindCollectNow();
  bindDiagCopy();
  bindContainerFilter();
  bindContainerStats();
  bindChecksRun();
  loadHistory('24h');
  loadChecks();
})();
