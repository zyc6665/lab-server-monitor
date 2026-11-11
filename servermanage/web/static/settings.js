/* In-browser settings for the server monitor. Plain ES2017, no build step. */
(function () {
  "use strict";

  var root = document.getElementById("settings-root");
  if (!root) return;
  var csrf = root.getAttribute("data-csrf") || "";
  var initial = window.__SETTINGS__ || {};
  var writable = !!initial.writable;

  function reloadToHosts() {
    try { sessionStorage.setItem("servermonitor-settings-tab", "hosts"); } catch (e) {}
    window.location.reload();
  }

  function watchHostCollection(names, done) {
    var list = (names || []).filter(Boolean);
    if (!list.length) { (done || reloadToHosts)(); return; }
    var statusEl = qs("#host-collection-status");
    var started = Date.now();
    function tick() {
      fetch("/api/settings/hosts/collection-status?names=" + encodeURIComponent(list.join(",")), {
        credentials: "same-origin",
      })
        .then(function (response) {
          if (response.status === 401) { window.location.href = "/login"; return null; }
          return response.json().catch(function () { return {}; });
        })
        .then(function (payload) {
          if (!payload) return;
          var statuses = payload.statuses || {};
          var doneCount = 0, failed = 0;
          list.forEach(function (name) {
            var state = (statuses[name] || {}).state || "unknown";
            if (state === "done") doneCount += 1;
            if (state === "error") failed += 1;
          });
          if (statusEl) {
            status(
              statusEl,
              "正在采集主机数据 " + doneCount + "/" + list.length + "…",
              false
            );
          }
          if (doneCount + failed >= list.length || Date.now() - started > 60000) {
            if (statusEl) {
              status(
                statusEl,
                failed ? "采集完成，失败 " + failed + " 台" : "采集完成",
                failed > 0
              );
            }
            (done || reloadToHosts)();
            return;
          }
          window.setTimeout(tick, 1000);
        })
        .catch(function () {
          if (Date.now() - started > 60000) { (done || reloadToHosts)(); return; }
          window.setTimeout(tick, 1000);
        });
    }
    tick();
  }
  window.servermonitorWatchCollection = watchHostCollection;

  function qs(selector, parent) {
    return (parent || document).querySelector(selector);
  }
  var toastTimer = null;
  function toast(text, isError) {
    var node = document.getElementById("settings-toast");
    if (!node) {
      node = document.createElement("div");
      node.id = "settings-toast";
      node.className = "settings-toast";
      node.setAttribute("role", "status");
      node.setAttribute("aria-live", "polite");
      document.body.appendChild(node);
    }
    node.textContent = text;
    node.className = "settings-toast" + (isError ? " settings-toast-error" : "");
    node.hidden = false;
    if (toastTimer) { window.clearTimeout(toastTimer); }
    toastTimer = window.setTimeout(function () { node.hidden = true; }, 4500);
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
    if (sectionName === "monitoring") {
      var checkedMode = qs('[data-section="monitoring"] input[data-mode]:checked');
      payload.mode = checkedMode ? checkedMode.getAttribute("data-mode") : "admin";
    }
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

  function clockLabel() {
    var now = new Date();
    function pad(value) { return value < 10 ? "0" + value : String(value); }
    return pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
  }

  function saveHint(button) {
    if (!button) return null;
    var hint = button.parentElement.querySelector(".save-hint");
    if (!hint) {
      hint = document.createElement("span");
      hint.className = "save-hint";
      button.insertAdjacentElement("afterend", hint);
    }
    return hint;
  }

  function markDirty(sectionName) {
    var button = qs('[data-save="' + sectionName + '"]');
    if (!button) return;
    button.classList.add("is-dirty");
    var hint = saveHint(button);
    if (hint) {
      hint.textContent = "有未保存修改";
      hint.className = "save-hint save-hint-dirty";
    }
  }

  function markSaved(sectionName, message) {
    var button = qs('[data-save="' + sectionName + '"]');
    if (!button) return;
    button.classList.remove("is-dirty");
    var hint = saveHint(button);
    if (!hint) return;
    hint.textContent = message;
    hint.className = "save-hint save-hint-ok";
    window.setTimeout(function () {
      if (hint.textContent === message) { hint.textContent = ""; }
    }, 8000);
  }

  qsa("[data-section]").forEach(function (section) {
    var sectionName = section.getAttribute("data-section");
    if (!sectionName) return;
    section.addEventListener("input", function () { markDirty(sectionName); });
    section.addEventListener("change", function () { markDirty(sectionName); });
  });

  function fieldOf(sectionName, path) {
    return qs('[data-section="' + sectionName + '"] [data-field="' + path + '"]');
  }

  function numberIn(sectionName, path, min, max, label, allowEmpty) {
    var input = fieldOf(sectionName, path);
    if (!input) return "";
    var raw = String(input.value || "").trim();
    if (!raw) return allowEmpty ? "" : label + "不能为空";
    var value = Number(raw);
    if (!isFinite(value) || value < min || value > max) {
      markField(input, true);
      input.focus();
      return label + "需要在 " + min + "–" + max + " 之间";
    }
    markField(input, false);
    return "";
  }

  function validateSection(sectionName) {
    var message = "";
    if (sectionName === "alerts") {
      ["cpu_percent", "memory_percent", "disk_percent", "gpu_memory_percent"].forEach(function (key) {
        if (message) return;
        message = numberIn("alerts", "thresholds." + key, 1, 100, "告警阈值");
      });
      if (!message) message = numberIn("alerts", "thresholds.disk_temperature_c", 1, 120, "磁盘温度阈值");
      if (!message) message = numberIn("alerts", "consecutive_periods", 1, 10, "连续异常周期数");
      if (!message) message = numberIn("alerts", "cooldown_minutes", 0, 1440, "冷却时间");
      if (!message) message = numberIn("alerts", "offline_failures", 1, 100, "离线判定次数");
      var urlInput = fieldOf("alerts", "webhook.url");
      if (!message && urlInput) {
        var url = String(urlInput.value || "").trim();
        if (url && !/^https?:\/\//i.test(url)) {
          markField(urlInput, true);
          urlInput.focus();
          message = "Webhook 地址需要以 http:// 或 https:// 开头";
        }
      }
    } else if (sectionName === "user_monitoring") {
      message = numberIn("user_monitoring", "scan_interval_seconds", 300, 86400, "账号扫描间隔");
      if (!message) message = numberIn("user_monitoring", "usage_interval_seconds", 3600, 604800, "目录占用统计间隔");
      if (!message) message = numberIn("user_monitoring", "command_timeout", 10, 600, "单条命令超时");
    } else if (sectionName === "smtp") {
      message = numberIn("smtp", "port", 1, 65535, "SMTP 端口");
      var fromInput = fieldOf("smtp", "from_addr");
      if (!message && fromInput) {
        var from = String(fromInput.value || "").trim();
        if (from && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) {
          markField(fromInput, true);
          fromInput.focus();
          message = "发件人需要一个完整的邮箱地址";
        }
      }
      var toInput = fieldOf("smtp", "to_addrs");
      if (!message && toInput) {
        var to = String(toInput.value || "").trim();
        if (to && to.split(/[,;]/).some(function (part) {
          var value = part.trim();
          return value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
        })) {
          markField(toInput, true);
          toInput.focus();
          message = "收件人里有不完整的邮箱地址";
        }
      }
    }
    return message;
  }

  var SAVE_MESSAGE = {
    monitoring: "已保存，下个轮询周期生效",
    alerts: "已保存，新规则从下一轮判断开始生效",
    user_monitoring: "已保存，下一轮用户扫描生效",
    disk_health: "已保存，下一次磁盘采集生效",
    report: "已保存，下份报告按新设置生成",
    smtp: "已保存，下封邮件按新设置发送",
    ssh: "已保存，新建连接使用新超时",
    logs: "已保存"
  };

  function saveMessage(sectionName, restartRequired) {
    if (restartRequired) {
      return "已保存；端口/监听地址等改动需重启后台服务后生效";
    }
    return SAVE_MESSAGE[sectionName] || "已保存";
  }

  function renderSaveNotice(button, message, restartRequired) {
    var next = button.nextElementSibling;
    while (next && next.classList.contains("save-notice")) {
      var stale = next.nextElementSibling;
      next.remove();
      next = stale;
    }
    var oldStatus = button.nextElementSibling;
    if (oldStatus && oldStatus.classList.contains("form-status")) oldStatus.remove();

    var note = document.createElement("div");
    note.className = "save-notice" + (restartRequired ? " save-notice-restart" : "");
    var text = document.createElement("span");
    text.className = "save-notice-text";
    text.textContent = message;
    note.appendChild(text);

    if (restartRequired && window.desktopBridge && window.desktopBridge.restartBackend) {
      var restart = document.createElement("button");
      restart.type = "button";
      restart.className = "save-notice-action";
      restart.textContent = "重启后台服务";
      restart.addEventListener("click", function () {
        restart.disabled = true;
        text.textContent = "正在重启后台…";
        window.desktopBridge.restartBackend().then(
          function (result) {
            var ok = !!(result && result.ok);
            note.className = "save-notice" + (ok ? "" : " save-notice-error");
            text.textContent = ok ? "后台已重启，新设置已生效" : "重启失败，请手动关闭并重开客户端";
            if (ok) { restart.remove(); }
          },
          function () {
            note.className = "save-notice save-notice-error";
            text.textContent = "重启失败，请手动关闭并重开客户端";
          }
        );
      });
      note.appendChild(restart);
    } else if (restartRequired) {
      var hint = document.createElement("span");
      hint.className = "save-notice-hint";
      hint.textContent = "请关闭客户端并重新打开";
      note.appendChild(hint);
    }
    button.insertAdjacentElement("afterend", note);
  }

  function saveSection(sectionName) {
    var button = qs('[data-save="' + sectionName + '"]');
    var problem = validateSection(sectionName);
    if (problem) {
      status(button ? button.parentElement.querySelector(".form-status") : null, problem, true);
      markDirty(sectionName);
      return;
    }
    var payload = collectSection(sectionName);
    if (button) button.disabled = true;
    api("PUT", "/api/settings/" + sectionName, payload)
      .then(function (result) {
        var formStatus = button
          ? button.parentElement.querySelector(".form-status")
          : null;
        status(qs("#settings-root"), "");
        window.__SETTINGS__[sectionName] = payload;
        var restartRequired = !!(result && result.restart_required);
        var message = saveMessage(sectionName, restartRequired);
        status(formStatus, message);
        markSaved(sectionName, message + " " + clockLabel());
        if (button) renderSaveNotice(button, message, restartRequired);
      })
      .catch(function (error) {
        status(button ? button.parentElement.querySelector(".form-status") : null, error.message, true);
        markDirty(sectionName);
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

  var CHECK_TYPES = ["tcp", "http", "process", "service"];
  var MAX_CHECKS = 20;
  var EXPECTED_RE = /^\d{3}(-\d{3})?$/;

  function numberOrBlank(value) {
    return value === undefined || value === null ? "" : value;
  }

  function checkRowPayload(row) {
    return {
      name: row.querySelector(".check-name").value.trim(),
      type: row.querySelector(".check-type").value,
      target: row.querySelector(".check-target").value.trim(),
      timeout_seconds: Number(row.querySelector(".check-timeout").value) || 5,
      expected: row.querySelector(".check-expected").value.trim() || null,
      enabled: row.querySelector(".check-enabled").checked,
    };
  }

  function collectChecks() {
    return qsa("#host-checks-body tr").map(function (row) {
      return checkRowPayload(row);
    });
  }

  function validateCheck(check) {
    if (!check.name) return "检查名称不能为空";
    if (check.name.length > 64) return "检查名称最多 64 个字符";
    if (CHECK_TYPES.indexOf(check.type) < 0) {
      return "检查类型必须是 tcp/http/process/service";
    }
    if (!check.target) return "检查目标不能为空";
    if (check.target.length > 256) return "检查目标最多 256 个字符";
    if (
      !Number.isInteger(check.timeout_seconds) ||
      check.timeout_seconds < 1 ||
      check.timeout_seconds > 30
    ) {
      return "检查超时必须是 1 到 30 之间的整数";
    }
    if (check.expected && !EXPECTED_RE.test(check.expected)) {
      return "期望值必须是 200 或 200-299 这样的状态码";
    }
    return null;
  }

  function validateChecks(checks) {
    if (checks.length > MAX_CHECKS) return "最多支持 " + MAX_CHECKS + " 项检查";
    var seen = {};
    for (var i = 0; i < checks.length; i += 1) {
      var error = validateCheck(checks[i]);
      if (error) return error;
      var folded = checks[i].name.toLowerCase();
      if (seen[folded]) return "检查名称重复：" + checks[i].name;
      seen[folded] = true;
    }
    return null;
  }

  function appendCell(row, child) {
    var cell = document.createElement("td");
    cell.appendChild(child);
    row.appendChild(cell);
    return cell;
  }

  function addCheckRow(check) {
    var body = qs("#host-checks-body");
    if (!body) return;
    if (body.querySelectorAll("tr").length >= MAX_CHECKS) {
      status(hostStatus, "最多支持 " + MAX_CHECKS + " 项检查", true);
      return;
    }
    var data = check || {};
    var row = document.createElement("tr");

    var nameInput = document.createElement("input");
    nameInput.className = "check-name";
    nameInput.type = "text";
    nameInput.maxLength = 64;
    nameInput.value = data.name || "";
    appendCell(row, nameInput);

    var typeSelect = document.createElement("select");
    typeSelect.className = "check-type";
    CHECK_TYPES.forEach(function (type) {
      var option = document.createElement("option");
      option.value = type;
      option.textContent = type;
      typeSelect.appendChild(option);
    });
    typeSelect.value = CHECK_TYPES.indexOf(data.type) >= 0 ? data.type : "tcp";
    appendCell(row, typeSelect);

    var targetInput = document.createElement("input");
    targetInput.className = "check-target";
    targetInput.type = "text";
    targetInput.maxLength = 256;
    targetInput.value = data.target || "";
    appendCell(row, targetInput);

    var timeoutInput = document.createElement("input");
    timeoutInput.className = "check-timeout";
    timeoutInput.type = "number";
    timeoutInput.min = "1";
    timeoutInput.max = "30";
    timeoutInput.step = "1";
    timeoutInput.value = data.timeout_seconds || 5;
    appendCell(row, timeoutInput);

    var expectedInput = document.createElement("input");
    expectedInput.className = "check-expected";
    expectedInput.type = "text";
    expectedInput.value = data.expected || "";
    appendCell(row, expectedInput);

    var enabledInput = document.createElement("input");
    enabledInput.className = "check-enabled";
    enabledInput.type = "checkbox";
    enabledInput.checked = data.enabled === undefined ? true : !!data.enabled;
    appendCell(row, enabledInput);

    var actions = document.createElement("td");
    actions.className = "row-actions";
    var testButton = document.createElement("button");
    testButton.type = "button";
    testButton.className = "secondary-button check-test-button";
    testButton.textContent = "测试";
    testButton.addEventListener("click", function () { testCheckRow(row); });
    var removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "danger-button check-remove-button";
    removeButton.textContent = "删除";
    removeButton.addEventListener("click", function () {
      row.parentNode.removeChild(row);
    });
    actions.appendChild(testButton);
    actions.appendChild(removeButton);
    row.appendChild(actions);

    body.appendChild(row);
  }

  function resetCheckRows(checks) {
    var body = qs("#host-checks-body");
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);
    (checks || []).forEach(function (check) { addCheckRow(check); });
    status(qs("#host-checks-status"), "");
  }

  function testCheckRow(row) {
    var checksStatus = qs("#host-checks-status");
    var check = checkRowPayload(row);
    var error = validateCheck(check);
    if (error) { status(checksStatus, error, true); return; }
    if (!check.enabled) {
      status(checksStatus, "该检查已禁用，请先勾选启用后再测试", true);
      return;
    }
    if (!originalHostName) {
      status(checksStatus, "请先保存主机再测试", true);
      return;
    }
    status(checksStatus, "正在测试检查 " + check.name + "…");
    api(
      "POST",
      "/api/settings/hosts/" + encodeURIComponent(originalHostName) + "/checks/test",
      check
    )
      .then(function (result) {
        if (!result || result.ok === false) {
          status(
            checksStatus,
            (result && result.error) || "检查未执行",
            true
          );
          return;
        }
        var items = (result && result.results) || [];
        if (!items.length) { status(checksStatus, "检查未执行", true); return; }
        var item = items[0];
        status(
          checksStatus,
          check.name + "：" + item.status + (item.message ? " — " + item.message : ""),
          item.status !== "ok"
        );
      })
      .catch(function (err) { status(checksStatus, err.message, true); });
  }

  function collectAlertRules() {
    var mapping = {
      cpu_percent: "alert_cpu_percent",
      memory_percent: "alert_memory_percent",
      disk_percent: "alert_disk_percent",
      gpu_memory_percent: "alert_gpu_memory_percent",
      disk_temperature_c: "alert_disk_temperature_c",
      consecutive_periods: "alert_consecutive_periods",
    };
    var rules = {};
    var hasValue = false;
    Object.keys(mapping).forEach(function (key) {
      var raw = hostField(mapping[key]).value.trim();
      if (raw === "") return;
      rules[key] = Number(raw);
      hasValue = true;
    });
    return hasValue ? rules : null;
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
    hostField("group").value = host ? (host.group || "") : "";
    hostField("owner").value = host ? (host.owner || "") : "";
    hostField("location").value = host ? (host.location || "") : "";
    hostField("notes").value = host ? (host.notes || "") : "";
    var userMonitoring = host ? host.user_monitoring : null;
    hostField("user_monitoring").value =
      userMonitoring === true ? "true" : (userMonitoring === false ? "false" : "");
    hostField("sudo_password").value = "";
    hostField("clear_sudo_password").checked = false;
    hostField("allow_user_write").checked = Boolean(host && host.allow_user_write);
    var sudoState = qs("#host-sudo-state");
    if (sudoState) {
      sudoState.textContent = host && host.sudo_configured ? "已配置" : "未配置";
    }
    var rules = (host && host.alert_rules) || {};
    hostField("alert_cpu_percent").value = numberOrBlank(rules.cpu_percent);
    hostField("alert_memory_percent").value = numberOrBlank(rules.memory_percent);
    hostField("alert_disk_percent").value = numberOrBlank(rules.disk_percent);
    hostField("alert_gpu_memory_percent").value = numberOrBlank(rules.gpu_memory_percent);
    hostField("alert_disk_temperature_c").value = numberOrBlank(rules.disk_temperature_c);
    hostField("alert_consecutive_periods").value = numberOrBlank(rules.consecutive_periods);
    resetCheckRows(host && host.checks ? host.checks : []);
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
        .then(function () { reloadToHosts(); })
        .catch(function (error) { window.alert(error.message); });
    });
  });

  qsa("[data-host-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      var name = button.getAttribute("data-host-copy");
      var newName = window.prompt("复制为新的主机名称", name + "-copy");
      if (!newName) return;
      api("POST", "/api/settings/hosts/" + encodeURIComponent(name) + "/copy", { new_name: newName })
        .then(function () { watchHostCollection([newName]); })
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
      group: hostField("group").value.trim(),
      owner: hostField("owner").value.trim(),
      location: hostField("location").value.trim(),
      notes: hostField("notes").value.trim(),
      key_path: hostField("key_path").value.trim() || null,
    };
    if (hostField("private_key").value.trim()) payload.private_key = hostField("private_key").value;
    if (hostField("passphrase").value) payload.passphrase = hostField("passphrase").value;
    if (hostField("password").value) payload.password = hostField("password").value;
    payload.checks = collectChecks();
    payload.alert_rules = collectAlertRules();
    // 空字符串表示"继承全局"，不能用 true/false 表达，所以这里显式传 null。
    var monitoring = hostField("user_monitoring").value;
    payload.user_monitoring = monitoring === "" ? null : monitoring === "true";
    payload.allow_user_write = hostField("allow_user_write").checked;
    if (hostField("clear_sudo_password").checked) {
      payload.clear_secrets = ["sudo_password"];
    } else if (hostField("sudo_password").value) {
      payload.sudo_password = hostField("sudo_password").value;
    }
    return payload;
  }

  qs("#add-check-button").addEventListener("click", function () {
    addCheckRow(null);
  });

  function markField(input, invalid) {
    if (!input) return;
    if (invalid) { input.classList.add("is-invalid"); } else { input.classList.remove("is-invalid"); }
  }

  function validateHostForm() {
    var nameInput = hostField("name");
    var hostInput = hostField("host");
    var portInput = hostField("port");
    markField(nameInput, false);
    markField(hostInput, false);
    markField(portInput, false);
    if (!nameInput.value.trim()) {
      markField(nameInput, true);
      nameInput.focus();
      return "主机名称不能为空";
    }
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(nameInput.value.trim())) {
      markField(nameInput, true);
      nameInput.focus();
      return "主机名称只能包含字母、数字、点、下划线和短横线，且不超过 64 个字符";
    }
    if (!hostInput.value.trim()) {
      markField(hostInput, true);
      hostInput.focus();
      return "请填写服务器地址或 IP";
    }
    var portText = String(portInput.value || "").trim() || "22";
    var port = Number(portText);
    if (!/^[0-9]+$/.test(portText) || !isFinite(port) || port < 1 || port > 65535) {
      markField(portInput, true);
      portInput.focus();
      return "端口需要是 1–65535 之间的数字";
    }
    return "";
  }

  qs("#save-host-button").addEventListener("click", function () {
    var formError = validateHostForm();
    if (formError) { status(hostStatus, formError, true); return; }
    var name = hostField("name").value.trim();
    var checkError = validateChecks(collectChecks());
    if (checkError) { status(hostStatus, checkError, true); return; }
    var saveButton = qs("#save-host-button");
    saveButton.disabled = true;
    status(hostStatus, "正在保存…");
    api("PUT", "/api/settings/hosts/" + encodeURIComponent(name), hostPayload())
      .then(function () {
        saveButton.disabled = false;
        status(hostStatus, "");
        // 保存成功后立刻收起表单，采集在后台继续，不再卡住界面。
        hostForm.hidden = true;
        toast("已保存主机 " + name + "，正在后台采集数据…");
        watchHostCollection([name], function () {
          toast("主机 " + name + " 采集完成，刷新页面即可看到最新数据");
        });
      })
      .catch(function (error) {
        saveButton.disabled = false;
        status(hostStatus, error.message, true);
      });
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

  // -- batch connection test ---------------------------------------------
  var batchButton = qs("#test-batch-button");
  if (batchButton) {
    batchButton.addEventListener("click", function () {
      var names = (initial.hosts || []).map(function (host) { return host.name; });
      var batchStatus = qs("#host-batch-status");
      if (!names.length) { status(batchStatus, "没有可测试的主机", true); return; }
      status(batchStatus, "正在测试 " + names.length + " 台主机…");
      batchButton.disabled = true;
      api("POST", "/api/settings/hosts/test-batch", { names: names })
        .then(function (result) {
          var results = result.results || [];
          var okCount = results.filter(function (item) { return item.ok; }).length;
          var failed = results.filter(function (item) { return !item.ok; })
            .map(function (item) { return item.name + "：" + (item.detail || "失败"); });
          var text = "成功 " + okCount + "/" + results.length;
          if (failed.length) text += "；失败 " + failed.join("；");
          status(batchStatus, text, failed.length > 0);
        })
        .catch(function (error) { status(batchStatus, error.message, true); })
        .finally(function () { batchButton.disabled = !writable; });
    });
  }

  // -- batch import -------------------------------------------------------
  var importDialog = qs("#import-dialog");
  var importStatus = qs("#import-status");
  var importSummary = qs("#import-preview-summary");
  var importText = qs("#import-text");
  var importFormat = qs("#import-format");
  var importPreview = null;

  function clearChildren(el) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
  }
  function cell(text) {
    var td = document.createElement("td");
    td.textContent = text === undefined || text === null ? "" : String(text);
    return td;
  }
  function addPreviewRow(body, category, candidate, note) {
    var tr = document.createElement("tr");
    if (category === "无效") tr.className = "import-row-invalid";
    if (category === "重复") tr.className = "import-row-duplicate";
    tr.appendChild(cell(category));
    tr.appendChild(cell(candidate.name || ""));
    tr.appendChild(cell(candidate.host || ""));
    tr.appendChild(cell(candidate.username || ""));
    tr.appendChild(cell(candidate.group || ""));
    tr.appendChild(cell(note || ""));
    body.appendChild(tr);
  }
  function renderPreview(preview) {
    var validBody = qs("#import-valid-body");
    var invalidBody = qs("#import-invalid-body");
    var duplicateBody = qs("#import-duplicate-body");
    clearChildren(validBody);
    clearChildren(invalidBody);
    clearChildren(duplicateBody);
    var candidates = (preview && preview.candidates) || [];
    var existing = {};
    (initial.hosts || []).forEach(function (host) { existing[host.name] = true; });
    var seen = {};
    var validCount = 0;
    var invalidCount = 0;
    var duplicateCount = 0;
    candidates.forEach(function (candidate) {
      var name = candidate.name || "";
      if (candidate.valid === false) {
        invalidCount += 1;
        addPreviewRow(invalidBody, "无效", candidate, candidate.error || "校验失败");
        return;
      }
      var duplicate = !!existing[name] || !!seen[name];
      seen[name] = true;
      if (duplicate) {
        duplicateCount += 1;
        addPreviewRow(duplicateBody, "重复", candidate, existing[name] ? "已存在同名主机" : "导入内容内重复");
        return;
      }
      validCount += 1;
      addPreviewRow(validBody, "有效", candidate, (candidate.warnings || []).join("；"));
    });
    var parseErrors = (preview && preview.errors && preview.errors.length) || 0;
    importSummary.textContent = "有效 " + validCount + " 台，无效 " + invalidCount +
      " 台，重复 " + duplicateCount + " 台" + (parseErrors ? "；解析错误 " + parseErrors + " 条" : "");
    var confirmButton = qs("#import-confirm-button");
    if (confirmButton) confirmButton.disabled = candidates.length === 0;
  }
  function importRequest() {
    return { format: importFormat.value, content: importText.value };
  }
  if (importDialog) {
    qs("#import-open-button").addEventListener("click", function () {
      if (importDialog.showModal) importDialog.showModal();
      else importDialog.setAttribute("open", "");
    });
    qs("#import-close-button").addEventListener("click", function () {
      if (importDialog.close) importDialog.close();
      else importDialog.removeAttribute("open");
    });
    qs("#import-file").addEventListener("change", function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var bytes = new Uint8Array(reader.result || new ArrayBuffer(0));
        var text = null;
        try {
          // fatal: strict UTF-8 wins when valid; the decoder strips a UTF-8 BOM.
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch (utf8Error) {
          try {
            // Legacy Windows exports are commonly GBK/GB18030.
            text = new TextDecoder("gb18030").decode(bytes);
          } catch (gbkError) {
            status(importStatus, "无法识别文件编码（支持 UTF-8 / GB18030）", true);
            return;
          }
        }
        importText.value = text;
      };
      reader.onerror = function () { status(importStatus, "读取文件失败", true); };
      reader.readAsArrayBuffer(file);
    });
    qs("#import-preview-button").addEventListener("click", function () {
      if (!importText.value.trim()) { status(importStatus, "请先粘贴或选择文件内容", true); return; }
      status(importStatus, "正在解析…");
      api("POST", "/api/settings/hosts/import/preview", importRequest())
        .then(function (payload) {
          importPreview = payload;
          renderPreview(payload);
          status(importStatus, "解析完成", false);
        })
        .catch(function (error) { status(importStatus, error.message, true); });
    });
    qs("#import-confirm-button").addEventListener("click", function () {
      if (!importPreview) { status(importStatus, "请先预览", true); return; }
      var body = importRequest();
      body.overwrite = qs("#import-overwrite").checked;
      status(importStatus, "正在导入…");
      api("POST", "/api/settings/hosts/import", body)
        .then(function (result) {
          var text = "创建 " + (result.created || []).length + " 台，更新 " +
            (result.updated || []).length + " 台，跳过 " + (result.skipped || []).length +
            " 台，失败 " + (result.failed || []).length + " 台";
          status(importStatus, text, (result.failed || []).length > 0);
          // 采集在后台跑，导入完直接回主机列表，不在这里等采集结束。
          var importedNames = (result.created || []).concat(result.updated || []);
          toast(importedNames.length
            ? "已导入 " + importedNames.length + " 台主机，正在后台采集数据…"
            : "导入完成");
          var importDialog = qs("#import-dialog");
          if (importDialog && typeof importDialog.close === "function") { importDialog.close(); }
          window.setTimeout(reloadToHosts, 700);
        })
        .catch(function (error) { status(importStatus, error.message, true); });
    });
  }

  // -- alert silences -----------------------------------------------------
  var silenceScopeType = qs("#silence-scope-type");
  var silenceScope = qs("#silence-scope");
  var silenceStatus = qs("#silence-status");

  function localInputValue(date) {
    function pad(value) { return (value < 10 ? "0" : "") + value; }
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
      "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }
  function toIso(value) { return value ? new Date(value).toISOString() : null; }
  function scopeLabel(type) {
    if (type === "all") return "全部";
    return type === "group" ? "分组" : "主机";
  }
  function updateSilenceScope() {
    var isAll = silenceScopeType.value === "all";
    silenceScope.disabled = isAll;
    if (isAll) silenceScope.value = "";
  }
  function renderSilences(silences) {
    var body = qs("#silence-list");
    clearChildren(body);
    if (!silences || !silences.length) {
      var emptyRow = document.createElement("tr");
      var emptyCell = cell("当前没有生效的静默");
      emptyCell.colSpan = 6;
      emptyCell.className = "empty-cell";
      emptyRow.appendChild(emptyCell);
      body.appendChild(emptyRow);
      return;
    }
    silences.forEach(function (silence) {
      var tr = document.createElement("tr");
      tr.appendChild(cell(scopeLabel(silence.scope_type)));
      tr.appendChild(cell(silence.scope || "全部"));
      tr.appendChild(cell(silence.reason || ""));
      tr.appendChild(cell(silence.starts_at ? new Date(silence.starts_at).toLocaleString() : ""));
      tr.appendChild(cell(silence.ends_at ? new Date(silence.ends_at).toLocaleString() : ""));
      var actions = document.createElement("td");
      var button = document.createElement("button");
      button.className = "danger-button";
      button.textContent = "解除";
      button.disabled = !writable;
      button.addEventListener("click", function () {
        if (!window.confirm("确定解除这条静默吗？")) return;
        api("DELETE", "/api/settings/silences/" + encodeURIComponent(silence.id))
          .then(loadSilences)
          .catch(function (error) { status(silenceStatus, error.message, true); });
      });
      actions.appendChild(button);
      tr.appendChild(actions);
      body.appendChild(tr);
    });
  }
  function loadSilences() {
    return api("GET", "/api/settings/silences?active_only=true")
      .then(function (payload) { renderSilences(payload.silences || []); })
      .catch(function (error) { status(silenceStatus, error.message, true); });
  }
  if (silenceScopeType) {
    updateSilenceScope();
    silenceScopeType.addEventListener("change", updateSilenceScope);
    var now = new Date();
    qs("#silence-starts-at").value = localInputValue(now);
    qs("#silence-ends-at").value = localInputValue(new Date(now.getTime() + 60 * 60 * 1000));
    qs("#silence-refresh-button").addEventListener("click", loadSilences);
    qs("#silence-create-button").addEventListener("click", function () {
      var payload = {
        scope_type: silenceScopeType.value,
        scope: silenceScopeType.value === "all" ? null : silenceScope.value.trim(),
        reason: qs("#silence-reason").value.trim(),
        starts_at: toIso(qs("#silence-starts-at").value),
        ends_at: toIso(qs("#silence-ends-at").value),
      };
      status(silenceStatus, "正在创建…");
      api("POST", "/api/settings/silences", payload)
        .then(function () { status(silenceStatus, "已创建静默", false); return loadSilences(); })
        .catch(function (error) { status(silenceStatus, error.message, true); });
    });
    renderSilences(window.__SETTINGS_SILENCES__ || []);
    loadSilences();
  }

  // -- logs ---------------------------------------------------------------
  var logsOutput = qs("#logs-output");
  function refreshLogs() {
    var logsStatus = qs("#logs-status");
    status(logsStatus, "正在加载…");
    api("GET", "/api/logs?lines=300")
      .then(function (payload) {
        var text = (payload && (payload.text || payload.lines)) || "";
        logsOutput.textContent = text || "（暂无日志）";
        status(logsStatus, "已加载 " + ((payload && payload.line_count) || 0) + " 行", false);
      })
      .catch(function (error) { status(logsStatus, error.message, true); });
  }
  if (logsOutput) {
    qs("#logs-refresh-button").addEventListener("click", refreshLogs);
    refreshLogs();
  }
  var runtimeInfo = qs("#runtime-info");
  var runtime = window.__SETTINGS_RUNTIME__ || {};
  if (runtimeInfo) {
    runtimeInfo.textContent = runtime.url
      ? "运行地址 " + runtime.url + (runtime.pid ? "（PID " + runtime.pid + "）" : "")
      : "未检测到运行状态";
  }

  // Fill any values that were not rendered server-side (e.g. list edits).
  fillSection("monitoring", initial.monitoring);
  fillSection("ssh", initial.ssh);
  fillSection("smtp", initial.smtp);
  fillSection("alerts", initial.alerts);
  fillSection("report", initial.report);
  fillSection("disk_health", initial.disk_health);
  fillSection("user_monitoring", initial.user_monitoring);
  fillSection("dashboard", initial.dashboard);
})();
