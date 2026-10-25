"use client";

import type { components } from "@xhs-agentic/contracts";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ActionConfirmDialog } from "../../components/action-confirm-dialog";
import { ActionIcon } from "../../components/action-icon";
import { ConsoleScopeSwitcher } from "../../components/console-scope-switcher";
import { FeedbackMessage } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import { SaasShell, StatusBadge } from "../../components/saas-shell";
import { WorkspaceDrawer } from "../../components/workspace-drawer";
import { WorkspaceTabs } from "../../components/workspace-tabs";
import {
  apiRequest,
  consoleNavigationPermissions,
  selectedAdminRoleName,
} from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";

type SensitiveRule = components["schemas"]["SensitiveRuleResponseDto"];
type GeoTopic = components["schemas"]["GeoTopicResponseDto"];
type GeoEntity = components["schemas"]["GeoEntityWithTopicsDto"];
type FocusRecommendation = components["schemas"]["FocusRecommendationDto"];
type SensitiveRuleImportReport = components["schemas"]["SensitiveRuleImportReportResponseDto"];
type ComplianceTab = "ENTITIES" | "IMPORT" | "RULES" | "TOPICS";
type EditorMode = "ENTITY" | "RULE" | "TOPIC";
type PendingAssetDisable = Readonly<{
  collection: "geo-entities" | "geo-topics" | "sensitive-rules";
  enterpriseId: string | null;
  id: string;
  label: string;
  typeLabel: string;
}>;

