/* SSH terminal page (v1.4).  xterm.js + per-session SSE; no third-party network calls. */
(function () {
  "use strict";

  const hosts = Array.isArray(window.__TERMINAL_HOSTS__) ? window.__TERMINAL_HOSTS__ : [];
  const isDesktop = window.__TERMINAL_DESKTOP__ === true;
  const tabsEl = document.getElementById("terminal-tabs");
  const panesEl = document.getElementById("terminal-panes");
  const emptyEl = document.getElementById("terminal-empty");
  const statusEl = document.getElementById("terminal-status");
  const hostSelect = document.getElementById("terminal-host");
  const newButton = document.getElementById("terminal-new");
  const csrf = document.querySelector('meta[name="csrf-token"]');
  const csrfToken = csrf ? csrf.getAttribute("content") : "";
  const panes = new Map();

  function setStatus(text, isError) {
    statusEl.textContent = text || "";
    statusEl.classList.toggle("is-error", Boolean(isError));
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function api(url, options) {
    const opts = Object.assign({ headers: {} }, options || {});
    opts.headers = Object.assign({ "X-CSRF-Token": csrfToken }, opts.headers || {});
    const response = await fetch(url, opts);
    if (response.status === 401) {
      window.location.href = "/login";
      throw new Error("unauthorized");
    }
    if (!response.ok) {
      let message = "请求失败 (" + response.status + ")";
      try {
        const body = await response.json();
        message = body.message || body.error || message;
      } catch (err) { /* plain text */ }
      throw new Error(message);
    }
    return response;
  }

  function createTab(hostName, sessionId) {
    emptyEl.hidden = true;
    const tab = document.createElement("div");
    tab.className = "terminal-tab";
    tab.setAttribute("role", "tab");
    tab.dataset.session = sessionId;
    const label = document.createElement("span");
    label.textContent = hostName;
    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "×";
    close.title = "关闭终端";
    tab.appendChild(label);
    tab.appendChild(close);
    tabsEl.appendChild(tab);

    const pane = document.createElement("div");
    pane.className = "terminal-pane";
    pane.dataset.session = sessionId;
    panesEl.appendChild(pane);

    const term = new window.Terminal({
      cursorBlink: true,
      convertEol: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      theme: { background: "#0b1220", foreground: "#dbeafe", cursor: "#60a5fa" }
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(pane);
    try { fit.fit(); } catch (err) { /* pane hidden initially */ }

    const record = { hostName, sessionId, tab, pane, term, fit, source: null };
    panes.set(sessionId, record);

    const stream = new EventSource("/api/ssh/sessions/" + encodeURIComponent(sessionId) + "/stream");
    record.source = stream;
    stream.onmessage = function (event) {
      if (event.data) term.write(base64ToBytes(event.data));
    };
    stream.onerror = function () {
      if (panes.has(sessionId)) setStatus("连接已断开", true);
    };

    term.onData(function (data) {
      fetch("/api/ssh/sessions/" + encodeURIComponent(sessionId) + "/input", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ data: data })
      }).catch(function () { /* stream will surface disconnects */ });
    });
    term.onResize(function (size) {
      fetch("/api/ssh/sessions/" + encodeURIComponent(sessionId) + "/resize", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ cols: size.cols, rows: size.rows })
      }).catch(function () { /* ignore resize errors */ });
    });

    tab.addEventListener("click", function (event) {
      if (event.target === close) return;
      activate(sessionId);
    });
    close.addEventListener("click", function (event) {
      event.stopPropagation();
      closeSession(sessionId);
    });
    activate(sessionId);
    return record;
  }

  function activate(sessionId) {
    panes.forEach(function (record, id) {
      const active = id === sessionId;
      record.tab.classList.toggle("active", active);
      record.pane.classList.toggle("active", active);
    });
    const record = panes.get(sessionId);
    if (record) {
      requestAnimationFrame(function () {
        try { record.fit.fit(); record.term.focus(); } catch (err) { /* noop */ }
      });
    }
  }

  async function closeSession(sessionId) {
    const record = panes.get(sessionId);
    if (!record) return;
    try {
      await api("/api/ssh/sessions/" + encodeURIComponent(sessionId), { method: "DELETE" });
    } catch (err) { /* already closed */ }
    if (record.source) record.source.close();
    record.term.dispose();
    record.tab.remove();
    record.pane.remove();
    panes.delete(sessionId);
    if (panes.size === 0) emptyEl.hidden = false;
    setStatus("");
  }

  async function openSession() {
    const hostName = hostSelect ? hostSelect.value : "";
    if (!hostName) return;
    if (!isDesktop) {
      setStatus("SSH 终端只在桌面客户端中可用", true);
      return;
    }
    setStatus("正在连接 " + hostName + "…");
    newButton.disabled = true;
    try {
      const response = await api("/api/ssh/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host_name: hostName, cols: 100, rows: 30 })
      });
      const data = await response.json();
      createTab(hostName, data.session_id);
      setStatus("已连接 " + hostName);
    } catch (err) {
      setStatus(err.message || "连接失败", true);
    } finally {
      newButton.disabled = false;
    }
  }

  if (newButton) newButton.addEventListener("click", openSession);
  if (hostSelect) hostSelect.addEventListener("keydown", function (event) {
    if (event.key === "Enter") openSession();
  });

  const preset = new URLSearchParams(window.location.search).get("host");
  if (preset && hostSelect) {
    Array.from(hostSelect.options).forEach(function (option) {
      if (option.value === preset) hostSelect.value = preset;
    });
    openSession();
  }

  window.addEventListener("beforeunload", function () {
    panes.forEach(function (record) {
      try {
        fetch("/api/ssh/sessions/" + encodeURIComponent(record.sessionId), {
          method: "DELETE",
          headers: { "X-CSRF-Token": csrfToken },
          keepalive: true
        });
      } catch (err) { /* best effort */ }
    });
  });
})();
