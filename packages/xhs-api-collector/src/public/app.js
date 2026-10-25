const $ = (id) => document.getElementById(id);
let state = null;
let operations = null;
let noticeTimer;

const messages = {
  PASSWORD_LENGTH_INVALID: "密码至少 12 位、最多 128 位。",
  PASSWORD_INCORRECT: "密码不正确，请重试。",
  TOKEN_FORMAT_INVALID: "Token 格式不符合要求，请复制完整的 Authorization Token。",
  TOKEN_MISSING: "请先保存供应商 Token。",
  PROVIDER_ENDPOINT_MISSING: "请先保存供应商 API 地址。",
  PROVIDER_ENDPOINT_INVALID: "请填写完整的公开 HTTPS 接口地址，不要包含密钥。",
  PROVIDER_TOKEN_INVALID: "Token 格式不符合要求，请复制完整的 Authorization Token。",
  PROVIDER_CONFIGURATION_CHANGED: "供应商配置已变更，本次结果不作为验收依据。请重新测试。",
  SUCCESSFUL_SAMPLE_REQUIRED: "请先完成一次成功的真实笔记样本验收。",
  PROBE_DAILY_LIMIT: "今天的 3 次人工测试额度已用完。",
  PROBE_ALREADY_RUNNING: "正在测试上一条笔记，请稍候。",
  PAID_PROBE_CONFIRMATION_REQUIRED: "请确认本次查询可能产生费用。",
  NOTE_LINK_INVALID: "笔记链接格式无效。",
  NOTE_LINK_UNSUPPORTED: "目前仅支持完整的小红书笔记链接或笔记 ID。",
  NOTE_ID_REQUIRED: "链接中没有可识别的笔记 ID。短链暂不支持测试。",
  ORIGIN_REQUIRED: "请求来源未通过验证，请使用本页重新操作。",
  TOO_MANY_ATTEMPTS: "尝试次数过多，请 15 分钟后再试。",
  SETUP_DEVICE_NOT_ALLOWED: "当前设备不在初始化允许列表中，请联系部署者调整配置。",
  SERVICE_UNAVAILABLE: "节点或主服务暂时不可用，请稍后刷新。",
};

function notice(message, error = false) {
  const element = $("notice");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    element.hidden = true;
  }, 6500);
}