export default function CompliancePage() {
  const auth = useMvpSession();
  const [rules, setRules] = useState<SensitiveRule[]>([]);
  const [entities, setEntities] = useState<GeoEntity[]>([]);
  const [recommendations, setRecommendations] = useState<FocusRecommendation[]>([]);
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [recommendationSource, setRecommendationSource] = useState<string | null>(null);
  const [recommendationLimit, setRecommendationLimit] = useState(6);
  const loadVersion = useRef(0);
  const [ruleForm, setRuleForm] = useState({
    changeNote: "",
    replacementSuggestion: "",
    riskType: "绝对化承诺",
    scope: "ENTERPRISE" as "ENTERPRISE" | "SHARED",
    severity: "BLOCK",
    term: "",
  });
  const [entityForm, setEntityForm] = useState({
    aliases: "",
    changeNote: "",
    name: "",
    scope: "ENTERPRISE" as "ENTERPRISE" | "SHARED",
    type: "TECHNOLOGY",
  });
  const [topicForm, setTopicForm] = useState({
    changeNote: "",
    entityId: "",
    intent: "科普认知",
    priority: 50,
    question: "",
  });
  const [editingRule, setEditingRule] = useState<SensitiveRule | null>(null);
  const [editingEntity, setEditingEntity] = useState<GeoEntity | null>(null);
  const [editingTopic, setEditingTopic] = useState<GeoTopic | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [csvScope, setCsvScope] = useState<"ENTERPRISE" | "SHARED">("ENTERPRISE");
  const [csvText, setCsvText] = useState(
    "term,severity,riskType,replacementSuggestion,effectiveFrom,effectiveTo\n绝对治愈,BLOCK,医疗绝对化,规范改善,,",
  );
  const [csvReport, setCsvReport] = useState<SensitiveRuleImportReport | null>(null);
  const [activeTab, setActiveTab] = useState<ComplianceTab>("RULES");
  const [editorMode, setEditorMode] = useState<EditorMode | null>(null);
  const [pendingDisable, setPendingDisable] = useState<PendingAssetDisable | null>(null);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tab") === "focus")
      setActiveTab("ENTITIES");
  }, []);

  const canManageShared = Boolean(
    auth.session?.adminAccess.scopes.some(
      (scope) =>
        scope.scopeType === "TENANT" &&
        scope.tenant?.id === auth.session?.tenantId &&
        scope.permissions.includes("tenant.shared-material.manage"),
    ),
  );

  const load = useCallback(async () => {
    if (!auth.session) return;
    const version = ++loadVersion.current;
    setError(null);
    setRecommendations([]);
    setRecommendationLimit(6);
    setRecommendationError(null);
    const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}`;
    try {
      const [ruleRows, entityRows] = await Promise.all([
        apiRequest<SensitiveRule[]>(`${base}/sensitive-rules`, { token: auth.session.adminToken }),
        apiRequest<GeoEntity[]>(`${base}/geo-entities`, { token: auth.session.adminToken }),
      ]);
      if (version !== loadVersion.current) return;
      setRules(ruleRows);
      setEntities(entityRows);
      // Optional recommendations must not block the existing rules and focus list.
      void apiRequest<FocusRecommendation[]>(`${base}/focus-recommendations`, {
        token: auth.session.adminToken,
      })
        .then((rows) => {
          if (version === loadVersion.current) setRecommendations(rows);
        })
        .catch(() => {
          if (version === loadVersion.current)
            setRecommendationError("暂时无法读取资料推荐，仍可手动添加宣传重点。");
        });
      setTopicForm((current) => {
        const manageable = entityRows.filter(
          (entity) => entity.status === "ACTIVE" && (entity.enterpriseId || canManageShared),
        );
        return manageable.some(({ id }) => id === current.entityId)
          ? current
          : { ...current, entityId: manageable[0]?.id ?? "" };
      });
    } catch (reason) {
      if (version === loadVersion.current) setError(messageOf(reason));
    }
  }, [auth.session, canManageShared]);
  useEffect(() => {
    void load();
    return () => {
      loadVersion.current++;
    };
  }, [load]);

  async function createRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session) return;
    setBusy("rule");
    setError(null);
    setNotice(null);
    try {
      const root = `/console/tenants/${auth.session.tenantId}`;
      const ownerScope = editingRule
        ? editingRule.enterpriseId
          ? "ENTERPRISE"
          : "SHARED"
        : ruleForm.scope;
      const base =
        ownerScope === "SHARED" ? root : `${root}/enterprises/${auth.session.enterpriseId}`;
      const path = editingRule
        ? `${base}/sensitive-rules/${editingRule.id}/versions`
        : `${base}/sensitive-rules`;
      await apiRequest(path, {
        body: {
          changeNote: editingRule ? ruleForm.changeNote : undefined,
          replacementSuggestion: ruleForm.replacementSuggestion || undefined,
          riskType: ruleForm.riskType,
          severity: ruleForm.severity,
          term: ruleForm.term,
        },
        method: "POST",
        token: auth.session.adminToken,
      });
      setRuleForm({ ...ruleForm, changeNote: "", replacementSuggestion: "", term: "" });
      setNotice(
        editingRule
          ? `敏感规则 v${editingRule.version + 1} 已发布`
          : "敏感规则已生效，将用于后续活动",
      );
      setEditingRule(null);
      setEditorMode(null);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  }

  async function importRulesCsv(dryRun: boolean) {
    if (!auth.session) return;
    setBusy("rule-csv");
    setError(null);
    setNotice(null);
    try {
      const root = `/console/tenants/${auth.session.tenantId}`;
      const base =
        csvScope === "SHARED" ? root : `${root}/enterprises/${auth.session.enterpriseId}`;
      const report = await apiRequest<SensitiveRuleImportReport>(
        `${base}/sensitive-rules/import-csv`,
        {
          body: { csv: csvText, dryRun },
          method: "POST",
          token: auth.session.adminToken,
        },
      );
      setCsvReport(report);
      if (!dryRun) {
        setNotice(`敏感规则批量导入完成：新增 ${report.counts.CREATED ?? 0} 条`);
        await load();
      }
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  }

  async function createEntity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session) return;
    setBusy("entity");
    setError(null);
    setNotice(null);
    try {
      const root = `/console/tenants/${auth.session.tenantId}`;
      const ownerScope = editingEntity
        ? editingEntity.enterpriseId
          ? "ENTERPRISE"
          : "SHARED"
        : entityForm.scope;
      const base =
        ownerScope === "SHARED" ? root : `${root}/enterprises/${auth.session.enterpriseId}`;
      const path = editingEntity
        ? `${base}/geo-entities/${editingEntity.id}/versions`
        : `${base}/geo-entities`;
      const created = await apiRequest<GeoEntity>(path, {
        body: {
          aliases: entityForm.aliases
            .split(/[，,]/u)
            .map((value) => value.trim())
            .filter(Boolean),
          changeNote: editingEntity ? entityForm.changeNote : undefined,
          name: entityForm.name,
          type: entityForm.type,
        },
        method: "POST",
        token: auth.session.adminToken,
      });
      setEntityForm({ ...entityForm, aliases: "", changeNote: "", name: "" });
      setTopicForm((current) => ({ ...current, entityId: created.id }));
      setNotice(editingEntity ? `宣传重点 v${editingEntity.version + 1} 已发布` : "宣传重点已创建");
      setEditingEntity(null);
      setEditorMode(null);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  }

  async function createTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session) return;
    setBusy("topic");
    setError(null);
    setNotice(null);
    try {
      const entity = entities.find(({ id }) => id === topicForm.entityId);
      if (!entity) throw new Error("请选择有效的 宣传重点");
      const root = `/console/tenants/${auth.session.tenantId}`;
      const ownerScope = editingTopic
        ? editingTopic.enterpriseId
          ? "ENTERPRISE"
          : "SHARED"
        : entity.enterpriseId
          ? "ENTERPRISE"
          : "SHARED";
      const base =
        ownerScope === "SHARED" ? root : `${root}/enterprises/${auth.session.enterpriseId}`;
      const path = editingTopic
        ? `${base}/geo-topics/${editingTopic.id}/versions`
        : `${base}/geo-topics`;
      await apiRequest(path, {
        body: {
          changeNote: editingTopic ? topicForm.changeNote : undefined,
          entityId: topicForm.entityId,
          intent: topicForm.intent,
          priority: topicForm.priority,
          question: topicForm.question,
        },
        method: "POST",
        token: auth.session.adminToken,
      });
      setTopicForm({ ...topicForm, changeNote: "", question: "" });
      setNotice(
        editingTopic ? `用户问题 v${editingTopic.version + 1} 已发布` : "用户问题已加入内容资产",
      );
      setEditingTopic(null);
      setEditorMode(null);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  }

  function beginRuleVersion(rule: SensitiveRule) {
    setEditingRule(rule);
    setRuleForm({
      changeNote: "",
      replacementSuggestion: rule.replacementSuggestion ?? "",
      riskType: rule.riskType,
      scope: rule.enterpriseId ? "ENTERPRISE" : "SHARED",
      severity: rule.severity,
      term: rule.term,
    });
    setEditorMode("RULE");
  }

  function beginEntityVersion(entity: GeoEntity) {
    setRecommendationSource(null);
    setEditingEntity(entity);
    setEntityForm({
      aliases: entity.aliases.join(", "),
      changeNote: "",
      name: entity.name,
      scope: entity.enterpriseId ? "ENTERPRISE" : "SHARED",
      type: entity.type,
    });
    setEditorMode("ENTITY");
  }

  function beginTopicVersion(topic: GeoTopic) {
    setEditingTopic(topic);
    setTopicForm({
      changeNote: "",
      entityId: entities.find(({ topics }) => topics.some(({ id }) => id === topic.id))?.id ?? "",
      intent: topic.intent,
      priority: topic.priority,
      question: topic.question,
    });
    setEditorMode("TOPIC");
  }

  function beginRuleCreate() {
    setEditingRule(null);
    setRuleForm({
      changeNote: "",
      replacementSuggestion: "",
      riskType: "绝对化承诺",
      scope: "ENTERPRISE",
      severity: "BLOCK",
      term: "",
    });
    setEditorMode("RULE");
  }

  function beginEntityCreate() {
    setRecommendationSource(null);
    setEditingEntity(null);
    setEntityForm({
      aliases: "",
      changeNote: "",
      name: "",
      scope: "ENTERPRISE",
      type: "TECHNOLOGY",
    });
    setEditorMode("ENTITY");
  }

  function beginTopicCreate() {
    setEditingTopic(null);
    setTopicForm((current) => ({
      changeNote: "",
      entityId: manageableEntityId(entities, canManageShared, current.entityId),
      intent: "科普认知",
      priority: 50,
      question: "",
    }));
    setEditorMode("TOPIC");
  }

  async function disableAsset(
    collection: "geo-entities" | "geo-topics" | "sensitive-rules",
    id: string,
    enterpriseId: string | null,
    reason: string,
  ) {
    if (!auth.session) return;
    setBusy(`disable-${id}`);
    setError(null);
    setNotice(null);
    try {
      const root = `/console/tenants/${auth.session.tenantId}`;
      const base = enterpriseId ? `${root}/enterprises/${auth.session.enterpriseId}` : root;
      await apiRequest(`${base}/${collection}/${id}/disable`, {
        body: { reason },
        method: "POST",
        token: auth.session.adminToken,
      });
      setNotice("内容资产已停用；只影响后续活动，已创建的活动不受影响");
      setPendingDisable(null);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  }

  if (auth.session === undefined) return <ComplianceLoading />;
  if (auth.session === null)
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  const latestRuleVersions = latestVersions(rules);
  const latestEntityVersions = latestVersions(entities);
  const latestTopicVersions = latestVersions(entities.flatMap(({ topics }) => topics));
  const manageableEntities = entities.filter(
    (entity) => entity.status === "ACTIVE" && (entity.enterpriseId || canManageShared),
  );
  const activeRules = rules.filter(({ status }) => status === "ACTIVE");
  const activeEntities = entities.filter(({ status }) => status === "ACTIVE");
  const topicRows = entities.flatMap((entity) => entity.topics.map((topic) => ({ entity, topic })));
  const activeTopics = topicRows.filter(({ topic }) => topic.status === "ACTIVE").length;
  return (
    <SaasShell
      active="compliance"
      description="敏感规则约束表达风险；宣传重点与用户问题按需设置，不影响正常生成。"
      mode="console"
      navigationPermissions={consoleNavigationPermissions(auth.session)}
      roleLabel={selectedAdminRoleName(auth.session)}
      scopeControl={<ConsoleScopeSwitcher onChange={auth.setSession} session={auth.session} />}
      scopeName={`${auth.session.tenantName} · ${auth.session.enterpriseName}`}
      title="内容规范"
      toolbar={
        <div className="workspaceActionButtons">
          <button className="ghostButton refreshButton" onClick={() => void load()} type="button">
            刷新
          </button>
          {activeTab === "RULES" ? (
            <button className="primaryButton createButton" onClick={beginRuleCreate} type="button">
              新增规则
            </button>
          ) : activeTab === "ENTITIES" ? (
            <button className="primaryButton" onClick={beginEntityCreate} type="button">
              新增宣传重点
            </button>
          ) : activeTab === "TOPICS" ? (
            <button className="primaryButton" onClick={beginTopicCreate} type="button">
              新增用户问题
            </button>
          ) : null}
        </div>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      <section className="metricGrid four">
        <Metric
          detail="直接阻断生成风险"
          label="阻断规则"
          value={activeRules.filter(({ severity }) => severity === "BLOCK").length}
          tone="accent"
        />
        <Metric
          detail="提醒运营抽检"
          label="警告与提示"
          value={activeRules.filter(({ severity }) => severity !== "BLOCK").length}
        />
        <Metric detail="可选的内容方向" label="宣传重点" value={activeEntities.length} />
        <Metric detail="可选的客户常见问题" label="用户问题" value={activeTopics} />
      </section>
      <section className="workspaceActionBar">
        <WorkspaceTabs
          active={activeTab}
          ariaLabel="内容规范工作视图"
          onChange={setActiveTab}
          tabs={[
            { count: activeRules.length, key: "RULES", label: "敏感规则" },
            { count: activeEntities.length, key: "ENTITIES", label: "宣传重点" },
            { count: activeTopics, key: "TOPICS", label: "用户问题" },
            { key: "IMPORT", label: "批量导入" },
          ]}
        />
      </section>
      <section className="complianceWorkspace">
        <div className="formStack">
          <article className="panel" hidden={activeTab !== "RULES"}>
            <div className="panelHeader">
              <div>
                <span className="sectionKicker">敏感规则</span>
                <h2>生成内容不能出现什么</h2>
                <p>集团公共规则和企业规则在生成时共同生效。</p>
              </div>
            </div>
            <div className="ruleList">
              {rules.map((rule) => (
                <article key={rule.id}>
                  <StatusBadge
                    tone={
                      rule.severity === "BLOCK"
                        ? "danger"
                        : rule.severity === "WARNING"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {severityLabel(rule.severity)}
                  </StatusBadge>
                  <div>
                    <strong>{rule.term}</strong>
                    <small>
                      {rule.riskType} · {rule.enterpriseId ? "企业规则" : "集团规则"} · v
                      {rule.version} · {rule.status === "ACTIVE" ? "生效中" : "历史版本"}
                    </small>
                  </div>
                  <div className="contentAssetSummary">
                    <p>{rule.replacementSuggestion ?? "未设置替代表达"}</p>
                    {latestRuleVersions.get(rule.seriesId) === rule.version &&
                    (rule.enterpriseId || canManageShared) ? (
                      <div className="contentAssetActions">
                        <button onClick={() => beginRuleVersion(rule)} type="button">
                          {rule.status === "ACTIVE" ? "新版本" : "恢复"}
                        </button>
                        {rule.status === "ACTIVE" ? (
                          <button
                            className="dangerText"
                            disabled={busy === `disable-${rule.id}`}
                            onClick={() =>
                              setPendingDisable({
                                collection: "sensitive-rules",
                                enterpriseId: rule.enterpriseId,
                                id: rule.id,
                                label: rule.term,
                                typeLabel: "敏感规则",
                              })
                            }
                            type="button"
                          >
                            停用
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </article>
              ))}
              {rules.length === 0 ? <p className="emptyHint">尚未设置敏感规则。</p> : null}
            </div>
          </article>
          <article className="panel" hidden={activeTab !== "ENTITIES" && activeTab !== "TOPICS"}>
            <div className="panelHeader">
              <div>
                <span className="sectionKicker">
                  {activeTab === "ENTITIES" ? "宣传重点" : "用户问题"}
                </span>
                <h2>{activeTab === "ENTITIES" ? "希望内容突出什么？" : "用户真正关心的问题"}</h2>
                <p>
                  {activeTab === "ENTITIES"
                    ? "可选设置。先从已有资料确认名称，活动按相关性匹配；不设置也能正常生成。"
                    : "按需补充客户常问的问题，作为相关活动的参考，不是每篇都要回答。"}
                </p>
              </div>
            </div>
            {activeTab === "ENTITIES" ? (
              <section className="focusRecommendations" aria-label="从资料推荐宣传重点">
                <div className="focusSectionHeading">
                  <div>
                    <strong>从资料中发现</strong>
                    <p>确认后才会加入宣传重点，不会自动改动资料。</p>
                  </div>
                  <a href="/console/materials" className="textLink">
                    管理品牌资料
                  </a>
                </div>
                {recommendationError ? <p className="mutedText">{recommendationError}</p> : null}
                {recommendations.length ? (
                  recommendations.slice(0, recommendationLimit).map((item) => (
                    <div className="focusRecommendationRow" key={`${item.materialId}:${item.name}`}>
                      <div>
                        <strong>{item.name}</strong>
                        <small>
                          {entityTypeLabel(item.type)} · 来自「{item.materialTitle}」
                        </small>
                        <p>{item.evidence}</p>
                      </div>
                      <button
                        className="ghostButton"
                        type="button"
                        onClick={() => {
                          setEditingEntity(null);
                          setEntityForm({
                            name: item.name,
                            aliases: item.aliases.join(", "),
                            type: item.type,
                            scope: "ENTERPRISE",
                            changeNote: "",
                          });
                          setRecommendationSource(item.materialTitle);
                          setEditorMode("ENTITY");
                        }}
                      >
                        <ActionIcon name="plus" />
                        确认添加
                      </button>
                    </div>
                  ))
                ) : !recommendationError ? (
                  <p className="mutedText">
                    暂无新推荐。上传并完成资料分析后，可在这里确认；也可直接手动添加。
                  </p>
                ) : null}
                {recommendations.length > recommendationLimit ? (
                  <button
                    className="ghostButton"
                    type="button"
                    onClick={() => setRecommendationLimit((limit) => limit + 6)}
                  >
                    查看更多推荐（还有 {recommendations.length - recommendationLimit} 项）
                  </button>
                ) : null}
              </section>
            ) : null}
            <div className="geoList">
              {activeTab === "ENTITIES"
                ? entities.map((entity) => (
                    <article key={entity.id}>
                      <div>
                        <span>
                          {entity.enterpriseId ? "企业" : "集团"} · {entityTypeLabel(entity.type)}
                        </span>
                        <strong>{entity.name}</strong>
                        <small>{entity.aliases.join(" · ") || "无别名"}</small>
                      </div>
                      <div className="contentAssetSummary">
                        <p>
                          已维护 {entity.topics.filter(({ status }) => status === "ACTIVE").length}{" "}
                          个有效用户问题
                        </p>
                        <small>
                          v{entity.version} · {assetStatusLabel(entity.status)}
                        </small>
                        {latestEntityVersions.get(entity.seriesId) === entity.version &&
                        (entity.enterpriseId || canManageShared) ? (
                          <div className="contentAssetActions">
                            <button onClick={() => beginEntityVersion(entity)} type="button">
                              {entity.status === "ACTIVE" ? "编辑" : "重新启用"}
                            </button>
                            {entity.status === "ACTIVE" ? (
                              <button
                                className="dangerText"
                                disabled={busy === `disable-${entity.id}`}
                                onClick={() =>
                                  setPendingDisable({
                                    collection: "geo-entities",
                                    enterpriseId: entity.enterpriseId,
                                    id: entity.id,
                                    label: entity.name,
                                    typeLabel: "宣传重点",
                                  })
                                }
                                type="button"
                              >
                                停用
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </article>
                  ))
                : topicRows.map(({ entity, topic }) => (
                    <article key={topic.id}>
                      <div>
                        <span>{entity.name}</span>
                        <strong>{topic.intent}</strong>
                        <small>优先级 {topic.priority} / 100</small>
                      </div>
                      <div className="contentAssetSummary">
                        <p>{topic.question}</p>
                        <small>
                          v{topic.version} · {assetStatusLabel(topic.status)}
                        </small>
                        {entity.status === "ACTIVE" &&
                        latestTopicVersions.get(topic.seriesId) === topic.version &&
                        (topic.enterpriseId || canManageShared) ? (
                          <div className="contentAssetActions">
                            <button onClick={() => beginTopicVersion(topic)} type="button">
                              {topic.status === "ACTIVE" ? "发布新版本" : "新版本恢复"}
                            </button>
                            {topic.status === "ACTIVE" ? (
                              <button
                                className="dangerText"
                                disabled={busy === `disable-${topic.id}`}
                                onClick={() =>
                                  setPendingDisable({
                                    collection: "geo-topics",
                                    enterpriseId: topic.enterpriseId,
                                    id: topic.id,
                                    label: topic.question,
                                    typeLabel: "用户问题",
                                  })
                                }
                                type="button"
                              >
                                停用
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </article>
                  ))}
              {(activeTab === "ENTITIES" ? entities.length : topicRows.length) === 0 ? (
                <div className="emptyState compact">
                  <strong>
                    {activeTab === "ENTITIES" ? "尚未建立宣传重点" : "尚未维护用户问题"}
                  </strong>
                  <p>可从资料推荐中确认，也可手动添加；暂不设置也可以直接创建活动。</p>
                </div>
              ) : null}
            </div>
          </article>
        </div>
        <div className="formStack">
          <article className="panel formFlow" hidden={activeTab !== "IMPORT"}>
            <div className="panelHeader">
              <div>
                <span className="sectionKicker">批量导入</span>
                <h2>批量导入敏感规则</h2>
                <p>先检查冲突和逐行错误；确认后导入同一份 CSV 不会重复创建规则。</p>
              </div>
            </div>
            <label className="field">
              <span>规则作用域</span>
              <select
                onChange={(event) => setCsvScope(event.target.value as typeof csvScope)}
                value={csvScope}
              >
                <option value="ENTERPRISE">当前企业</option>
                {canManageShared ? <option value="SHARED">集团公共</option> : null}
              </select>
            </label>
            <label className="field">
              <span>CSV 内容</span>
              <textarea
                onChange={(event) => setCsvText(event.target.value)}
                rows={7}
                value={csvText}
              />
            </label>
            {csvReport ? (
              <div className="csvImportReport">
                <strong>{csvReport.dryRun ? "预检结果" : "导入结果"}</strong>
                <span>
                  {Object.entries(csvReport.counts)
                    .map(([status, count]) => `${importStatusLabel(status)} ${count}`)
                    .join(" · ")}
                </span>
                {csvReport.rows
                  .filter((row) => row.status === "ERROR" || row.status === "CONFLICT")
                  .slice(0, 8)
                  .map((row) => (
                    <small key={`${String(row.row)}-${String(row.term ?? "")}`}>
                      第 {String(row.row)} 行：{String(row.message ?? row.status)}
                    </small>
                  ))}
              </div>
            ) : null}
            <div className="materialActions">
              <button
                disabled={busy === "rule-csv"}
                onClick={() => void importRulesCsv(true)}
                type="button"
              >
                预检 CSV
              </button>
              <button
                disabled={busy === "rule-csv"}
                onClick={() => void importRulesCsv(false)}
                type="button"
              >
                确认导入
              </button>
            </div>
          </article>
          <WorkspaceDrawer
            description={
              editingRule
                ? "新版本会用于后续活动，已经创建的活动继续保留原规则记录。"
                : "阻断规则会直接阻止内容通过，警告和提示用于提醒运营抽检。"
            }
            onClose={() => {
              setEditorMode(null);
              setEditingRule(null);
            }}
            open={editorMode === "RULE"}
            title={editingRule ? `发布规则 v${editingRule.version + 1}` : "新增敏感规则"}
          >
            <form className="drawerForm" onSubmit={(event) => void createRule(event)}>
              <label className="field">
                <span>规则作用域</span>
                <select
                  disabled={Boolean(editingRule)}
                  value={ruleForm.scope}
                  onChange={(event) =>
                    setRuleForm({ ...ruleForm, scope: event.target.value as typeof ruleForm.scope })
                  }
                >
                  <option value="ENTERPRISE">当前企业补充 / 覆盖</option>
                  {canManageShared ? <option value="SHARED">集团公共规则</option> : null}
                </select>
              </label>
              <label className="field">
                <span>敏感词 / 表达</span>
                <input
                  required
                  value={ruleForm.term}
                  onChange={(event) => setRuleForm({ ...ruleForm, term: event.target.value })}
                />
              </label>
              <div className="fieldGrid">
                <label className="field">
                  <span>风险类型</span>
                  <input
                    required
                    value={ruleForm.riskType}
                    onChange={(event) => setRuleForm({ ...ruleForm, riskType: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>严重程度</span>
                  <select
                    value={ruleForm.severity}
                    onChange={(event) => setRuleForm({ ...ruleForm, severity: event.target.value })}
                  >
                    <option value="BLOCK">阻断</option>
                    <option value="WARNING">警告</option>
                    <option value="NOTICE">提示</option>
                  </select>
                </label>
              </div>
              <label className="field">
                <span>建议替代表达</span>
                <input
                  value={ruleForm.replacementSuggestion}
                  onChange={(event) =>
                    setRuleForm({ ...ruleForm, replacementSuggestion: event.target.value })
                  }
                />
              </label>
              {editingRule ? (
                <label className="field">
                  <span>版本变更说明</span>
                  <input
                    required
                    value={ruleForm.changeNote}
                    onChange={(event) =>
                      setRuleForm({ ...ruleForm, changeNote: event.target.value })
                    }
                  />
                </label>
              ) : null}
              <button className="primaryButton block" disabled={busy === "rule"} type="submit">
                {editingRule ? "发布不可变新版本" : "保存规则"}
              </button>
              {editingRule ? (
                <button
                  className="ghostButton block"
                  onClick={() => {
                    setEditingRule(null);
                    setEditorMode(null);
                  }}
                  type="button"
                >
                  返回规则列表
                </button>
              ) : null}
            </form>
          </WorkspaceDrawer>
          <WorkspaceDrawer
            description="统一品牌、人物、产品或服务的称呼。这里只设置宣传方向，事实与资质仍以品牌资料为依据。"
            onClose={() => {
              setEditorMode(null);
              setEditingEntity(null);
            }}
            open={editorMode === "ENTITY"}
            title={editingEntity ? `编辑宣传重点 · v${editingEntity.version + 1}` : "新增宣传重点"}
          >
            <form className="drawerForm" onSubmit={(event) => void createEntity(event)}>
              {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
              {recommendationSource ? (
                <p className="focusSourceNote">
                  来自「{recommendationSource}」。请核对名称与其他称呼，确认后保存。
                </p>
              ) : null}
              <label className="field">
                <span>适用范围</span>
                <select
                  disabled={Boolean(editingEntity)}
                  value={entityForm.scope}
                  onChange={(event) =>
                    setEntityForm({
                      ...entityForm,
                      scope: event.target.value as typeof entityForm.scope,
                    })
                  }
                >
                  <option value="ENTERPRISE">当前企业补充 / 覆盖</option>
                  {canManageShared ? <option value="SHARED">集团共享</option> : null}
                </select>
              </label>
              <div className="fieldGrid">
                <label className="field">
                  <span>类别</span>
                  <select
                    value={entityForm.type}
                    onChange={(event) => setEntityForm({ ...entityForm, type: event.target.value })}
                  >
                    {[
                      "BRAND",
                      "ENTERPRISE",
                      "DOCTOR",
                      "DEVICE",
                      "TECHNOLOGY",
                      "SERVICE",
                      "LOCATION",
                    ].map((type) => (
                      <option key={type} value={type}>
                        {entityTypeLabel(type)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>名称</span>
                  <input
                    required
                    minLength={2}
                    maxLength={200}
                    value={entityForm.name}
                    onChange={(event) => setEntityForm({ ...entityForm, name: event.target.value })}
                  />
                </label>
              </div>
              <label className="field">
                <span>其他称呼（逗号分隔，可选）</span>
                <input
                  value={entityForm.aliases}
                  onChange={(event) =>
                    setEntityForm({ ...entityForm, aliases: event.target.value })
                  }
                />
              </label>
              {editingEntity ? (
                <label className="field">
                  <span>版本变更说明</span>
                  <input
                    required
                    value={entityForm.changeNote}
                    onChange={(event) =>
                      setEntityForm({ ...entityForm, changeNote: event.target.value })
                    }
                  />
                </label>
              ) : null}
              <button className="primaryButton block" disabled={busy === "entity"} type="submit">
                <ActionIcon name="check" />
                {editingEntity ? "保存修改" : "确认添加"}
              </button>
              {editingEntity ? (
                <button
                  className="ghostButton block"
                  onClick={() => {
                    setEditingEntity(null);
                    setEditorMode(null);
                  }}
                  type="button"
                >
                  返回宣传重点列表
                </button>
              ) : null}
            </form>
          </WorkspaceDrawer>
          <WorkspaceDrawer
            description="把真实用户会搜索、咨询或犹豫的问题维护进来，后续活动可围绕这些问题持续生成内容。"
            onClose={() => {
              setEditorMode(null);
              setEditingTopic(null);
            }}
            open={editorMode === "TOPIC"}
            title={editingTopic ? `发布问题 v${editingTopic.version + 1}` : "新增用户问题"}
          >
            <form className="drawerForm" onSubmit={(event) => void createTopic(event)}>
              <label className="field">
                <span>所属宣传重点</span>
                <select
                  required
                  value={topicForm.entityId}
                  onChange={(event) => setTopicForm({ ...topicForm, entityId: event.target.value })}
                >
                  <option value="">请选择</option>
                  {manageableEntities.map((entity) => (
                    <option key={entity.id} value={entity.id}>
                      {entity.name} · {entity.enterpriseId ? "企业" : "集团"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>用户问题</span>
                <textarea
                  required
                  rows={3}
                  value={topicForm.question}
                  onChange={(event) => setTopicForm({ ...topicForm, question: event.target.value })}
                />
              </label>
              <div className="fieldGrid">
                <label className="field">
                  <span>搜索意图</span>
                  <input
                    required
                    value={topicForm.intent}
                    onChange={(event) => setTopicForm({ ...topicForm, intent: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>优先级 0–100</span>
                  <input
                    max={100}
                    min={0}
                    type="number"
                    value={topicForm.priority}
                    onChange={(event) =>
                      setTopicForm({ ...topicForm, priority: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
              {editingTopic ? (
                <label className="field">
                  <span>版本变更说明</span>
                  <input
                    required
                    value={topicForm.changeNote}
                    onChange={(event) =>
                      setTopicForm({ ...topicForm, changeNote: event.target.value })
                    }
                  />
                </label>
              ) : null}
              <button
                className="primaryButton block"
                disabled={busy === "topic" || manageableEntities.length === 0}
                type="submit"
              >
                {editingTopic ? "发布新版本" : "加入用户问题库"}
              </button>
              {editingTopic ? (
                <button
                  className="ghostButton block"
                  onClick={() => {
                    setEditingTopic(null);
                    setEditorMode(null);
                  }}
                  type="button"
                >
                  返回问题列表
                </button>
              ) : null}
            </form>
          </WorkspaceDrawer>
        </div>
      </section>
      <ActionConfirmDialog
        busy={Boolean(pendingDisable && busy === `disable-${pendingDisable.id}`)}
        onCancel={() => setPendingDisable(null)}
        onConfirm={(reason) => {
          if (pendingDisable) {
            void disableAsset(
              pendingDisable.collection,
              pendingDisable.id,
              pendingDisable.enterpriseId,
              reason,
            );
          }
        }}
        state={
          pendingDisable
            ? {
                confirmLabel: `确认停用${pendingDisable.typeLabel}`,
                defaultReason: "内容规范已调整，不再用于后续活动",
                impacts: [
                  `“${pendingDisable.label}”不会再用于后续活动。`,
                  "已创建的活动会继续使用原有内容，不影响既有生成结果。",
                  "需要恢复时应发布经过确认的新版本。",
                ],
                reasonLabel: "停用原因",
                summary: `即将停用当前${pendingDisable.typeLabel}。`,
                title: `确认停用这项${pendingDisable.typeLabel}？`,
                tone: "warning",
              }
            : null
        }
      />
    </SaasShell>
  );
}

function Metric({
  detail,
  label,
  tone,
  value,
}: Readonly<{ detail: string; label: string; tone?: string; value: number }>) {
  return (
    <article className={`metricCard ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function latestVersions<T extends Readonly<{ seriesId: string; version: number }>>(
  values: readonly T[],
): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) {
    result.set(value.seriesId, Math.max(result.get(value.seriesId) ?? 0, value.version));
  }
  return result;
}

