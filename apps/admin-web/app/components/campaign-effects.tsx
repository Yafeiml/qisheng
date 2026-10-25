"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "../lib/mvp-client";
import { messageOf } from "../lib/use-mvp-session";
import styles from "./campaign-effects.module.css";
import { FeedbackMessage } from "./feedback-toast";
import { WorkspaceDrawer } from "./workspace-drawer";

type GeoPayload = {
  product: string;
  surface: "SEARCH" | "AI";
  query: string;
  brandSeen: boolean | null;
  citationUrl?: string;
  evidenceUrl?: string;
  source: string;
};
type TransactionPayload = {
  channel: string;
  cohortStart: string;
  cohortEnd: string;
  conversionWindowEnd: string;
  definition: "PAID_ORDER" | "COMPLETED_SERVICE";
  dataStatus: "VERIFIED" | "UNKNOWN";
  leadCount: number | null;
  consultationCount: number | null;
  appointmentCount: number | null;
  visitCount: number | null;
  transactionPeople: number | null;
  orderCount: number | null;
  receivedMinor: number | null;
  refundMinor: number | null;
  costMinor: number | null;
  currency: "CNY";
  source: string;
};
type Observation = {
  id: string;
  kind: "GEO" | "TRANSACTION";
  observedAt: string;
  createdAt: string;
  payload: GeoPayload | TransactionPayload;
  metrics: {
    netReceivedMinor: number | null;
    transactionRate: number | null;
    costPerTransactionMinor: number | null;
    windowComplete: boolean;
  } | null;
};

const countLabels = {
  leadCount: "同范围去重有效线索人数",
  consultationCount: "咨询人数（过程）",
  appointmentCount: "已核实预约人数（过程）",
  visitCount: "到院人数（过程）",
  transactionPeople: "核实成交人数",
  orderCount: "成交订单数",
} as const;
const amountLabels = {
  received: "实收金额（元）",
  refund: "退款金额（元）",
  cost: "同范围成本（元）",
} as const;
const emptyCounts = {
  leadCount: "",
  consultationCount: "",
  appointmentCount: "",
  visitCount: "",
  transactionPeople: "",
  orderCount: "",
};
const emptyAmounts = { received: "", refund: "", cost: "" };
const localTime = (value: Date) =>
  new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const dateLabel = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(
    new Date(value),
  );
