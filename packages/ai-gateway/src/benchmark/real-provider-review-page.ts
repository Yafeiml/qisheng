import {
  REAL_PROVIDER_REVIEW_CRITERIA_VERSION,
  REAL_PROVIDER_REVIEW_ISSUES,
  REAL_PROVIDER_REVIEW_SCHEMA_VERSION,
} from "./real-provider-review";

interface ReviewPageItem {
  copy: {
    body: string;
    hashtags: readonly string[];
    title: string;
  };
  employeeMembershipId: string;
  image: {
    checksum: string;
    height: number;
    imagePath: string;
    perceptualHash: string;
    width: number;
  };
}

export function createRealProviderReviewHtml(
  benchmarkId: string,
  items: readonly ReviewPageItem[],
): string {
  const issueOptions = REAL_PROVIDER_REVIEW_ISSUES.map(
    (issue) => `<option value="${issue}">${issue}</option>`,
  ).join("");
  const cards = items
    .map(
      (item) => `
<article class="card pending" data-employee-id="${escapeHtml(item.employeeMembershipId)}">
  <img loading="lazy" src="${escapeHtml(item.image.imagePath)}" alt="${escapeHtml(item.employeeMembershipId)}">
  <div class="content">
    <div class="card-head"><p class="id">${escapeHtml(item.employeeMembershipId)}</p><span class="state">待复核</span></div>
    <h2>${escapeHtml(item.copy.title)}</h2>
    <p>${escapeHtml(item.copy.body)}</p>
    <p class="tags">#${item.copy.hashtags.map(escapeHtml).join(" #")}</p>
    <details><summary>图片校验信息</summary><dl><dt>SHA-256</dt><dd>${escapeHtml(item.image.checksum)}</dd><dt>dHash</dt><dd>${escapeHtml(item.image.perceptualHash)}</dd><dt>尺寸</dt><dd>${item.image.width} × ${item.image.height}</dd></dl></details>
    <div class="review-actions">
      <div class="quick-actions"><button class="pass" type="button">通过</button><button class="reset" type="button">待定</button></div>
      <select class="issue" aria-label="不通过原因"><option value="">选择不通过原因</option>${issueOptions}</select>
      <textarea class="notes" rows="2" placeholder="不通过说明"></textarea>
      <button class="fail" type="button">记录不通过</button>
    </div>
  </div>
</article>`,
    )
    .join("\n");
  const reviewData = jsonForHtml({
    benchmarkId,
    criteriaVersion: REAL_PROVIDER_REVIEW_CRITERIA_VERSION,
    entries: items.map((item) => ({
      employeeMembershipId: item.employeeMembershipId,
      imagePath: item.image.imagePath,
      title: item.copy.title,
    })),
    schemaVersion: REAL_PROVIDER_REVIEW_SCHEMA_VERSION,
  });

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>真实 Provider 人工复核</title>
  <style>
    :root{color-scheme:light;--red:#ff2442;--ink:#251d1e;--muted:#755f62;--line:#eadfde;--green:#15803d}
    *{box-sizing:border-box}body{margin:0;background:#f7f3f2;color:var(--ink);font-family:system-ui,sans-serif}
    header{position:sticky;top:0;z-index:2;padding:16px 24px;background:#fff;border-bottom:1px solid var(--line);box-shadow:0 4px 20px #51383d12}
    header h1{margin:0 0 6px;font-size:22px}header p{margin:0;color:var(--muted)}
    .signer{display:grid;grid-template-columns:minmax(180px,260px) minmax(240px,1fr) auto;gap:10px;align-items:center;margin-top:14px}
    input,textarea,select,button{font:inherit}input,textarea,select{width:100%;border:1px solid var(--line);border-radius:10px;padding:10px;background:#fff}
    .confirm{grid-column:1/3;display:flex;align-items:center;gap:8px;font-size:14px}.confirm input{width:auto}
    button{border:0;border-radius:10px;padding:10px 14px;cursor:pointer;font-weight:700}.sign{grid-column:3;grid-row:1/3;background:var(--red);color:#fff;height:100%}
    .progress{margin-top:10px;font-weight:700;color:var(--muted)}
    main{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:18px;padding:22px}
    .card{overflow:hidden;background:#fff;border:2px solid transparent;border-radius:18px;box-shadow:0 8px 30px #51383d12}.card.pass-state{border-color:#86efac}.card.fail-state{border-color:#fda4af}
    .card img{display:block;width:100%;aspect-ratio:3/4;object-fit:cover;background:#eee}.content{padding:16px}.content h2{font-size:18px}.content>p{line-height:1.65;white-space:pre-wrap}
    .card-head{display:flex;justify-content:space-between;align-items:center}.id,.tags{color:#b52b40}.state{border-radius:999px;padding:4px 10px;background:#f3f0ef;color:var(--muted);font-size:13px;font-weight:700}.pass-state .state{background:#dcfce7;color:var(--green)}.fail-state .state{background:#ffe4e6;color:#be123c}
    details{font-size:12px;color:var(--muted)}dt{font-weight:700}dd{margin:2px 0 8px;word-break:break-all}.review-actions{display:grid;gap:8px;margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}.quick-actions{display:flex;gap:8px}.quick-actions button{flex:1}.pass{background:#dcfce7;color:var(--green)}.reset{background:#f3f0ef;color:var(--muted)}.fail{background:#ffe4e6;color:#be123c}
    @media(max-width:720px){header{position:static}.signer{grid-template-columns:1fr}.confirm,.sign{grid-column:auto;grid-row:auto}.sign{height:auto}main{padding:12px;grid-template-columns:1fr}}
  </style>
</head>
<body>
  <header>
    <h1>真实 Provider 人工视觉复核</h1>
    <p>${escapeHtml(benchmarkId)} · 共 ${items.length} 项。全部认可时，只需填写姓名、勾选确认并点击一次签署；异常项可在卡片中单独标记。</p>
    <div class="signer">
      <input id="reviewer" autocomplete="name" placeholder="复核人姓名/岗位">
      <input id="conclusion-notes" placeholder="结论说明（可选）">
      <label class="confirm"><input id="confirmed" type="checkbox">我已查看本页全部图文，并对本次签署负责</label>
      <button class="sign" id="sign" type="button">一键签署并保存 JSON</button>
    </div>
    <div class="progress" id="progress">待复核 ${items.length} 项</div>
  </header>
  <main>${cards}</main>
  <script id="review-data" type="application/json">${reviewData}</script>
  <script>${REVIEW_PAGE_SCRIPT}</script>
</body>
</html>
`;
}

const REVIEW_PAGE_SCRIPT = String.raw`
(function () {
  "use strict";
  var data = JSON.parse(document.getElementById("review-data").textContent);
  var storageKey = "xhs-real-provider-review:" + data.benchmarkId;
  var state = {};
  var reviewer = document.getElementById("reviewer");
  var conclusionNotes = document.getElementById("conclusion-notes");
  var confirmed = document.getElementById("confirmed");
  var progress = document.getElementById("progress");
  try {
    var saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    state = saved.state || {};
    reviewer.value = saved.reviewer || "";
    conclusionNotes.value = saved.conclusionNotes || "";
  } catch (_) {}

  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify({ state: state, reviewer: reviewer.value, conclusionNotes: conclusionNotes.value })); } catch (_) {}
  }

  function render() {
    var pass = 0, fail = 0;
    document.querySelectorAll(".card").forEach(function (card) {
      var id = card.getAttribute("data-employee-id");
      var entry = state[id] || { decision: "PENDING", issues: [], notes: "" };
      card.classList.toggle("pass-state", entry.decision === "PASS");
      card.classList.toggle("fail-state", entry.decision === "FAIL");
      card.classList.toggle("pending", entry.decision === "PENDING");
      card.querySelector(".state").textContent = entry.decision === "PASS" ? "已通过" : entry.decision === "FAIL" ? "不通过" : "待复核";
      card.querySelector(".issue").value = entry.issues[0] || "";
      card.querySelector(".notes").value = entry.notes || "";
      if (entry.decision === "PASS") pass += 1;
      if (entry.decision === "FAIL") fail += 1;
    });
    progress.textContent = "已通过 " + pass + " 项 · 不通过 " + fail + " 项 · 待复核 " + (data.entries.length - pass - fail) + " 项";
  }

  document.querySelectorAll(".card").forEach(function (card) {
    var id = card.getAttribute("data-employee-id");
    card.querySelector(".pass").addEventListener("click", function () {
      state[id] = { decision: "PASS", issues: [], notes: "" }; persist(); render();
    });
    card.querySelector(".reset").addEventListener("click", function () {
      state[id] = { decision: "PENDING", issues: [], notes: "" }; persist(); render();
    });
    card.querySelector(".fail").addEventListener("click", function () {
      var issue = card.querySelector(".issue").value;
      var notes = card.querySelector(".notes").value.trim();
      if (!issue || notes.length < 2) { alert("记录不通过时，请选择原因并填写说明。"); return; }
      state[id] = { decision: "FAIL", issues: [issue], notes: notes }; persist(); render();
    });
  });
  reviewer.addEventListener("input", persist);
  conclusionNotes.addEventListener("input", persist);

  document.getElementById("sign").addEventListener("click", async function () {
    var reviewerName = reviewer.value.trim();
    if (reviewerName.length < 2) { alert("请填写至少两个字符的复核人姓名或岗位。"); return; }
    if (!confirmed.checked) { alert("请先确认已查看全部图文并愿意承担本次签署责任。"); return; }
    data.entries.forEach(function (entry) {
      if (!state[entry.employeeMembershipId] || state[entry.employeeMembershipId].decision === "PENDING") {
        state[entry.employeeMembershipId] = { decision: "PASS", issues: [], notes: "" };
      }
    });
    persist(); render();
    var entries = data.entries.map(function (entry) {
      var reviewed = state[entry.employeeMembershipId];
      return {
        decision: reviewed.decision,
        employeeMembershipId: entry.employeeMembershipId,
        imagePath: entry.imagePath,
        issues: reviewed.issues,
        notes: reviewed.notes,
        title: entry.title
      };
    });
    var passCount = entries.filter(function (entry) { return entry.decision === "PASS"; }).length;
    var hardFailure = entries.some(function (entry) { return entry.issues.indexOf("FACTUAL_ACCURACY") >= 0 || entry.issues.indexOf("IMAGE_SAFETY") >= 0; });
    var approved = passCount / entries.length >= 0.9 && !hardFailure;
    var review = {
      benchmarkId: data.benchmarkId,
      conclusion: {
        decision: approved ? "APPROVED" : "REJECTED",
        notes: conclusionNotes.value.trim() || ("复核完成：PASS " + passCount + " 项，FAIL " + (entries.length - passCount) + " 项。")
      },
      criteriaVersion: data.criteriaVersion,
      entries: entries,
      reviewedAt: new Date().toISOString(),
      reviewer: reviewerName,
      schemaVersion: data.schemaVersion,
      synthetic: false
    };
    var json = JSON.stringify(review, null, 2) + "\n";
    try {
      var response = await fetch("/api/manual-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: json });
      if (response.ok) { alert("签署已直接保存到 WSL 验收目录。返回对话告诉 Codex『已签署』即可运行最终验收。"); return; }
    } catch (_) {}
    try {
      if (window.showSaveFilePicker) {
        var handle = await window.showSaveFilePicker({ suggestedName: "manual-review.json", types: [{ description: "JSON", accept: { "application/json": [".json"] } }] });
        var writable = await handle.createWritable(); await writable.write(json); await writable.close();
        alert("manual-review.json 已保存。请将它放在本基准报告目录后运行验收器。"); return;
      }
    } catch (error) { if (error && error.name === "AbortError") return; }
    var blob = new Blob([json], { type: "application/json" });
    var link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "manual-review.json"; link.click(); URL.revokeObjectURL(link.href);
  });
  render();
})();`;

function jsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