function manageableEntityId(
  entities: readonly GeoEntity[],
  canManageShared: boolean,
  currentId: string,
): string {
  const manageable = entities.filter(
    (entity) => entity.status === "ACTIVE" && (entity.enterpriseId || canManageShared),
  );
  return manageable.some(({ id }) => id === currentId) ? currentId : (manageable[0]?.id ?? "");
}

function severityLabel(severity: SensitiveRule["severity"]): string {
  return severity === "BLOCK" ? "阻断" : severity === "WARNING" ? "警告" : "提示";
}

function assetStatusLabel(status: string): string {
  return status === "ACTIVE" ? "生效中" : "历史版本";
}

function entityTypeLabel(type: string): string {
  return (
    {
      BRAND: "品牌",
      DEVICE: "产品 / 设备",
      DOCTOR: "人物",
      ENTERPRISE: "企业",
      LOCATION: "地点",
      SERVICE: "服务",
      TECHNOLOGY: "技术",
    }[type] ?? type
  );
}

function importStatusLabel(status: string): string {
  return (
    {
      CONFLICT: "冲突",
      CREATED: "新增",
      ERROR: "错误",
      SKIPPED: "跳过",
      UPDATED: "更新",
    }[status] ?? status
  );
}

function ComplianceLoading() {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <span className="appEyebrow" suppressHydrationWarning>
          内容规范
        </span>
        <h1 suppressHydrationWarning>正在读取敏感规则与品牌认知资产…</h1>
      </section>
    </main>
  );
}
