(() => {
  "use strict";

  const bridge = window.desktopBridge;
  const checkButton = document.getElementById("update-check-button");
  if (!checkButton) return;
  const status = document.getElementById("update-status");
  const resultBox = document.getElementById("update-result");
  const summary = document.getElementById("update-summary");
  const notes = document.getElementById("update-notes");
  const downloadButton = document.getElementById("update-download-button");
  const installButton = document.getElementById("update-install-button");
  let pending = null;

  function setStatus(message, isError = false) {
    status.textContent = message || "";
    status.classList.toggle("text-error", Boolean(isError));
  }

  function showResult(update) {
    pending = update;
    resultBox.hidden = false;
    summary.textContent = `新版本 v${update.version}（当前 v${update.current_version}）`;
    notes.textContent = update.notes || "（无更新说明）";
    downloadButton.disabled = false;
    installButton.disabled = true;
  }

  async function check() {
    if (!bridge || !bridge.checkForUpdate) {
      setStatus("自动更新仅在桌面客户端中可用", true);
      return;
    }
    checkButton.disabled = true;
    setStatus("正在检查更新…");
    try {
      const response = await bridge.checkForUpdate(true);
      if (!response || !response.ok) {
        setStatus((response && response.error) || "检查更新失败", true);
        return;
      }
      const update = response.result || {};
      if (update.status === "update-available") {
        showResult(update);
        setStatus("发现新版本");
      } else if (update.status === "up-to-date") {
        resultBox.hidden = true;
        setStatus("已是最新版本");
      } else if (update.status === "skipped") {
        setStatus(update.message || "GitHub 请求受限，请稍后再试");
      } else {
        setStatus(update.message || "检查更新失败", true);
      }
    } catch (error) {
      setStatus(`检查更新失败：${error.message || error}`, true);
    } finally {
      checkButton.disabled = false;
    }
  }

  async function download() {
    if (!pending) return;
    downloadButton.disabled = true;
    setStatus("正在下载并校验更新包…");
    try {
      const response = await bridge.downloadUpdate(pending);
      if (!response || !response.ok) {
        setStatus((response && response.error) || "下载失败", true);
        downloadButton.disabled = false;
        return;
      }
      installButton.disabled = false;
      setStatus("更新包已下载并校验，可以安装");
    } catch (error) {
      setStatus(`下载失败：${error.message || error}`, true);
      downloadButton.disabled = false;
    }
  }

  function install() {
    if (!pending) return;
    if (!window.confirm("安装更新会关闭当前客户端并自动重新启动，确定继续吗？")) return;
    installButton.disabled = true;
    setStatus("正在安装更新，程序即将重启…");
    bridge.installUpdate(pending).then((response) => {
      if (response && response.ok === false) {
        setStatus(response.error || "安装失败", true);
        installButton.disabled = false;
      }
    });
  }

  checkButton.addEventListener("click", check);
  downloadButton.addEventListener("click", download);
  installButton.addEventListener("click", install);

  if (bridge && bridge.onUpdateStatus) {
    bridge.onUpdateStatus((payload) => {
      if (!payload) return;
      if (payload.state === "checking") setStatus("正在检查更新…");
      if (payload.state === "downloading") setStatus("正在下载更新包…");
      if (payload.state === "downloaded") setStatus("更新包已下载并校验");
    });
  }
})();
