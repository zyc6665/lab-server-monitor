(function () {
  "use strict";

  var root = document.getElementById("settings-user-root");
  if (!root) {
    return;
  }
  var csrf = root.getAttribute("data-csrf") || "";
  var memberInput = document.getElementById("user-mode-member");
  var saveButton = document.getElementById("user-mode-save");
  var switchButton = document.getElementById("user-mode-switch");
  var status = document.getElementById("user-mode-status");

  function setStatus(text, tone) {
    if (!status) {
      return;
    }
    status.textContent = text || "";
    status.className = "form-status" + (tone ? " " + tone : "");
  }

  function saveMode(mode, member) {
    return fetch("/api/settings/monitoring", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf
      },
      body: JSON.stringify({ mode: mode, member_account: member })
    }).then(function (response) {
      return response
        .json()
        .catch(function () {
          return null;
        })
        .then(function (body) {
          if (!response.ok) {
            var message = (body && body.error) || "HTTP " + response.status;
            throw new Error(message);
          }
          return body;
        });
    });
  }

  if (saveButton) {
    saveButton.addEventListener("click", function () {
      var member = (memberInput && memberInput.value ? memberInput.value : "").trim();
      if (!member) {
        setStatus("请填写你的服务器账号名", "error");
        return;
      }
      saveButton.disabled = true;
      setStatus("保存中…");
      saveMode("user", member)
        .then(function () {
          setStatus("已保存，正在刷新…", "success");
          window.location.reload();
        })
        .catch(function (error) {
          setStatus("保存失败：" + error.message, "error");
          saveButton.disabled = false;
        });
    });
  }

  if (switchButton) {
    switchButton.addEventListener("click", function () {
      var member = (memberInput && memberInput.value ? memberInput.value : "").trim();
      switchButton.disabled = true;
      setStatus("正在切换到管理员模式…");
      saveMode("admin", member)
        .then(function () {
          window.location.href = "/";
        })
        .catch(function (error) {
          setStatus("切换失败：" + error.message, "error");
          switchButton.disabled = false;
        });
    });
  }
})();
