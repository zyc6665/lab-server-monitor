/* 主机详情：诊断、立即采集、历史趋势。
 * 纯原生 JS，无第三方依赖；所有文本使用 textContent，绝不拼接 HTML。 */
(function () {
  'use strict';

  var HOST_NAME = window.__HOST_NAME__ || '';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var COLORS = {
    cpu: '#2563eb',
    memory: '#7c3aed',
    disk: '#059669',
    gpu_memory: '#d97706'
  };
  var TITLES = {
    cpu: 'CPU',
    memory: '内存',
    disk: '磁盘',
    gpu_memory: 'GPU 显存'
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

  function makeSvgEl(name, attrs) {
    var el = document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach(function (key) {
      el.setAttribute(key, attrs[key]);
    });
    return el;
  }

  function drawTrend(svg, values, key) {
    if (!svg) { return; }
    while (svg.firstChild) { svg.removeChild(svg.firstChild); }
    var numbers = values.filter(function (v) { return v !== null && v !== undefined && !isNaN(Number(v)); }).map(Number);
    var latest = document.querySelector('[data-trend-latest="' + key + '"]');
    if (latest) { latest.textContent = numbers.length ? fmt(numbers[numbers.length - 1]) : ''; }
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
    })).textContent = '最低 ' + fmt(min) + ' · 最高 ' + fmt(max);
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

  function bindHostTabs() {
    var tabs = document.querySelectorAll('[data-host-tab]');
    var panels = document.querySelectorAll('[data-host-panel]');
    if (!tabs.length || !panels.length) { return; }
    function activate(key) {
      Array.prototype.forEach.call(tabs, function (tab) {
        var active = tab.getAttribute('data-host-tab') === key;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      Array.prototype.forEach.call(panels, function (panel) {
        panel.hidden = panel.getAttribute('data-host-panel') !== key;
      });
    }
    Array.prototype.forEach.call(tabs, function (tab) {
      tab.addEventListener('click', function () {
        var key = tab.getAttribute('data-host-tab') || 'overview';
        activate(key);
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', '#tab-' + key);
        }
      });
    });
    var initial = (window.location.hash || '').replace('#tab-', '');
    if (!initial) { initial = 'overview'; }
    activate(initial);
  }

  bindHostTabs();
  bindRanges();
  bindActions();
  loadHistory('24h');
})();
