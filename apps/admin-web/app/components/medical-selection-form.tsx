"use client";

import {
  type MedicalOptions,
  type MedicalSelection,
  medicalSelectionLabels,
} from "../lib/medical-selection";
import { MedicalContentPreview } from "./medical-content-preview";
import styles from "./medical-selection-form.module.css";

export function MedicalSelectionForm({
  options,
  selection,
  onChange,
  disabled = false,
}: {
  options: MedicalOptions;
  selection: MedicalSelection;
  onChange: (value: MedicalSelection) => void;
  disabled?: boolean;
}) {
  const fields = [
    ["priority", "本次侧重点", options.priorities],
    ["readerSituation", "读者处境", options.readerSituations],
    ["noteForm", "笔记形式", options.noteForms],
    ["imageMode", "图片方式", options.imageModes],
    ["conversionPath", "成交承接", options.conversionPaths],
  ] as const;
  return (
    <section className={styles.form} aria-label="医疗活动内容选择">
      <div className={styles.objective}>
        <strong>小红书 GEO · 成交</strong>
        <span>
          {[options.enterprise.brandName || options.enterprise.name, options.enterprise.city]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <p>企业确定问题、素材和承接安排，员工只需确认真实并发布。</p>
      </div>
      <div className={styles.grid}>
        {fields.map(([key, label, values]) => (
          <label className={styles.field} key={key}>
            <span>{label}</span>
            <select
              aria-label={label}
              disabled={disabled}
              value={selection[key]}
              onChange={(event) =>
                onChange({
                  ...selection,
                  [key]: event.target.value,
                  ...(key === "imageMode" ? { originalImageConfirmed: false } : {}),
                })
              }
            >
              {values.map((value) => (
                <option
                  key={value}
                  value={value}
                  disabled={
                    key === "noteForm" &&
                    options.disabledNoteForms.some((item) => item.value === value)
                  }
                >
                  {medicalSelectionLabels[value] ?? value}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <MedicalContentPreview
        noteForm={selection.noteForm}
        imageMode={selection.imageMode}
        topic={
          selection.readerSituation === "BUDGET_QUESTIONS"
            ? "COST"
            : selection.readerSituation === "TIME_PLANNING"
              ? "TIME"
              : "ARRIVAL"
        }
      />
      {selection.imageMode === "ORIGINAL_EDIT" ? (
        <p className={styles.limit}>
          在素材区选择本次具体照片后确认授权与隐私；系统不生成患者、票据或诊疗现场作为事实证明。
        </p>
      ) : null}
      <fieldset className={styles.topics} disabled={disabled}>
        <legend>本次回答的问题</legend>
        <p>选择一个主要问题，或选择多个问题分配给不同成员。</p>
        {options.topics.length ? (
          options.topics.map((topic) => (
            <label className={styles.topic} key={topic.id}>
              <input
                type="checkbox"
                checked={selection.topicIds.includes(topic.id)}
                onChange={(event) =>
                  onChange({
                    ...selection,
                    topicIds: event.target.checked
                      ? [...selection.topicIds, topic.id]
                      : selection.topicIds.filter((id) => id !== topic.id),
                  })
                }
              />
              <span>
                {topic.question}
                {topic.entityName ? <small>{topic.entityName}</small> : null}
              </span>
            </label>
          ))
        ) : (
          <p className={styles.warning}>
            尚无可用问题。请由企业在 GEO 问题库中维护问题与依据后再生成。
          </p>
        )}
      </fieldset>
      {options.disabledNoteForms.map((item) => (
        <p className={styles.limit} key={item.value}>
          {medicalSelectionLabels[item.value] ?? item.value}：{item.reason}
        </p>
      ))}
      <div className={styles.unavailable}>
        <strong>已审广告成品 · 暂不可选</strong>
        <p>{options.approvedAdAssets.reason}</p>
      </div>
    </section>
  );
}