async function api(path, payload, needsSession = true) {
  const options =
    payload === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(needsSession && state?.csrf ? { "x-panel-csrf": state.csrf } : {}),
          },
          body: JSON.stringify(payload),
        };
  const response = await fetch(`/api/${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("SERVICE_UNAVAILABLE");
  }
  if (!response.ok) {
    if (response.status === 401 && needsSession) await loadState();
    throw new Error(result.error || "SERVICE_UNAVAILABLE");
  }
  return result;
}

async function loadState() {
  state = await api("state", undefined, false);
  $("gate").hidden = Boolean(state.authenticated);
  $("dashboard").hidden = !state.authenticated;
  $("setupView").hidden = !state.setupRequired || !state.setupAllowed;
  $("setupBlocked").hidden = !state.setupRequired || state.setupAllowed;
  $("loginView").hidden = state.setupRequired;
  if (state.authenticated) {
    renderSettings();
    await refreshOperations();
  }
}

function working(form, fn) {
  return async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      await fn();
    } catch (error) {
      notice(messages[error.message] || "操作未完成，请稍后重试。", true);
    } finally {
      button.disabled = false;
    }
  };
}

$("setupForm").addEventListener(
  "submit",
  working($("setupForm"), async () => {
    const password = $("setupPassword").value;
    if (password !== $("setupRepeat").value) throw new Error("两次输入的密码不一致");
    await api("setup", { password }, false);
    $("setupForm").reset();
    await loadState();
    notice("控制台密码已设置。现在可以配置供应商 API 地址与 Token。");
    activateTab("settings");
  }),
);

$("loginForm").addEventListener(
  "submit",
  working($("loginForm"), async () => {
    await api("login", { password: $("loginPassword").value }, false);
    $("loginForm").reset();
    await loadState();
  }),
);

$("tokenForm").addEventListener(
  "submit",
  working($("tokenForm"), async () => {
    const token = $("vendorToken").value.trim();
    await api("provider", {
      endpoint: $("vendorEndpoint").value.trim(),
      ...(token ? { token } : {}),
    });
    $("tokenForm").reset();
    $("probeResult").textContent = "";
    await loadState();
    notice("接口配置已保存。地址或 Token 变更后，需重新验收样本再启用节点。");
  }),
);

$("probeForm").addEventListener(
  "submit",
  working($("probeForm"), async () => {
    $("probeResult").textContent = "正在查询供应商，请等待结果…";
    const result = await api("probe", {
      link: $("probeLink").value,
      confirmed: $("probeConfirmed").checked,
    });
    $("probeForm").reset();
    if (result.status === "AVAILABLE") {
      const value = (v) => (v === null ? "未提供" : String(v));
      $("probeResult").textContent =
        `查询成功 · 标题${result.titlePresent ? "有" : "无"} · 正文${result.bodyPresent ? "有" : "无"} · 点赞 ${value(result.metrics.likes)} · 评论 ${value(result.metrics.comments)} · 收藏 ${value(result.metrics.favorites)}`;
      notice("样本回读成功。请核对数值和供应商账单。");
    } else {
      $("probeResult").textContent =
        `本次未取得可靠笔记：${result.status}（${result.code}）。不会据此否定员工提交。`;
    }
    await loadState();
  }),
);

$("passwordForm").addEventListener(
  "submit",
  working($("passwordForm"), async () => {
    await api("password", {
      currentPassword: $("oldPassword").value,
      newPassword: $("newPassword").value,
    });
    $("passwordForm").reset();
    await loadState();
    notice("密码已更新，旧会话已退出。");
  }),
);

$("toggleWorker").addEventListener("click", async () => {
  const button = $("toggleWorker");
  button.disabled = true;
  try {
    await api("worker", { enabled: !state.workerEnabled });
    await loadState();
    notice(
      state.workerEnabled
        ? "节点已启用；主服务若暂停，节点将保持待命。"
        : "节点将在当前任务结束后暂停。",
    );
  } catch (error) {
    notice(messages[error.message] || "切换失败。", true);
  } finally {
    button.disabled = !state?.workerEnabled && !(providerConfigured() && state?.probe?.verifiedAt);
  }
});

$("logoutButton").addEventListener("click", async () => {
  try {
    await api("logout", {});
    await loadState();
  } catch {
    notice("退出失败，请刷新重试。", true);
  }
});
$("refreshButton").addEventListener("click", async () => {
  await refreshOperations(true);
});
$("goSettings").addEventListener("click", () => activateTab("settings"));
$("historyFilter").addEventListener("change", renderHistory);
for (const tab of document.querySelectorAll(".tab"))
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));

function activateTab(next) {
  for (const tab of document.querySelectorAll(".tab")) {
    const selected = tab.dataset.tab === next;
    tab.classList.toggle("active", selected);
    if (selected) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  for (const name of ["overview", "history", "settings"]) $(`${name}Tab`).hidden = name !== next;
}

function providerConfigured() {
  return Boolean(state?.endpointConfigured && state?.tokenConfigured);
}

function renderSettings() {
  $("vendorEndpoint").value = state.endpoint || "";
  $("vendorToken").required = !state.tokenConfigured;
  $("tokenState").textContent = providerConfigured()
    ? "接口地址与 Token 已配置。Token 留空保留原值；变更配置会暂停节点并要求重新验收。"
    : state.tokenConfigured
      ? "Token 已保留，请手动补充供应商 API 地址后重新验收。"
      : "请自行选择兼容的供应商，填写 API 地址与 Token；系统没有预设供应商。";
  const verified = providerConfigured() && Boolean(state.probe?.verifiedAt);
  $("workerState").textContent = state.workerEnabled
    ? "节点已启用。主服务暂停时会待命，不会向供应商发起请求。"
    : verified
      ? "样本验收成功。启用后，节点会按主服务预算领取到期任务。"
      : "先配置供应商 API 地址与 Token，并完成一次成功的真实笔记验收。";
  $("toggleWorker").disabled = !state.workerEnabled && !verified;
  $("toggleWorker").textContent = state.workerEnabled ? "暂停节点" : "启用节点";
}

async function refreshOperations(force = false) {
  if (!state?.authenticated) return;
  $("refreshButton").disabled = true;
  try {
    operations = await api("operations");
    renderOperations();
    if (force) notice("任务状态已更新。");
  } catch {
    $("statusBanner").classList.add("warning");
    $("statusTitle").textContent = "主服务暂不可达";
    $("statusDetail").textContent = "现有数据暂时无法刷新；采集配置仍安全保存在节点。";
    if (!operations) {
      $("historyEmpty").textContent = "主服务暂不可达，任务记录尚无法读取。";
      $("historyEmpty").hidden = false;
    }
    if (force) notice("主服务连接失败，请稍后重试。", true);
  } finally {
    $("refreshButton").disabled = false;
  }
}

function renderOperations() {
  if (!operations) return;
  const paused = operations.paused;
  const localEnabled = state.workerEnabled;
  const title = !providerConfigured()
    ? "等待配置供应商接口"
    : !state.probe?.verifiedAt
      ? "等待真实样本验收"
      : !localEnabled
        ? "节点已暂停"
        : paused
          ? "主服务暂停，节点待命中"
          : "采集节点运行中";
  $("statusTitle").textContent = title;
  $("statusDetail").textContent = !providerConfigured()
    ? "请在节点设置中填写兼容协议的供应商 API 地址与 Token，然后验收一条真实笔记。"
    : paused
      ? "主服务尚未开启回读；不会领取任务或产生采集费用。"
      : localEnabled
        ? "到期工作单将按每日预算逐条领取。"
        : "您可以在节点设置中启用自动采集。";
  $("statusBanner").classList.toggle("warning", paused || !localEnabled);
  const todayUsed = operations.budget.find((item) => item.day === operations.today)?.used ?? 0;
  const probeUsed = state.probe?.day === operations.today ? state.probe.used : 0;
  $("statBudget").textContent = `${todayUsed} / ${operations.dailyLimit}`;
  $("statBudgetDetail").textContent = `另有 ${probeUsed} 次人工测试`;
  $("statCompleted").textContent = String(operations.completed);
  $("statQueued").textContent = `${operations.queued} / ${operations.retrying}`;
  $("statQueuedDetail").textContent =
    `${operations.leased} 正在处理 · ${operations.needsReview} 需复核`;
  $("statCost").textContent = `${todayUsed + probeUsed} 次`;
  $("nextStep").textContent = !providerConfigured()
    ? "填写自行选择的供应商 API 地址与 Token，先确认接口符合节点协议。"
    : !state.probe?.verifiedAt
      ? "使用有权核查的笔记做一次可计费测试；确认字段与余额后再启用节点。"
      : paused
        ? "节点准备就绪。主服务尚未开启回读，当前不会发生自动查询。"
        : "采集已按预算运行，可在任务记录中查看结果。";
  renderBudget();
  renderHistory();
}

function renderBudget() {
  const element = $("budgetBars");
  element.replaceChildren();
  const values = Array.from({ length: 14 }, (_, index) => {
    const day = new Date(`${operations.today}T00:00:00.000Z`);
    day.setUTCDate(day.getUTCDate() - 13 + index);
    const key = day.toISOString().slice(0, 10);
    return { day: key, used: operations.budget.find((item) => item.day === key)?.used ?? 0 };
  });
  const max = Math.max(1, ...values.map((item) => item.used));
  for (const item of values) {
    const column = document.createElement("div");
    column.className = "bar-column";
    const track = document.createElement("div");
    track.className = "bar-track";
    const bar = document.createElement("div");
    bar.className = "bar-fill";
    bar.classList.add(`level-${Math.max(0, Math.round((item.used / max) * 10))}`);
    track.title = `${item.day}：${item.used} 次`;
    track.append(bar);
    const date = document.createElement("label");
    date.textContent = item.day.slice(5).replace("-", "/");
    const used = document.createElement("b");
    used.textContent = item.used ? String(item.used) : "";
    column.append(track, date, used);
    element.append(column);
  }
}

function renderHistory() {
  if (!operations) return;
  $("historyEmpty").textContent =
    "当前没有符合条件的采集任务。新提交需要满 24 小时才会进入领取队列。";
  const tbody = $("historyRows");
  tbody.replaceChildren();
  const filter = $("historyFilter").value;
  const jobs = operations.jobs.filter((job) => filter === "all" || job.status === filter);
  $("historyEmpty").hidden = jobs.length !== 0;
  const labels = {
    COMPLETED: "已完成",
    QUEUED: "排队中",
    LEASED: "处理中",
    NEEDS_REVIEW: "需复核",
    CANCELLED: "已取消",
    SKIPPED: "已跳过",
  };
  for (const job of jobs) {
    const row = document.createElement("tr");
    const cell = (value, className) => {
      const td = document.createElement("td");
      td.textContent = value;
      if (className) td.className = className;
      row.append(td);
      return td;
    };
    cell(job.id.slice(0, 12), "job-id").title = job.id;
    const statusCell = cell("");
    const badge = document.createElement("span");
    badge.className = `pill ${job.status === "COMPLETED" ? "done" : job.status === "NEEDS_REVIEW" ? "bad" : job.attempts > 0 ? "warn" : ""}`;
    badge.textContent =
      job.status === "QUEUED" && job.attempts > 0 ? "等待重试" : labels[job.status] || job.status;
    statusCell.append(badge);
    cell(String(job.attempts));
    cell(new Date(job.updatedAt).toLocaleString("zh-CN", { hour12: false }));
    cell(job.errorCode || "—");
    tbody.append(row);
  }
}

loadState().catch(() => notice("控制台暂不可用，请刷新页面重试。", true));
setInterval(() => {
  if (state?.authenticated && !document.hidden) refreshOperations();
}, 30_000);
