/* SSH terminal page (v1.4).  xterm.js + per-session SSE; no third-party network calls.
 * v0.1.226：断线一键重连、标签可键盘操作、xterm 配色跟随页面明暗主题。 */
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

  function terminalTheme() {
    // 浅色主题下沿用终端面板的浅色背景，暗色保持原配色。
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    if (dark) {
      return { background: "#0b1220", foreground: "#dbeafe", cursor: "#60a5fa" };
    }
    return { background: "#f8fafc", foreground: "#0f172a", cursor: "#2563eb" };
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

  function markDisconnected(record) {
    record.dead = true;
    record.tab.classList.add("is-dead");
    record.reconnect.hidden = false;
    setStatus(record.hostName + " 连接已断开，可点击标签上的「重连」", true);
  }

  function createTab(hostName, sessionId) {
    emptyEl.hidden = true;
    const tab = document.createElement("div");
    tab.className = "terminal-tab";
    tab.setAttribute("role", "tab");
    tab.tabIndex = 0;
    tab.dataset.session = sessionId;
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = hostName;
    const reconnect = document.createElement("button");
    reconnect.type = "button";
    reconnect.className = "tab-reconnect";
    reconnect.textContent = "重连";
    reconnect.title = "重新连接 " + hostName + "（会建立新会话）";
    reconnect.hidden = true;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.textContent = "×";
    close.title = "关闭终端";
    close.setAttribute("aria-label", "关闭 " + hostName + " 的终端");
    tab.appendChild(label);
    tab.appendChild(reconnect);
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
      theme: terminalTheme()
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(pane);
    try { fit.fit(); } catch (err) { /* pane hidden initially */ }

    const record = { hostName, sessionId, tab, pane, term, fit, source: null, dead: false, reconnect };
    panes.set(sessionId, record);

    const stream = new EventSource("/api/ssh/sessions/" + encodeURIComponent(sessionId) + "/stream");
    record.source = stream;
    stream.onmessage = function (event) {
      if (event.data) term.write(base64ToBytes(event.data));
    };
    stream.onerror = function () {
      if (panes.has(sessionId) && !record.dead) markDisconnected(record);
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
      if (event.target === close || event.target === reconnect) return;
      activate(sessionId);
    });
    // 标签可键盘操作：Enter/空格激活，左右方向键在标签间移动。
    tab.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate(sessionId);
      } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        const order = Array.from(tabsEl.querySelectorAll(".terminal-tab"));
        const index = order.indexOf(tab);
        const next = order[index + (event.key === "ArrowRight" ? 1 : -1)];
        if (next) { next.focus(); }
      }
    });
    close.addEventListener("click", function (event) {
      event.stopPropagation();
      closeSession(sessionId);
    });
    reconnect.addEventListener("click", function (event) {
      event.stopPropagation();
      reconnectSession(record);
    });
    activate(sessionId);
    return record;
  }

  async function reconnectSession(record) {
    if (!record || !record.dead) return;
    const hostName = record.hostName;
    setStatus("正在重新连接 " + hostName + "…");
    reconnectFor(record);
    await openSessionFor(hostName);
  }

  function reconnectFor(record) {
    // 旧会话在服务端已不存在，静默清理本地标签。
    try { if (record.source) record.source.close(); } catch (err) { /* noop */ }
    try { record.term.dispose(); } catch (err) { /* noop */ }
    record.tab.remove();
    record.pane.remove();
    panes.delete(record.sessionId);
    if (panes.size === 0) emptyEl.hidden = false;
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

  async function openSessionFor(hostName) {
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

  async function openSession() {
    const hostName = hostSelect ? hostSelect.value : "";
    if (!hostName) return;
    await openSessionFor(hostName);
  }

  if (newButton) newButton.addEventListener("click", openSession);
  if (hostSelect) hostSelect.addEventListener("keydown", function (event) {
    if (event.key === "Enter") openSession();
  });

  // xterm 配色跟随页面明暗主题切换。
  const themeObserver = new MutationObserver(function () {
    const theme = terminalTheme();
    panes.forEach(function (record) {
      try { record.term.options.theme = theme; } catch (err) { /* disposed */ }
    });
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

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