const moneyLabel = (value: number | null | undefined) =>
  value == null
    ? "未知"
    : `¥${(value / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function CampaignEffects({
  base,
  token,
  canManage,
}: {
  base: string;
  token: string;
  canManage: boolean;
}) {
  const [items, setItems] = useState<Observation[]>([]);
  const loadSequence = useRef(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"GEO" | "TRANSACTION">("GEO");
  const [observedAt, setObservedAt] = useState(() => localTime(new Date()));
  const [source, setSource] = useState("");
  const [geo, setGeo] = useState({
    product: "小红书",
    surface: "SEARCH" as GeoPayload["surface"],
    query: "",
    brandSeen: "UNKNOWN",
    citationUrl: "",
    evidenceUrl: "",
  });
  const [transaction, setTransaction] = useState({
    channel: "小红书",
    cohortStart: "",
    cohortEnd: "",
    conversionWindowEnd: "",
    definition: "PAID_ORDER" as TransactionPayload["definition"],
    dataStatus: "UNKNOWN" as TransactionPayload["dataStatus"],
  });
  const [counts, setCounts] = useState(emptyCounts);
  const [amounts, setAmounts] = useState(emptyAmounts);
  const known = transaction.dataStatus === "VERIFIED";
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError("");
    try {
      const result = await apiRequest<{ items: Observation[] }>(`${base}/effect-observations`, {
        token,
      });
      if (sequence === loadSequence.current) setItems(result.items);
    } catch (reason) {
      if (sequence === loadSequence.current) setError(messageOf(reason));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [base, token]);
  useEffect(() => {
    setItems([]);
    void load();
    return () => {
      loadSequence.current += 1;
    };
  }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canManage) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let payload: GeoPayload | TransactionPayload;
      if (kind === "GEO")
        payload = {
          product: geo.product.trim(),
          surface: geo.surface,
          query: geo.query.trim(),
          brandSeen: geo.brandSeen === "UNKNOWN" ? null : geo.brandSeen === "YES",
          ...(geo.citationUrl.trim() ? { citationUrl: geo.citationUrl.trim() } : {}),
          ...(geo.evidenceUrl.trim() ? { evidenceUrl: geo.evidenceUrl.trim() } : {}),
          source: source.trim(),
        };
      else
        payload = {
          ...transaction,
          cohortStart: new Date(transaction.cohortStart).toISOString(),
          cohortEnd: new Date(transaction.cohortEnd).toISOString(),
          conversionWindowEnd: new Date(transaction.conversionWindowEnd).toISOString(),
          currency: "CNY",
          source: source.trim(),
          leadCount: known ? count(counts.leadCount) : null,
          consultationCount: known ? count(counts.consultationCount) : null,
          appointmentCount: known ? count(counts.appointmentCount) : null,
          visitCount: known ? count(counts.visitCount) : null,
          transactionPeople: known ? count(counts.transactionPeople) : null,
          orderCount: known ? count(counts.orderCount) : null,
          receivedMinor: known ? minor(amounts.received) : null,
          refundMinor: known ? minor(amounts.refund) : null,
          costMinor: known ? minor(amounts.cost) : null,
        };
      await apiRequest(`${base}/effect-observations`, {
        token,
        method: "POST",
        body: { kind, observedAt: new Date(observedAt).toISOString(), payload },
      });
      setOpen(false);
      setNotice("已保存企业复核的观察快照，历史记录不会相加。");
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`panel ${styles.panel}`} aria-label="GEO 与成交结果">
      <div className={styles.heading}>
        <div>
          <h2>GEO 与成交结果</h2>
          <p>
            记录真实搜索或 AI
            观察，以及企业核实的同批交易。内部内容覆盖、咨询和互动不能替代这些结果。
          </p>
        </div>
        <div className={styles.actions}>
          <button type="button" disabled={loading} onClick={() => void load()}>
            刷新记录
          </button>
          {canManage ? (
            <button
              type="button"
              className={styles.primary}
              onClick={() => {
                setObservedAt(localTime(new Date()));
                setOpen(true);
              }}
            >
              录入观察
            </button>
          ) : null}
        </div>
      </div>
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      <p className={styles.hint}>
        由企业依据实际来源录入，不自动归因。每条是独立快照，未知保留未知；观察窗口未结束时仍在观察。仅保存去重聚合统计，不录入患者姓名、电话、病历或付款凭据。
      </p>
      <div className={styles.history}>
        {items.map((item) => (
          <ObservationCard key={item.id} item={item} />
        ))}
        {!items.length ? (
          <p>{loading ? "正在读取观察记录…" : "尚无外部 GEO 或核实成交记录，结果未知。"}</p>
        ) : null}
      </div>
      <WorkspaceDrawer
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title="录入 GEO 或成交观察"
        description="企业运营录入真实来源与同范围统计，员工无需承担数据归因。"
        wide
      >
        <form className={styles.form} onSubmit={(event) => void save(event)}>
          <div className={styles.tabs} role="tablist" aria-label="观察类型">
            <button
              role="tab"
              aria-selected={kind === "GEO"}
              type="button"
              disabled={busy}
              onClick={() => setKind("GEO")}
            >
              GEO 观察
            </button>
            <button
              role="tab"
              aria-selected={kind === "TRANSACTION"}
              type="button"
              disabled={busy}
              onClick={() => setKind("TRANSACTION")}
            >
              成交快照
            </button>
          </div>
          <label>
            观察时间
            <input
              type="datetime-local"
              required
              value={observedAt}
              disabled={busy}
              onChange={(event) => setObservedAt(event.target.value)}
            />
          </label>
          {kind === "GEO" ? (
            <>
              <div className={styles.grid}>
                <label>
                  实际产品或入口
                  <input
                    required
                    maxLength={100}
                    value={geo.product}
                    disabled={busy}
                    onChange={(event) => setGeo({ ...geo, product: event.target.value })}
                    placeholder="如小红书搜索、点点，填写实际入口"
                  />
                </label>
                <label>
                  观察方式
                  <select
                    value={geo.surface}
                    disabled={busy}
                    onChange={(event) =>
                      setGeo({ ...geo, surface: event.target.value as GeoPayload["surface"] })
                    }
                  >
                    <option value="SEARCH">搜索结果</option>
                    <option value="AI">AI 回答</option>
                  </select>
                </label>
              </div>
              <label>
                实际查询或问题
                <input
                  required
                  maxLength={500}
                  value={geo.query}
                  disabled={busy}
                  onChange={(event) => setGeo({ ...geo, query: event.target.value })}
                />
              </label>
              <label>
                目标品牌是否正确出现
                <select
                  value={geo.brandSeen}
                  disabled={busy}
                  onChange={(event) => setGeo({ ...geo, brandSeen: event.target.value })}
                >
                  <option value="UNKNOWN">尚未核实</option>
                  <option value="YES">已核实出现</option>
                  <option value="NO">已观察，未出现</option>
                </select>
              </label>
              <label>
                实际引用的具体内容 URL（可空）
                <input
                  type="url"
                  value={geo.citationUrl}
                  disabled={busy}
                  onChange={(event) => setGeo({ ...geo, citationUrl: event.target.value })}
                  placeholder="具体笔记或来源，出现域名不等于引用品牌"
                />
              </label>
              <label>
                观察证据 URL（可空）
                <input
                  type="url"
                  value={geo.evidenceUrl}
                  disabled={busy}
                  onChange={(event) => setGeo({ ...geo, evidenceUrl: event.target.value })}
                  placeholder="有权访问的观察记录，不放病历等敏感资料"
                />
              </label>
            </>
          ) : (
            <>
              <label>
                渠道与统计批次
                <input
                  required
                  maxLength={100}
                  value={transaction.channel}
                  disabled={busy}
                  onChange={(event) =>
                    setTransaction({ ...transaction, channel: event.target.value })
                  }
                  placeholder="如小红书自然咨询 · 10 月活动批次"
                />
              </label>
              <div className={styles.grid}>
                {(["cohortStart", "cohortEnd", "conversionWindowEnd"] as const).map((key) => (
                  <label key={key}>
                    {
                      {
                        cohortStart: "同批线索统计开始",
                        cohortEnd: "同批线索统计结束",
                        conversionWindowEnd: "成交转化观察截止",
                      }[key]
                    }
                    <input
                      type="datetime-local"
                      required
                      value={transaction[key]}
                      disabled={busy}
                      onChange={(event) =>
                        setTransaction({ ...transaction, [key]: event.target.value })
                      }
                    />
                  </label>
                ))}
              </div>
              <div className={styles.grid}>
                <label>
                  企业成交口径
                  <select
                    value={transaction.definition}
                    disabled={busy}
                    onChange={(event) =>
                      setTransaction({
                        ...transaction,
                        definition: event.target.value as TransactionPayload["definition"],
                      })
                    }
                  >
                    <option value="PAID_ORDER">已支付订单</option>
                    <option value="COMPLETED_SERVICE">已完成服务订单</option>
                  </select>
                </label>
                <label>
                  数据核实状态
                  <select
                    value={transaction.dataStatus}
                    disabled={busy}
                    onChange={(event) =>
                      setTransaction({
                        ...transaction,
                        dataStatus: event.target.value as TransactionPayload["dataStatus"],
                      })
                    }
                  >
                    <option value="UNKNOWN">尚未核实，保留未知</option>
                    <option value="VERIFIED">企业已核实</option>
                  </select>
                </label>
              </div>
              <p className={styles.hint}>
                人数按同一线索群体去重，咨询、预约、到院是过程，不能当作成交。核心人数、订单与金额未齐请保持未知；已核实记录核心项必填，过程项可留空。核实为零才填
                0，金额以人民币元填入，精确保存为分。
              </p>
              <div className={styles.grid}>
                {Object.entries(countLabels).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      min="0"
                      step="1"
                      inputMode="numeric"
                      required={
                        known && ["leadCount", "transactionPeople", "orderCount"].includes(key)
                      }
                      disabled={busy || !known}
                      value={counts[key as keyof typeof counts]}
                      onChange={(event) => setCounts({ ...counts, [key]: event.target.value })}
                      placeholder="未知留空"
                    />
                  </label>
                ))}
              </div>
              <div className={styles.grid}>
                {Object.entries(amountLabels).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="text"
                      inputMode="decimal"
                      pattern="[0-9]+(\.[0-9]{1,2})?"
                      required={known}
                      disabled={busy || !known}
                      value={amounts[key as keyof typeof amounts]}
                      onChange={(event) => setAmounts({ ...amounts, [key]: event.target.value })}
                      placeholder="未知留空"
                    />
                  </label>
                ))}
              </div>
            </>
          )}
          <label>
            来源与企业复核依据
            <textarea
              required
              minLength={4}
              maxLength={1000}
              rows={4}
              value={source}
              disabled={busy}
              onChange={(event) => setSource(event.target.value)}
              placeholder="说明观察入口、时间与条件，或去重聚合业务记录及核验口径；不要录入患者个人资料"
            />
          </label>
          <button type="submit" disabled={busy} className={styles.primary}>
            {busy ? "正在保存…" : "保存观察快照"}
          </button>
        </form>
      </WorkspaceDrawer>
    </section>
  );
}

function ObservationCard({ item }: { item: Observation }) {
  if (item.kind === "GEO") {
    const payload = item.payload as GeoPayload;
    return (
      <article className={styles.card}>
        <header>
          <strong>
            {payload.product} · {payload.surface === "SEARCH" ? "搜索结果" : "AI 回答"}
          </strong>
          <time>{dateLabel(item.observedAt)}</time>
        </header>
        <p>{payload.query}</p>
        <p>
          品牌正确出现：
          {payload.brandSeen === null
            ? "未知"
            : payload.brandSeen
              ? "已核实出现"
              : "已观察，未出现"}
        </p>
        {payload.citationUrl ? (
          <a href={payload.citationUrl} target="_blank" rel="noreferrer">
            查看具体引用来源
          </a>
        ) : (
          <small>没有记录具体引用，不计为已引用。</small>
        )}
        {payload.evidenceUrl ? (
          <a href={payload.evidenceUrl} target="_blank" rel="noreferrer">
            查看观察证据
          </a>
        ) : null}
        <details>
          <summary>来源与复核依据</summary>
          <p>{payload.source}</p>
        </details>
      </article>
    );
  }
  const payload = item.payload as TransactionPayload;
  return (
    <article className={styles.card}>
      <header>
        <strong>
          {payload.channel} · {payload.definition === "PAID_ORDER" ? "已支付订单" : "已完成服务"}
        </strong>
        <time>{dateLabel(item.observedAt)}</time>
      </header>
      <p>
        {payload.dataStatus === "UNKNOWN" ? "数据尚未核实" : "企业已核实统计"} ·{" "}
        {item.metrics?.windowComplete ? "观察窗口已结束" : "观察中 / 窗口未结束"}
      </p>
      <small>
        同批线索 {dateLabel(payload.cohortStart)} — {dateLabel(payload.cohortEnd)}；转化截止{" "}
        {dateLabel(payload.conversionWindowEnd)}
      </small>
      <dl className={styles.metrics}>
        <div>
          <dt>成交人数 / 订单</dt>
          <dd>
            {payload.transactionPeople ?? "未知"} / {payload.orderCount ?? "未知"}
          </dd>
        </div>
        <div>
          <dt>实收 / 退款</dt>
          <dd>
            {moneyLabel(payload.receivedMinor)} / {moneyLabel(payload.refundMinor)}
          </dd>
        </div>
        <div>
          <dt>净实收</dt>
          <dd>{moneyLabel(item.metrics?.netReceivedMinor)}</dd>
        </div>
        <div>
          <dt>成交获客成本</dt>
          <dd>{moneyLabel(item.metrics?.costPerTransactionMinor)}</dd>
        </div>
        <div>
          <dt>去重线索 / 成交率</dt>
          <dd>
            {payload.leadCount ?? "未知"} /{" "}
            {item.metrics?.transactionRate == null
              ? "未知"
              : `${(item.metrics.transactionRate * 100).toFixed(1)}%`}
          </dd>
        </div>
        <div>
          <dt>咨询 / 预约 / 到院（过程）</dt>
          <dd>
            {payload.consultationCount ?? "未知"} / {payload.appointmentCount ?? "未知"} /{" "}
            {payload.visitCount ?? "未知"}
          </dd>
        </div>
      </dl>
      <details>
        <summary>来源与复核依据</summary>
        <p>{payload.source}</p>
        <p>
          同范围成本 {moneyLabel(payload.costMinor)}；本记录为单次快照，不能与相同批次历史记录相加。
        </p>
      </details>
    </article>
  );
}

function count(value: string) {
  if (!value.trim()) return null;
  const number = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number))
    throw new Error("人数和订单数须为非负整数，未知请留空。");
  return number;
}
function minor(value: string) {
  if (!value.trim()) return null;
  if (!/^\d+(?:\.\d{1,2})?$/u.test(value)) throw new Error("金额最多两位小数，未知请留空。");
  const [whole = "0", fraction = ""] = value.split(".");
  const number = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(number)) throw new Error("金额超出可记录范围。");
  return number;
}
