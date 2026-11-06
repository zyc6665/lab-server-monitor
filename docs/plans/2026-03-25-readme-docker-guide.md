# README Docker Guide Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite the README into a Docker-first beginner deployment guide for this server monitoring tool.

**Architecture:** Keep the document focused on the actual runtime path: edit `config.yaml`, edit `.env`, mount `ssh/`, run `docker compose`, inspect logs, and tune `CRON_SCHEDULE`. Avoid mixing local Python deployment into the main path so the guide stays linear and beginner-friendly.

**Tech Stack:** Markdown, Docker Compose, existing project config files

---

### Task 1: Restructure README around a step-by-step Docker flow

**Files:**
- Modify: `README.md`

**Step 1: Review the existing README sections**

Check which sections are still useful:

- project summary
- Docker files already present
- config examples
- cron schedule explanation

**Step 2: Remove non-essential detours**

Move local Python usage out of the main path and keep Docker as the primary deployment method.

**Step 3: Write the beginner flow**

Write a single linear flow:

1. prerequisites
2. prepare files
3. edit `config.yaml`
4. edit `.env`
5. start container
6. inspect logs
7. adjust schedule
8. troubleshoot

**Step 4: Verify the README covers the intended flow**

Run:

```bash
rg -n "第 1 步|config.yaml|\\.env|docker compose up -d --build|docker compose logs -f servermanage|CRON_SCHEDULE" "README.md"
```

Expected: all key steps are present

### Task 2: Add explicit configuration guidance for password and key auth

**Files:**
- Modify: `README.md`

**Step 1: Add examples that map directly to `config.yaml.example`**

Explain:

- `smtp.to_addrs`
- password auth with `password_env`
- key auth with `/app/ssh/id_rsa`

**Step 2: Add explicit `.env` guidance**

Explain what each variable should contain and keep secrets out of the repo.

**Step 3: Verify the README covers both auth modes**

Run:

```bash
rg -n "password_env|/app/ssh/id_rsa|SMTP_PASSWORD|PROD_GPU_01_SSH_PASSWORD|to_addrs" "README.md"
```

Expected: all key config terms are present

### Task 3: Add deployment verification and troubleshooting steps

**Files:**
- Modify: `README.md`

**Step 1: Add clear success checks**

Document:

- `docker compose ps`
- `docker compose logs -f servermanage`
- what successful startup should look like

**Step 2: Add common failure cases**

Cover:

- SMTP auth failure
- SSH login failure
- private key path error
- mail not received

**Step 3: Verify the troubleshooting coverage**

Run:

```bash
rg -n "docker compose ps|SMTP|SSH|私钥|收不到邮件" "README.md"
```

Expected: all troubleshooting anchors are present
