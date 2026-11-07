/* Connection wizard for adding a host (v1.4). */
(function () {
  "use strict";
  var overlay = document.getElementById("wizard-overlay");
  if (!overlay) return;
  var root = document.getElementById("settings-root");
  var csrf = root ? root.getAttribute("data-csrf") || "" : "";
  var currentStep = 1;
  var probe = null;

  function qs(selector, parent) {
    return (parent || overlay).querySelector(selector);
  }
  function field(name) {
    return qs('[data-wizard-field="' + name + '"]');
  }
  function status(id, text, isError) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (isError ? " form-status-error" : " form-status-ok");
  }
  function api(method, url, body) {
    return fetch(url, {
      method: method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) {
          var error = new Error(payload.error || payload.message || ("请求失败 (" + response.status + ")"));
          error.status = response.status;
          throw error;
        }
        return payload;
      });
    });
  }

  function updateAuthFields() {
    var auth = field("auth_type").value;
    overlay.querySelectorAll(".wizard-key-only").forEach(function (el) {
      el.style.display = auth === "key" ? "" : "none";
    });
    overlay.querySelectorAll(".wizard-password-only").forEach(function (el) {
      el.style.display = auth === "password" ? "" : "none";
    });
  }

  function showStep(step) {
    currentStep = step;
    overlay.querySelectorAll("[data-step-panel]").forEach(function (panel) {
      panel.hidden = Number(panel.getAttribute("data-step-panel")) !== step;
    });
    overlay.querySelectorAll("[data-step-dot]").forEach(function (dot) {
      dot.classList.toggle("active", Number(dot.getAttribute("data-step-dot")) === step);
    });
    document.getElementById("wizard-subtitle").textContent =
      step === 1 ? "第 1 步，共 2 步 · 连接信息" : "第 2 步，共 2 步 · 确认信息";
  }

  function openWizard() {
    probe = null;
    document.getElementById("wizard-probe-summary").textContent = "";
    status("wizard-status", "");
    status("wizard-save-status", "");
    showStep(1);
    overlay.hidden = false;
    field("host").focus();
  }
  function closeWizard() { overlay.hidden = true; }

  function probePayload() {
    var payload = {
      host: field("host").value.trim(),
      port: Number(field("port").value) || 22,
      username: field("username").value.trim(),
      auth_type: field("auth_type").value
    };
    if (field("key_path").value.trim()) payload.key_path = field("key_path").value.trim();
    if (field("private_key").value.trim()) payload.private_key = field("private_key").value;
    if (field("passphrase").value) payload.passphrase = field("passphrase").value;
    if (field("password").value) payload.password = field("password").value;
    return payload;
  }

  function renderProbe(result) {
    var dl = document.createElement("dl");
    function row(label, value, isWarn) {
      var dt = document.createElement("dt");
      dt.textContent = label;
      var dd = document.createElement("dd");
      dd.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
      if (isWarn) dd.className = "warn";
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    row("主机名", result.hostname);
    row("系统", result.os_release);
    row("内核", result.kernel);
    row("CPU 核数", result.cpu_cores);
    row("内存 (MB)", result.memory_total_mb);
    var mounts = [];
    if (Array.isArray(result.mounts)) {
      mounts = result.mounts.map(function (item) {
        return item && (item.mountpoint || item.mount);
      }).filter(Boolean);
    } else if (result.mounts) {
      mounts = Object.keys(result.mounts);
    }
    row("挂载点", mounts.join(", "));
    row("storcli", result.storcli_available ? (result.storcli_path || "可用") : "不可用", !result.storcli_available);
    row("免密 sudo", result.sudo_available ? "可用" : "不可用", !result.sudo_available);
    if (result.warnings && result.warnings.length) row("提示", result.warnings.join("；"), true);
    var summary = document.getElementById("wizard-probe-summary");
    summary.textContent = "";
    summary.appendChild(dl);
    var suggested = result.hostname || field("host").value.trim();
    field("name").value = suggested;
    if (!field("disk_mounts").value.trim() || field("disk_mounts").value === "/, /data") {
      var preferred = mounts.filter(function (m) { return m === "/" || m === "/data"; });
      if (preferred.length) field("disk_mounts").value = preferred.join(", ");
    }
  }

  function testConnection() {
    status("wizard-status", "正在连接并识别服务器…");
    status("wizard-save-status", "");
    api("POST", "/api/settings/hosts/probe", probePayload())
      .then(function (result) {
        probe = result;
        if (!result.ok) {
          status("wizard-status", result.message || ("探测失败：" + (result.status || "unknown")), true);
          return;
        }
        renderProbe(result);
        status("wizard-status", "");
        showStep(2);
      })
      .catch(function (error) { status("wizard-status", error.message, true); });
  }

  function saveHost() {
    if (!probe) { status("wizard-save-status", "请先连接识别", true); return; }
    var name = field("name").value.trim();
    if (!name) { status("wizard-save-status", "主机名称不能为空", true); return; }
    var payload = probePayload();
    payload.name = name;
    payload.disk_mounts = field("disk_mounts").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    payload.group = field("group").value.trim();
    payload.owner = field("owner").value.trim();
    payload.location = field("location").value.trim();
    payload.notes = field("notes").value.trim();
    payload.tags = [];
    status("wizard-save-status", "正在保存…");
    api("PUT", "/api/settings/hosts/" + encodeURIComponent(name), payload)
      .then(function () {
        try { sessionStorage.setItem("servermonitor-settings-tab", "hosts"); } catch (e) {}
        window.location.reload();
      })
      .catch(function (error) { status("wizard-save-status", error.message, true); });
  }

  var openButton = document.getElementById("wizard-open-button");
  if (openButton) openButton.addEventListener("click", openWizard);
  document.getElementById("wizard-close").addEventListener("click", closeWizard);
  document.getElementById("wizard-cancel").addEventListener("click", closeWizard);
  document.getElementById("wizard-test").addEventListener("click", testConnection);
  document.getElementById("wizard-back").addEventListener("click", function () { showStep(1); });
  document.getElementById("wizard-save").addEventListener("click", saveHost);
  field("auth_type").addEventListener("change", updateAuthFields);
  updateAuthFields();
})();
