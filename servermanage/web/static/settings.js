/* In-browser settings for the server monitor. Plain ES2017, no build step. */
(function () {
  "use strict";

  var root = document.getElementById("settings-root");
  if (!root) return;
  var csrf = root.getAttribute("data-csrf") || "";
  var initial = window.__SETTINGS__ || {};
  var writable = !!initial.writable;

  function qs(selector, parent) {
    return (parent || document).querySelector(selector);
  }
  function qsa(selector, parent) {
    return Array.prototype.slice.call((parent || document).querySelectorAll(selector));
  }
  function status(el, text, isError) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-status" + (isError ? " form-status-error" : " form-status-ok");
  }
  function api(method, url, body) {
    return fetch(url, {
      method: method,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (response) {
      if (response.status === 401) {
        window.location.href = "/login";
        throw new Error("未登录");
      }
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) {
          var detail = payload && (payload.error || payload.detail);
          var error = new Error(detail || ("请求失败 (" + response.status + ")"));
          error.status = response.status;
          throw error;
        }
        return payload;
      });
    });
  }

  function setNested(target, path, value) {
    var parts = path.split(".");
    var cursor = target;
    for (var i = 0; i < parts.length - 1; i += 1) {
      if (!cursor[parts[i]] || typeof cursor[parts[i]] !== "object") cursor[parts[i]] = {};
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
  }

  function collectSection(sectionName) {
    var section = qs('[data-section="' + sectionName + '"]');
    var payload = {};
    if (!section) return payload;
    qsa("[data-field]", section).forEach(function (input) {
      var path = input.getAttribute("data-field");
      if (input.type === "checkbox") {
        setNested(payload, path, input.checked);
      } else if (path === "storcli_candidates") {
        var lines = input.value.split(/\r?\n/).map(function (line) { return line.trim(); });
        setNested(payload, path, lines.filter(Boolean));
      } else if (input.type === "number") {
        var number = Number(input.value);
        setNested(payload, path, isNaN(number) ? input.value : number);
      } else {
        setNested(payload, path, input.value);
      }
    });
    return payload;
  }

  function fillSection(sectionName, data) {
    var section = qs('[data-section="' + sectionName + '"]');
    if (!section || !data) return;
    qsa("[data-field]", section).forEach(function (input) {
      var path = input.getAttribute("data-field");
      var value = path.split(".").reduce(function (cursor, key) {
        return cursor === undefined || cursor === null ? undefined : cursor[key];
      }, data);
      if (value === undefined || value === null) return;
      if (input.type === "checkbox") input.checked = !!value;
      else if (path === "storcli_candidates") input.value = (value || []).join("\n");
      else input.value = value;
    });
  }

  function saveSection(sectionName) {
    var button = qs('[data-save="' + sectionName + '"]');
    var payload = collectSection(sectionName);
    if (button) button.disabled = true;
    api("PUT", "/api/settings/" + sectionName, payload)
      .then(function (result) {
        var message = "已保存";
        if (result && result.restart_required) message = "已保存，重启程序后生效";
        status(qs("#settings-root"), "");
        status(button ? button.parentElement.querySelector(".form-status") : null, message);
        if (!button) return;
        var note = document.createElement("p");
        note.className = "form-status form-status-ok";
        note.textContent = message;
        var existing = button.nextElementSibling;
        if (existing && existing.classList.contains("form-status")) existing.remove();
        button.insertAdjacentElement("afterend", note);
        window.__SETTINGS__[sectionName] = payload;
      })
      .catch(function (error) {
        status(button ? button.parentElement.querySelector(".form-status") : null, error.message, true);
      })
      .finally(function () {
        if (button) button.disabled = !writable;
      });
  }

  qsa("[data-save]").forEach(function (button) {
    button.addEventListener("click", function () {
      saveSection(button.getAttribute("data-save"));
    });
  });

  // -- hosts -------------------------------------------------------------
  var hostForm = qs("#host-form");
  var hostStatus = qs("#host-form-status");
  var originalHostName = null;

  function hostField(name) {
    return qs('[data-host-field="' + name + '"]', hostForm);
  }

  function updateAuthVisibility() {
    var authType = hostField("auth_type").value;
    qsa(".key-only", hostForm).forEach(function (el) {
      el.style.display = authType === "key" ? "" : "none";
    });
    qsa(".password-only", hostForm).forEach(function (el) {
      el.style.display = authType === "password" ? "" : "none";
    });
  }

  function openHostForm(host) {
    originalHostName = host ? host.name : null;
    qs("#host-form-title").textContent = host ? "编辑主机 " + host.name : "新增主机";
    hostField("name").value = host ? host.name : "";
    hostField("name").readOnly = !!host;
    hostField("host").value = host ? host.host : "";
    hostField("port").value = host ? host.port : 22;
    hostField("username").value = host ? host.username : "";
    hostField("auth_type").value = host ? host.auth_type : "key";
    hostField("disk_mounts").value = host ? (host.disk_mounts || []).join(", ") : "/, /data";
    hostField("key_path").value = host ? (host.key_path || "") : "";
    hostField("private_key").value = "";
    hostField("passphrase").value = "";
    hostField("password").value = "";
    hostField("tags").value = host ? (host.tags || []).join(", ") : "";
    status(hostStatus, "");
    updateAuthVisibility();
    hostForm.hidden = false;
    hostForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  qs("#add-host-button").addEventListener("click", function () { openHostForm(null); });
  qs("#cancel-host-button").addEventListener("click", function () { hostForm.hidden = true; });
  hostField("auth_type").addEventListener("change", updateAuthVisibility);

  qsa("[data-host-edit]").forEach(function (button) {
    button.addEventListener("click", function () {
      var name = button.getAttribute("data-host-edit");
      var host = (initial.hosts || []).filter(function (item) { return item.name === name; })[0];
      openHostForm(host || { name: name });
    });
  });

  qsa("[data-host-delete]").forEach(function (button) {
    button.addEventListener("click", function () {
      var name = button.getAttribute("data-host-delete");
      if (!window.confirm("确定删除主机 " + name + " 吗？")) return;
      api("DELETE", "/api/settings/hosts/" + encodeURIComponent(name))
        .then(function () { window.location.reload(); })
        .catch(function (error) { window.alert(error.message); });
    });
  });

  function hostPayload() {
    var mounts = hostField("disk_mounts").value.split(",").map(function (item) { return item.trim(); });
    var tags = hostField("tags").value.split(",").map(function (item) { return item.trim(); });
    var payload = {
      host: hostField("host").value.trim(),
      port: Number(hostField("port").value) || 22,
      username: hostField("username").value.trim(),
      auth_type: hostField("auth_type").value,
      disk_mounts: mounts.filter(Boolean),
      tags: tags.filter(Boolean),
      key_path: hostField("key_path").value.trim() || null,
    };
    if (hostField("private_key").value.trim()) payload.private_key = hostField("private_key").value;
    if (hostField("passphrase").value) payload.passphrase = hostField("passphrase").value;
    if (hostField("password").value) payload.password = hostField("password").value;
    return payload;
  }

  qs("#save-host-button").addEventListener("click", function () {
    var name = hostField("name").value.trim();
    if (!name) { status(hostStatus, "主机名称不能为空", true); return; }
    api("PUT", "/api/settings/hosts/" + encodeURIComponent(name), hostPayload())
      .then(function () { window.location.reload(); })
      .catch(function (error) { status(hostStatus, error.message, true); });
  });

  qs("#test-ssh-button").addEventListener("click", function () {
    status(hostStatus, "正在测试 SSH 连接…");
    api("POST", "/api/settings/test-ssh", hostPayload())
      .then(function (result) { status(hostStatus, result.detail || "连接成功", !result.ok); })
      .catch(function (error) { status(hostStatus, error.message, true); });
  });

  // -- notifications -----------------------------------------------------
  qs("#test-webhook-button").addEventListener("click", function () {
    var section = qs('[data-section="alerts"]');
    var payload = collectSection("alerts").webhook || {};
    status(qs("#notify-status"), "正在发送测试通知…");
    api("POST", "/api/settings/test-webhook", payload)
      .then(function (result) { status(qs("#notify-status"), result.detail, !result.ok); })
      .catch(function (error) { status(qs("#notify-status"), error.message, true); });
  });

  qs("#test-email-button").addEventListener("click", function () {
    var payload = collectSection("smtp");
    status(qs("#smtp-status"), "正在发送测试邮件…");
    api("POST", "/api/settings/test-email", payload)
      .then(function (result) { status(qs("#smtp-status"), result.detail, !result.ok); })
      .catch(function (error) { status(qs("#smtp-status"), error.message, true); });
  });

  // -- password ----------------------------------------------------------
  var passwordForm = qs("#password-form");
  passwordForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var payload = {};
    qsa("[data-password-field]", passwordForm).forEach(function (input) {
      payload[input.getAttribute("data-password-field")] = input.value;
    });
    status(qs("#password-status"), "正在修改…");
    api("POST", "/api/settings/password", payload)
      .then(function () {
        status(qs("#password-status"), "密码已修改，请重新登录");
        window.setTimeout(function () { window.location.href = "/login"; }, 1200);
      })
      .catch(function (error) { status(qs("#password-status"), error.message, true); });
  });

  // Fill any values that were not rendered server-side (e.g. list edits).
  fillSection("monitoring", initial.monitoring);
  fillSection("ssh", initial.ssh);
  fillSection("smtp", initial.smtp);
  fillSection("alerts", initial.alerts);
  fillSection("report", initial.report);
  fillSection("disk_health", initial.disk_health);
  fillSection("dashboard", initial.dashboard);
})();
