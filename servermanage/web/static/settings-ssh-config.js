(() => {
  "use strict";

  const openButton = document.getElementById("ssh-config-open-button");
  if (!openButton) return;
  const dialog = document.getElementById("ssh-config-dialog");
  const body = document.getElementById("ssh-config-body");
  const pathText = document.getElementById("ssh-config-path");
  const status = document.getElementById("ssh-config-status");
  const selectAll = document.getElementById("ssh-config-select-all");
  const importButton = document.getElementById("ssh-config-import-button");
  const overwrite = document.getElementById("ssh-config-overwrite");
  const closeButton = document.getElementById("ssh-config-close-button");

  function csrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : "";
  }

  function setStatus(message, isError = false) {
    status.textContent = message || "";
    status.classList.toggle("text-error", Boolean(isError));
  }

  function cell(text, className) {
    const td = document.createElement("td");
    if (className) td.className = className;
    td.textContent = text == null ? "" : String(text);
    return td;
  }

  function candidateRow(candidate) {
    const tr = document.createElement("tr");
    const checkCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.sshConfigName = candidate.name;
    checkbox.checked = candidate.valid !== false;
    checkbox.disabled = candidate.valid === false;
    checkCell.appendChild(checkbox);
    tr.appendChild(checkCell);
    tr.appendChild(cell(candidate.name, "mono"));
    tr.appendChild(cell(candidate.host, "mono"));
    tr.appendChild(cell(candidate.port));
    tr.appendChild(cell(candidate.username || "（需补用户名）"));
    tr.appendChild(cell(candidate.key_path ? "已找到" : "（待补私钥）"));
    const warningText = (candidate.warnings || []).join("；");
    tr.appendChild(cell(candidate.error || warningText || (candidate.valid === false ? "配置无效" : "可导入")));
    return tr;
  }

  async function loadCandidates() {
    setStatus("正在读取 ~/.ssh/config …");
    body.replaceChildren();
    try {
      const response = await fetch("/api/settings/hosts/ssh-config", {
        credentials: "same-origin",
      });
      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }
      const payload = await response.json();
      pathText.textContent = payload.exists
        ? `读取自 ${payload.path}（用户名默认 ${payload.default_username}）`
        : `未找到 ${payload.path}`;
      const candidates = payload.candidates || [];
      candidates.forEach((candidate) => body.appendChild(candidateRow(candidate)));
      if (!candidates.length) {
        const row = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 7;
        td.className = "empty-cell";
        td.textContent = payload.exists ? "配置文件中没有可导入的主机" : "未找到 ~/.ssh/config";
        row.appendChild(td);
        body.appendChild(row);
      }
      if (payload.warnings && payload.warnings.length) {
        setStatus(payload.warnings.join("；"));
      } else {
        setStatus(`发现 ${candidates.length} 个主机，请勾选要监控的主机`);
      }
    } catch (error) {
      setStatus(`读取失败：${error.message || error}`, true);
    }
  }

  async function importSelected() {
    const selected = Array.from(
      body.querySelectorAll('input[type="checkbox"][data-ssh-config-name]:checked')
    ).map((item) => item.dataset.sshConfigName);
    if (!selected.length) {
      setStatus("请至少选择一台主机", true);
      return;
    }
    importButton.disabled = true;
    setStatus("正在导入…");
    try {
      const response = await fetch("/api/settings/hosts/ssh-config/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken(),
        },
        credentials: "same-origin",
        body: JSON.stringify({ names: selected, overwrite: Boolean(overwrite.checked) }),
      });
      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }
      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        setStatus(payload.error || "导入失败", true);
        return;
      }
      const parts = [];
      if (payload.created && payload.created.length) parts.push(`新增 ${payload.created.length} 台`);
      if (payload.updated && payload.updated.length) parts.push(`更新 ${payload.updated.length} 台`);
      if (payload.skipped && payload.skipped.length) parts.push(`跳过 ${payload.skipped.length} 台`);
      if (payload.failed && payload.failed.length) parts.push(`失败 ${payload.failed.length} 台`);
      setStatus(`导入完成：${parts.join("，") || "无变化"}`);
      window.location.reload();
    } catch (error) {
      setStatus(`导入失败：${error.message || error}`, true);
    } finally {
      importButton.disabled = false;
    }
  }

  openButton.addEventListener("click", () => {
    dialog.showModal();
    loadCandidates();
  });
  closeButton.addEventListener("click", () => dialog.close());
  selectAll.addEventListener("change", () => {
    body
      .querySelectorAll('input[type="checkbox"][data-ssh-config-name]:not(:disabled)')
      .forEach((item) => {
        item.checked = selectAll.checked;
      });
  });
  importButton.addEventListener("click", importSelected);
})();
