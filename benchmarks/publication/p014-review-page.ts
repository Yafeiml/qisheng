import type { P014Manifest, P014SampleResult, summarizeP014Benchmark } from "./p014-core";

type P014Summary = ReturnType<typeof summarizeP014Benchmark>;

export function createP014ReviewHtml(
  manifest: P014Manifest,
  results: readonly P014SampleResult[],
  summary: P014Summary,
): string {
  const sampleById = new Map(manifest.samples.map((sample) => [sample.id, sample]));
  const policyOptions = summary.passingPolicyVersions
    .map(
      (version) =>
        `<option value="${escapeHtml(version)}"${version === summary.recommendedPolicyVersion ? " selected" : ""}>${escapeHtml(version)}${version === summary.recommendedPolicyVersion ? "（推荐）" : ""}</option>`,
    )
    .join("");
  const policyRows = summary.policyMetrics
    .map(
      (metric) => `<tr>
  <td>${escapeHtml(metric.policyVersion)}</td>
  <td>${metric.passed ? "通过" : "未通过"}</td>
  <td>${percent(metric.matchAutoPassRate)}</td>
  <td>${percent(metric.falseAcceptRate)}</td>
  <td>${percent(metric.falseRejectRate)}</td>
  <td>${percent(metric.manualReviewRate)}</td>
</tr>`,
    )
    .join("");
  const cards = results
    .map((result) => {
      const sample = sampleById.get(result.sampleId);
      if (!sample) throw new Error(`Review result references unknown sample ${result.sampleId}`);
      const evaluations = result.policyEvaluations
        .map(
          (evaluation) => `<tr>
  <td>${escapeHtml(evaluation.policyVersion)}</td>
  <td>${escapeHtml(evaluation.decision)}</td>
  <td>${evaluation.textScore.toFixed(3)}</td>
  <td>${evaluation.imageScore?.toFixed(3) ?? "—"}</td>
  <td>${evaluation.factScore?.toFixed(3) ?? "—"}</td>
</tr>`,
        )
        .join("");
      const publicImages = result.evidence?.images
        .flatMap(({ url }, index) =>
          url
            ? [
                `<a class="image-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">公开图片 ${index + 1}</a>`,
              ]
            : [],
        )
        .join(" ");
      return `<article class="card pending" data-sample-id="${escapeHtml(sample.id)}">
  <div class="card-head"><div><p class="id">${escapeHtml(sample.id)}</p><h2>${escapeHtml(sample.label)} · ${escapeHtml(sample.scenarios.join(" / "))}</h2></div><span class="state">待复核</span></div>
  <p class="url"><a href="${escapeHtml(result.inputNormalizedUrl)}" target="_blank" rel="noreferrer">${escapeHtml(result.inputNormalizedUrl)}</a></p>
  <div class="comparison">
    <section><h3>员工任务原文</h3><strong>${escapeHtml(sample.expectedContent.title)}</strong><p>${escapeHtml(sample.expectedContent.body)}</p><p class="tags">#${sample.expectedContent.hashtags.map(escapeHtml).join(" #")}</p></section>
    <section><h3>供应商获取内容</h3><strong>${escapeHtml(result.evidence?.title ?? result.adapterStatus)}</strong><p>${escapeHtml(result.evidence?.body ?? result.error?.message ?? "未获取到公开内容")}</p><p class="tags">${result.evidence ? `#${result.evidence.hashtags.map(escapeHtml).join(" #")}` : ""}</p>${publicImages ? `<p>${publicImages}</p>` : ""}</section>
  </div>
  <details><summary>自动评分与供应商证据</summary>
    <p>状态：${escapeHtml(result.adapterStatus)} · 延迟：${result.latencyMs.toFixed(0)}ms · Canonical Key：${escapeHtml(result.canonicalKey ?? "—")}</p>
    <table><thead><tr><th>策略</th><th>结论</th><th>正文</th><th>图片</th><th>数字事实</th></tr></thead><tbody>${evaluations}</tbody></table>
  </details>
  <div class="review-actions">
    <div class="quick-actions"><button class="pass" type="button">通过</button><button class="reset" type="button">待定</button></div>
    <select class="issue" aria-label="不通过原因"><option value="">选择不通过原因</option><option>供应商无法稳定获取</option><option>短链或长链归一化错误</option><option>正文评分不符合人工判断</option><option>图片评分不符合人工判断</option><option>样本预期标签有误</option><option>候选阈值不适合生产</option><option>其他</option></select>
    <textarea class="notes" rows="2" placeholder="不通过说明"></textarea>
    <button class="fail" type="button">记录不通过</button>
  </div>
</article>`;
    })
    .join("\n");
  const reviewData = jsonForHtml({
    benchmarkId: manifest.benchmarkId,
    passingPolicyVersions: summary.passingPolicyVersions,
    recommendedPolicyVersion: summary.recommendedPolicyVersion,
    samples: results.map(({ sampleId }) => ({ sampleId })),
    schemaVersion: 1,
    synthetic: false,
  });

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>P-014 小红书真实样本验真复核</title>
  <style>
    :root{color-scheme:light;--red:#ff2442;--ink:#251d1e;--muted:#755f62;--line:#eadfde;--green:#15803d;--bg:#f7f3f2}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,"PingFang SC",sans-serif}
    header{position:sticky;top:0;z-index:3;padding:18px 24px;background:#fff;border-bottom:1px solid var(--line);box-shadow:0 4px 20px #51383d12}
    h1{margin:0 0 6px;font-size:24px}header>p{margin:0;color:var(--muted)}
    .signer{display:grid;grid-template-columns:minmax(180px,240px) minmax(180px,260px) minmax(220px,1fr) auto;gap:10px;align-items:center;margin-top:14px}
    input,textarea,select,button{font:inherit}input,textarea,select{width:100%;border:1px solid var(--line);border-radius:10px;padding:10px;background:#fff}.confirm{grid-column:1/4;display:flex;gap:8px;align-items:center;font-size:14px}.confirm input{width:auto}.sign{grid-column:4;grid-row:1/3;height:100%;background:var(--red);color:#fff}
    button{border:0;border-radius:10px;padding:10px 14px;cursor:pointer;font-weight:700}.progress{margin-top:10px;font-weight:700;color:var(--muted)}
    .summary,.cards{max-width:1500px;margin:0 auto}.summary{padding:22px 22px 0}.summary-box{padding:18px;background:#fff;border:1px solid var(--line);border-radius:18px}.cards{display:grid;gap:18px;padding:22px}
    table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line)}
    .card{padding:18px;background:#fff;border:2px solid transparent;border-radius:18px;box-shadow:0 8px 30px #51383d12}.card.pass-state{border-color:#86efac}.card.fail-state{border-color:#fda4af}.card-head{display:flex;justify-content:space-between;gap:16px;align-items:start}.card h2{margin:2px 0 0;font-size:18px}.id{margin:0;color:#b52b40;font-weight:700}.state{border-radius:999px;padding:4px 10px;background:#f3f0ef;color:var(--muted);font-size:13px;font-weight:700}.pass-state .state{background:#dcfce7;color:var(--green)}.fail-state .state{background:#ffe4e6;color:#be123c}.url{overflow-wrap:anywhere}.url a,.image-link{color:#b52b40}
    .comparison{display:grid;grid-template-columns:1fr 1fr;gap:14px}.comparison section{padding:14px;background:#faf8f7;border:1px solid var(--line);border-radius:12px}.comparison h3{margin-top:0;font-size:14px;color:var(--muted)}.comparison p{white-space:pre-wrap;line-height:1.65}.tags{color:#b52b40}
    details{margin-top:14px;color:var(--muted)}.review-actions{display:grid;gap:8px;margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}.quick-actions{display:flex;gap:8px}.quick-actions button{flex:1}.pass{background:#dcfce7;color:var(--green)}.reset{background:#f3f0ef;color:var(--muted)}.fail{background:#ffe4e6;color:#be123c}
    @media(max-width:820px){header{position:static}.signer{grid-template-columns:1fr}.confirm,.sign{grid-column:auto;grid-row:auto}.sign{height:auto}.comparison{grid-template-columns:1fr}.summary,.cards{padding-left:12px;padding-right:12px}}
  </style>
</head>
<body>
  <header>
    <h1>P-014 小红书真实样本验真复核</h1>
    <p>${escapeHtml(manifest.benchmarkId)} · ${results.length} 条真实公开链接 · 自动门禁${summary.automatedGatePassed ? "已通过" : "未通过"}。人工签署不能覆盖自动门禁失败。</p>
    <div class="signer">
      <input id="reviewer" autocomplete="name" placeholder="复核人姓名/岗位">
      <select id="approved-policy" ${summary.passingPolicyVersions.length === 0 ? "disabled" : ""}><option value="">选择批准的策略版本</option>${policyOptions}</select>
      <input id="conclusion-notes" placeholder="结论说明（可选）">
      <label class="confirm"><input id="confirmed" type="checkbox">我已检查全部真实链接、预期标签、图文证据与阈值结果，并对本次签署负责</label>
      <button class="sign" id="sign" type="button" ${summary.passingPolicyVersions.length === 0 ? "disabled" : ""}>一键签署并保存 JSON</button>
    </div>
    <div class="progress" id="progress">待复核 ${results.length} 项</div>
  </header>
  <section class="summary"><div class="summary-box"><h2>候选策略结果</h2><table><thead><tr><th>策略</th><th>门禁</th><th>匹配自动通过</th><th>误通过</th><th>误拒绝</th><th>人工复核</th></tr></thead><tbody>${policyRows}</tbody></table></div></section>
  <main class="cards">${cards}</main>
  <script id="review-data" type="application/json">${reviewData}</script>
  <script>${REVIEW_SCRIPT}</script>
</body>
</html>`;
}

const REVIEW_SCRIPT = String.raw`
(function () {
  "use strict";
  var data = JSON.parse(document.getElementById("review-data").textContent);
  var storageKey = "xhs-p014-review:" + data.benchmarkId;
  var state = {};
  var reviewer = document.getElementById("reviewer");
  var approvedPolicy = document.getElementById("approved-policy");
  var conclusionNotes = document.getElementById("conclusion-notes");
  var confirmed = document.getElementById("confirmed");
  var progress = document.getElementById("progress");
  try {
    var saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    state = saved.state || {};
    reviewer.value = saved.reviewer || "";
    approvedPolicy.value = saved.approvedPolicy || data.recommendedPolicyVersion || "";
    conclusionNotes.value = saved.conclusionNotes || "";
  } catch (_) {}
  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify({ state: state, reviewer: reviewer.value, approvedPolicy: approvedPolicy.value, conclusionNotes: conclusionNotes.value })); } catch (_) {}
  }
  function render() {
    var pass = 0, fail = 0;
    document.querySelectorAll(".card").forEach(function (card) {
      var id = card.getAttribute("data-sample-id");
      var entry = state[id] || { decision: "PENDING", issue: "", notes: "" };
      card.classList.toggle("pass-state", entry.decision === "PASS");
      card.classList.toggle("fail-state", entry.decision === "FAIL");
      card.querySelector(".state").textContent = entry.decision === "PASS" ? "已通过" : entry.decision === "FAIL" ? "不通过" : "待复核";
      card.querySelector(".issue").value = entry.issue || "";
      card.querySelector(".notes").value = entry.notes || "";
      if (entry.decision === "PASS") pass += 1;
      if (entry.decision === "FAIL") fail += 1;
    });
    progress.textContent = "已通过 " + pass + " 项 · 不通过 " + fail + " 项 · 待复核 " + (data.samples.length - pass - fail) + " 项";
  }
  document.querySelectorAll(".card").forEach(function (card) {
    var id = card.getAttribute("data-sample-id");
    card.querySelector(".pass").addEventListener("click", function () { state[id] = { decision: "PASS", issue: "", notes: "" }; persist(); render(); });
    card.querySelector(".reset").addEventListener("click", function () { state[id] = { decision: "PENDING", issue: "", notes: "" }; persist(); render(); });
    card.querySelector(".fail").addEventListener("click", function () {
      var issue = card.querySelector(".issue").value;
      var notes = card.querySelector(".notes").value.trim();
      if (!issue || notes.length < 2) { alert("记录不通过时，请选择原因并填写说明。"); return; }
      state[id] = { decision: "FAIL", issue: issue, notes: notes }; persist(); render();
    });
  });
  reviewer.addEventListener("input", persist); approvedPolicy.addEventListener("change", persist); conclusionNotes.addEventListener("input", persist);
  document.getElementById("sign").addEventListener("click", async function () {
    var reviewerName = reviewer.value.trim();
    if (reviewerName.length < 2) { alert("请填写至少两个字符的复核人姓名或岗位。"); return; }
    if (!data.passingPolicyVersions.includes(approvedPolicy.value)) { alert("请选择一个已通过自动门禁的策略版本。"); return; }
    if (!confirmed.checked) { alert("请先勾选责任确认。"); return; }
    data.samples.forEach(function (sample) { if (!state[sample.sampleId] || state[sample.sampleId].decision === "PENDING") state[sample.sampleId] = { decision: "PASS", issue: "", notes: "" }; });
    persist(); render();
    var review = {
      approvedPolicyVersion: approvedPolicy.value,
      benchmarkId: data.benchmarkId,
      conclusionNotes: conclusionNotes.value.trim(),
      entries: data.samples.map(function (sample) { var entry = state[sample.sampleId]; return { decision: entry.decision, issue: entry.issue, notes: entry.notes, sampleId: sample.sampleId }; }),
      responsibilityAccepted: true,
      reviewedAt: new Date().toISOString(),
      reviewer: reviewerName,
      schemaVersion: 1,
      synthetic: false
    };
    var json = JSON.stringify(review, null, 2) + "\n";
    try {
      var response = await fetch("/api/manual-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: json });
      if (response.ok) { alert("manual-review.json 已安全写回评测目录，可以执行正式验收命令。"); return; }
    } catch (_) {}
    try {
      if (window.showSaveFilePicker) { var handle = await window.showSaveFilePicker({ suggestedName: "manual-review.json", types: [{ description: "JSON", accept: { "application/json": [".json"] } }] }); var writable = await handle.createWritable(); await writable.write(json); await writable.close(); alert("manual-review.json 已保存。"); return; }
    } catch (error) { if (error && error.name === "AbortError") return; }
    var blob = new Blob([json], { type: "application/json" }); var link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "manual-review.json"; link.click(); URL.revokeObjectURL(link.href);
  });
  render();
})();`;

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function jsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}
