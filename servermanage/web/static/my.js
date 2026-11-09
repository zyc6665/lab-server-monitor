(function () {
  "use strict";

  var REFRESH_MS = 30000;
  var STATE_LABELS = { present: "账号正常", missing: "账号缺失" };
  var HOST_LABELS = { ok: "已采集", unknown: "尚未采集", error: "采集失败", disabled: "未启用" };
  var ISSUE_LABELS = {
    missing: "服务器上已找不到该账号",
    docker: "不在 docker 组，无法使用容器",
    "home-missing": "家目录不存在",
    "home-owner": "家目录所有者不是本人",
    "data-missing": "/data 目录不存在",
    "data-owner": "/data 所有者不是本人",
    "data-unsupported": "该主机没有 /data 目录"
  };

  var memberEl = document.querySelector(".my-member");
  var hintEl = document.getElementById("my-hint");
  var statsEl = document.getElementById("my-stats");
  var listEl = document.getElementById("my-host-list");
  var emptyEl = document.getElementById("my-empty");
  var countEl = document.getElementById("my-host-count");
  var refreshButton = document.getElementById("my-refresh");
  var updatedEl = document.getElementById("my-updated");
  var retryButton = document.getElementById("my-retry");

  function formatBytes(value) {
    if (value === null || value === undefined || isNaN(value)) {
      return "—";
    }
    var size = Number(value);
    if (size <= 0) {
      return "0 B";
    }
    var units = ["B", "KB", "MB", "GB", "TB"];
    var index = Math.floor(Math.log(size) / Math.log(1024));
    index = Math.max(0, Math.min(units.length - 1, index));
    var scaled = size / Math.pow(1024, index);
    return (index === 0 ? scaled.toFixed(0) : scaled.toFixed(1)) + " " + units[index];
  }

  function issueLabel(code) {
    return ISSUE_LABELS[code] || code;
  }

  function badge(text, tone) {
    var span = document.createElement("span");
    span.className = "my-badge" + (tone ? " my-badge-" + tone : "");
    span.textContent = text;
    return span;
  }

  function usageBar(label, bytes, readable) {
    var row = document.createElement("div");
    row.className = "my-usage";
    var head = document.createElement("div");
    head.className = "my-usage-head";
    var name = document.createElement("span");
    name.textContent = label;
    var value = document.createElement("strong");
    value.textContent = readable === false ? "无权限读取" : formatBytes(bytes);
    head.appendChild(name);
    head.appendChild(value);
    row.appendChild(head);
    return row;
  }

  function buildHostCard(host) {
    var account = host.account || {};
    var card = document.createElement("article");
    card.className = "my-host-card";
    if (host.status === "error") {
      card.className += " has-error";
    }
    if (account.state === "missing" || (account.issues && account.issues.length)) {
      card.className += " has-issues";
    }

    var header = document.createElement("div");
    header.className = "my-host-head";
    var nameWrap = document.createElement("div");
    var name = document.createElement("h3");
    name.className = "my-host-name";
    name.textContent = host.name || "";
    var address = document.createElement("p");
    address.className = "my-host-address";
    address.textContent = host.address || "";
    nameWrap.appendChild(name);
    nameWrap.appendChild(address);
    header.appendChild(nameWrap);

    var badges = document.createElement("div");
    badges.className = "my-badges";
    badges.appendChild(
      badge(HOST_LABELS[host.status] || host.status || "未知", host.status === "ok" ? "ok" : "warn")
    );
    badges.appendChild(
      badge(STATE_LABELS[account.state] || account.state || "未知", account.state === "present" ? "ok" : "danger")
    );
    if (account.in_docker === true) {
      badges.appendChild(badge("docker", "ok"));
    } else if (account.in_docker === false) {
      badges.appendChild(badge("不在 docker 组", "danger"));
    }
    if (account.in_sudo === true) {
      badges.appendChild(badge("sudo", "ok"));
    }
    header.appendChild(badges);
    card.appendChild(header);

    var meta = document.createElement("p");
    meta.className = "my-host-meta";
    var bits = [];
    if (account.uid !== null && account.uid !== undefined) {
      bits.push("UID " + account.uid);
    }
    if (account.primary_group) {
      bits.push("主组 " + account.primary_group);
    }
    if (account.home) {
      bits.push(account.home);
    }
    if (host.last_scan_at) {
      bits.push("采集于 " + host.last_scan_at);
    }
    meta.textContent = bits.join(" · ");
    card.appendChild(meta);

    if (host.last_error) {
      var error = document.createElement("p");
      error.className = "my-host-error";
      error.textContent = "采集失败：" + host.last_error;
      card.appendChild(error);
    }

    var usages = document.createElement("div");
    usages.className = "my-usages";
    usages.appendChild(usageBar("家目录占用", account.home_size_bytes, account.usage_readable));
    usages.appendChild(usageBar("/data 占用", account.data_size_bytes, account.usage_readable));
    card.appendChild(usages);

    if (account.usage_stale) {
      var stale = document.createElement("p");
      stale.className = "my-host-meta";
      stale.textContent = "占用数据稍旧，等待下一次采集";
      card.appendChild(stale);
    }

    var issues = (account.issues || []).filter(function (code) {
      return code !== "missing" || account.state === "missing";
    });
    if (issues.length) {
      var list = document.createElement("ul");
      list.className = "my-issues";
      issues.forEach(function (code) {
        var item = document.createElement("li");
        item.textContent = issueLabel(code);
        list.appendChild(item);
      });
      card.appendChild(list);
    }

    return card;
  }

  function render(payload) {
    var hosts = payload.hosts || [];
    var summary = payload.summary || {};
    if (memberEl && payload.member) {
      memberEl.textContent = payload.member;
    }
    if (statsEl) {
      statsEl.hidden = !hosts.length;
      document.getElementById("my-stat-hosts").textContent = summary.hosts || 0;
      document.getElementById("my-stat-present").textContent = summary.present || 0;
      document.getElementById("my-stat-missing").textContent = summary.missing || 0;
      document.getElementById("my-stat-issues").textContent = summary.issues || 0;
      document.getElementById("my-stat-home").textContent = formatBytes(summary.home_bytes || 0);
      document.getElementById("my-stat-data").textContent = formatBytes(summary.data_bytes || 0);
    }
    if (hintEl) {
      hintEl.textContent = hosts.length
        ? "以下服务器上存在你的账号，数据每 30 秒刷新"
        : "没有找到你的账号";
    }
    if (countEl) {
      countEl.textContent = hosts.length ? "共 " + hosts.length + " 台主机" : "";
    }
    if (!listEl) {
      return;
    }
    listEl.textContent = "";
    hosts.forEach(function (host) {
      listEl.appendChild(buildHostCard(host));
    });
    if (emptyEl) {
      emptyEl.hidden = hosts.length > 0;
      if (!hosts.length) {
        emptyEl.textContent = payload.member
          ? "在已配置的服务器上没有找到账号“" + payload.member + "”。请确认设置里的账号名是否写错；如果服务器是刚添加的，等一轮用户采集完成后再刷新。"
          : "还没有填写你的服务器账号名，请到设置里填写。";
      }
    }
  }

  function stamp() {
    if (!updatedEl) {
      return;
    }
    var now = new Date();
    var pad = function (value) {
      return value < 10 ? "0" + value : String(value);
    };
    updatedEl.textContent = "最近刷新 " + pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
  }

  function load() {
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.textContent = "刷新中…";
    }
    if (retryButton) {
      retryButton.hidden = true;
    }
    return fetch("/api/my/summary", { headers: { Accept: "application/json" } })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        return response.json();
      })
      .then(function (payload) {
        render(payload);
        stamp();
      })
      .catch(function (error) {
        if (hintEl) {
          hintEl.textContent = "读取失败：" + error.message + "，稍后会自动重试。";
        }
        if (retryButton) {
          retryButton.hidden = false;
        }
      })
      .then(function () {
        if (refreshButton) {
          refreshButton.disabled = false;
          refreshButton.textContent = "刷新";
        }
      });
  }

  if (refreshButton) {
    refreshButton.addEventListener("click", load);
  }
  if (retryButton) {
    retryButton.addEventListener("click", load);
  }
  load();
  window.setInterval(function () {
    if (!document.hidden) {
      load();
    }
  }, REFRESH_MS);
})();
