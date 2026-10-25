"use client";

import type { components } from "@xhs-agentic/contracts";
import { useCallback, useEffect, useState } from "react";
import { ConsoleScopeSwitcher } from "../../components/console-scope-switcher";
import { FeedbackMessage } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import { SaasShell, StatusBadge } from "../../components/saas-shell";
import {
  ApiError,
  apiRequest,
  consoleNavigationPermissions,
  selectedAdminRoleName,
} from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";

type Summary = components["schemas"]["GeoCoverageSummaryDto"];
type Campaign = components["schemas"]["GeoCampaignCoverageDto"];
type Trend = components["schemas"]["GeoCoverageTrendPointDto"];
type Gap = components["schemas"]["GeoCoverageGapDto"];
type Comparison = components["schemas"]["GeoTenantComparisonDto"];

export default function GeoCoveragePage() {
  const auth = useMvpSession();
  const [days, setDays] = useState("90");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [trends, setTrends] = useState<Trend[]>([]);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [fullAnalysisLocked, setFullAnalysisLocked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!auth.session?.tenantId || !auth.session.enterpriseId) return;
    setLoading(true);
    setError(null);
    setFullAnalysisLocked(false);
    const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/geo-analytics`;
    try {
      setSummary(
        await apiRequest<Summary>(`${base}/summary?days=${days}`, {
          token: auth.session.adminToken,
        }),
      );
      const [campaignResult, trendResult, gapResult] = await Promise.allSettled([
        apiRequest<Campaign[]>(`${base}/campaigns?days=${days}`, {
          token: auth.session.adminToken,
        }),
        apiRequest<Trend[]>(`${base}/trends?days=${days}`, { token: auth.session.adminToken }),
        apiRequest<Gap[]>(`${base}/gaps?days=${days}`, { token: auth.session.adminToken }),
      ]);
      const rejected = [campaignResult, trendResult, gapResult].find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (rejected) {
        if (rejected.reason instanceof ApiError && rejected.reason.status === 403) {
          setFullAnalysisLocked(true);
          setCampaigns([]);
          setTrends([]);
          setGaps([]);
        } else {
          throw rejected.reason;
        }
      } else if (
        campaignResult.status === "fulfilled" &&
        trendResult.status === "fulfilled" &&
        gapResult.status === "fulfilled"
      ) {
        setCampaigns(campaignResult.value);
        setTrends(trendResult.value);
        setGaps(gapResult.value);
      }

      const canCompare = auth.session.adminAccess.scopes.some(
        (scope) =>
          scope.scopeType === "TENANT" &&
          scope.tenant?.id === auth.session?.tenantId &&
          scope.permissions.includes("tenant.dashboard.read"),
      );
      if (canCompare) {
        try {
          setComparison(
            await apiRequest<Comparison>(
              `/console/tenants/${auth.session.tenantId}/geo-analytics/comparison?days=${days}`,
              { token: auth.session.adminToken },
            ),
          );
        } catch (reason) {
          if (reason instanceof ApiError && reason.status === 403) setComparison(null);
          else throw reason;
        }
      } else {
        setComparison(null);
      }
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setLoading(false);
    }
  }, [auth.session, days]);

  useEffect(() => {
    void load();
  }, [load]);

  if (auth.session === undefined) return <GeoLoading />;
  if (auth.session === null) {
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  }

  return (
    <SaasShell
      active="geo"
      description="解释本系统素材、活动目标和员工最终文案的本地覆盖，不承诺外部平台权重、排名或引用。"
      mode="console"
      navigationPermissions={consoleNavigationPermissions(auth.session)}
      roleLabel={selectedAdminRoleName(auth.session)}
      scopeControl={<ConsoleScopeSwitcher onChange={auth.setSession} session={auth.session} />}
      scopeName={`${auth.session.tenantName} · ${auth.session.enterpriseName}`}
      title="内容覆盖分析"
      toolbar={
        <div className="toolbar">
          <select
            aria-label="分析周期"
            onChange={(event) => setDays(event.target.value)}
            value={days}
          >
            <option value="30">近 30 天</option>
            <option value="90">近 90 天</option>
            <option value="180">近 180 天</option>
            <option value="365">近 365 天</option>
          </select>
          <button
            className="ghostButton"
            disabled={loading}
            onClick={() => void load()}
            type="button"
          >
            {loading ? "计算中…" : "重新计算"}
          </button>
        </div>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {fullAnalysisLocked ? (
        <div className="permissionNotice panel">
          当前租户的内容分析能力由平台策略控制，可按需开放活动明细、趋势和内容回顾。
        </div>
      ) : null}
      <section className="metricGrid four">
        <Metric
          detail="当前生效的宣传重点"
          label="宣传重点"
          value={summary?.assets.activeEntityCount}
          tone="accent"
        />
        <Metric
          detail="当前生效问题主题"
          label="主题资产"
          value={summary?.assets.activeTopicCount}
        />
        <Metric
          detail="近期活动冻结目标"
          label="重点目标覆盖"
          value={percent(summary?.target.targetEntityCoverageRate)}
        />
        <Metric
          detail="最终员工文案命中"
          label="重点交付覆盖"
          value={percent(summary?.delivery.entityHitRate)}
        />
      </section>
      <section className="contentGrid equal">
        <article className="panel">
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">ASSET COVERAGE</span>
              <h2>可选设置概览</h2>
              <p>其他称呼与用户问题按需维护，不代表资料可用性或生成质量。</p>
            </div>
          </div>
          <CoverageBar label="别名覆盖" value={summary?.assets.aliasCoverageRate} />
          <CoverageBar label="重点问题覆盖" value={summary?.assets.topicCoverageRate} />
          <div className="geoFacts">
            <span>已确认重点 {summary?.assets.activeEntityCount ?? 0}</span>
            <span>未设置问题（可选） {summary?.assets.entitiesWithoutTopics ?? 0}</span>
          </div>
        </article>
        <article className="panel">
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">DELIVERY COVERAGE</span>
              <h2>最终文案交付覆盖</h2>
              <p>按每篇员工最终文案逐一检查本次选定的重点名称、别名和主题关键短语。</p>
            </div>
          </div>
          <CoverageBar label="重点提及率" value={summary?.delivery.entityHitRate} />
          <CoverageBar label="主题命中率" value={summary?.delivery.topicHitRate} />
          <div className="geoFacts">
            <span>文案 {summary?.delivery.employeeContentCount ?? 0} 篇</span>
            <span>
              重点提及 {summary?.delivery.entityHitCount ?? 0}/
              {summary?.delivery.entityEligibleCount ?? 0}
            </span>
            <span>
              主题命中 {summary?.delivery.topicHitCount ?? 0}/
              {summary?.delivery.topicEligibleCount ?? 0}
            </span>
          </div>
        </article>
      </section>
      {!fullAnalysisLocked ? (
        <>
          <section className="contentGrid wideLeft">
            <article className="panel">
              <div className="panelHeader">
                <div>
                  <span className="sectionKicker">活动趋势</span>
                  <h2>活动覆盖趋势</h2>
                </div>
              </div>
              <div className="geoTrendList">
                {trends.map((trend) => (
                  <article key={trend.campaignId}>
                    <div>
                      <strong>{trend.campaignTitle}</strong>
                      <small>{formatDate(trend.createdAt)}</small>
                    </div>
                    <CoverageBar label="目标重点" value={trend.target.targetEntityCoverageRate} />
                    <CoverageBar label="交付重点" value={trend.delivery.entityHitRate} />
                  </article>
                ))}
                {trends.length === 0 ? <p className="emptyHint">分析周期内暂无活动。</p> : null}
              </div>
            </article>
            <article className="panel">
              <div className="panelHeader">
                <div>
                  <span className="sectionKicker">GAPS</span>
                  <h2>内容回顾</h2>
                  <p>仅统计本系统生成文案；未使用的重点不影响活动，按需安排即可。</p>
                </div>
                <StatusBadge tone="neutral">{gaps.length}</StatusBadge>
              </div>
              <div className="geoGapList">
                {gaps.slice(0, 12).map((gap) => (
                  <article key={`${gap.resourceType}:${gap.seriesId}`}>
                    <div>
                      <strong>{gap.title}</strong>
                      <small>
                        {gap.parentEntityName ??
                          (gap.resourceType === "ENTITY" ? "宣传重点" : "用户问题")}
                      </small>
                    </div>
                    <StatusBadge tone={gap.gapType === "NOT_TARGETED" ? "neutral" : "warning"}>
                      {gapLabel(gap.gapType)}
                    </StatusBadge>
                    <span>{gap.gapType === "NOT_TARGETED" ? "—" : percent(gap.coverageRate)}</span>
                  </article>
                ))}
                {gaps.length === 0 ? <p className="emptyHint">当前没有待回顾的内容。</p> : null}
              </div>
            </article>
          </section>
          <section className="panel geoCampaignPanel">
            <div className="panelHeader">
              <div>
                <span className="sectionKicker">活动明细</span>
                <h2>活动覆盖明细</h2>
              </div>
            </div>
            <div className="rankingTable geoCampaignTable">
              <div className="tableHead">
                <span>活动</span>
                <span>目标重点 / 主题</span>
                <span>重点提及</span>
                <span>主题交付</span>
              </div>
              {campaigns.map((campaign) => (
                <div className="tableRow" key={campaign.campaignId}>
                  <span>
                    <b>域</b>
                    <span>
                      {campaign.campaignTitle}
                      <small>{formatDate(campaign.createdAt)}</small>
                    </span>
                  </span>
                  <span>
                    {campaign.target.targetedEntityCount} / {campaign.target.targetedTopicCount}
                  </span>
                  <span>{percent(campaign.delivery.entityHitRate)}</span>
                  <span>{percent(campaign.delivery.topicHitRate)}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : null}
      {comparison ? (
        <section className="panel geoCampaignPanel">
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">GROUP COMPARISON</span>
              <h2>集团跨企业比较</h2>
              <p>内容分析使用同一口径比较，不读取或声称外部平台排名。</p>
            </div>
          </div>
          <div className="rankingTable geoComparisonTable">
            <div className="tableHead">
              <span>企业</span>
              <span>已确认重点</span>
              <span>目标重点覆盖</span>
              <span>重点交付覆盖</span>
            </div>
            {comparison.enterprises.map((enterprise) => (
              <div className="tableRow" key={enterprise.enterpriseId}>
                <span>
                  <b>企</b>
                  {enterprise.enterpriseName}
                </span>
                <span>{enterprise.activeEntityCount}</span>
                <span>{percent(enterprise.targetEntityCoverageRate)}</span>
                <span>{percent(enterprise.entityDeliveryRate)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </SaasShell>
  );
}

function CoverageBar({ label, value }: Readonly<{ label: string; value: number | undefined }>) {
  const normalized = Math.max(0, Math.min(1, value ?? 0));
  return (
    <div className="quotaBar geoCoverageBar">
      <div>
        <span>{label}</span>
        <strong>{percent(normalized)}</strong>
      </div>
      <progress max={1} value={normalized} />
    </div>
  );
}

function Metric({
  detail,
  label,
  tone,
  value,
}: Readonly<{ detail: string; label: string; tone?: string; value: number | string | undefined }>) {
  return (
    <article className={`metricCard ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value ?? "—"}</strong>
      <small>{detail}</small>
    </article>
  );
}

function percent(value: number | undefined): string {
  if (value === undefined) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1, style: "percent" }).format(
    value,
  );
}

function gapLabel(value: Gap["gapType"]): string {
  if (value === "NOT_TARGETED") return "暂未使用";
  if (value === "NOT_DELIVERED") return "文案未提及";
  return "部分文案提及";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(value));
}

function GeoLoading() {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <span className="appEyebrow" suppressHydrationWarning>
          GEO COVERAGE
        </span>
        <h1 suppressHydrationWarning>正在计算本地覆盖指标…</h1>
      </section>
    </main>
  );
}
