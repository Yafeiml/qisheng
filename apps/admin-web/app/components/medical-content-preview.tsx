import Image from "next/image";
import { type MedicalExampleTopic, medicalContentExamples } from "../lib/medical-content-examples";
import { type MedicalSelection, medicalSelectionLabels } from "../lib/medical-selection";
import styles from "./medical-content-preview.module.css";

export function MedicalContentPreview({
  topic = "ARRIVAL",
  noteForm = "QUESTION_LIST",
  imageMode = "ORIGINAL_EDIT",
  compact = false,
}: {
  topic?: MedicalExampleTopic;
  noteForm?: MedicalSelection["noteForm"];
  imageMode?: MedicalSelection["imageMode"];
  compact?: boolean;
}) {
  if (noteForm === "PERSONAL_RECORD")
    return <p className={styles.note}>本人真实经历当前不可选。</p>;
  const example = medicalContentExamples[topic];
  return (
    <section
      className={`${styles.preview}${compact ? ` ${styles.compact}` : ""}`}
      aria-label="内容排版示意"
    >
      <header className={styles.header}>
        <strong>这类笔记的排版示意</strong>
        <span>{medicalSelectionLabels[imageMode]}</span>
      </header>
      <div className={styles.layout}>
        <figure className={styles.cover} aria-label="笔记封面排版示意">
          <Image
            src={example.image}
            width={540}
            height={720}
            sizes="(max-width: 640px) 160px, 190px"
            alt={`${example.label}笔记的抽象排版示意，非真实照片`}
          />
          <figcaption>内容排版示意图</figcaption>
        </figure>
        <article className={styles.copy} aria-label="笔记正文示例">
          <h3>{example.title}</h3>
          {example.body.split("\n\n").map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </article>
      </div>
      <p className={styles.useHint}>
        <strong>你只要提供：</strong>
        {example.useHint}
      </p>
      <p className={styles.note}>示意图，实际图片由配置模型生成。</p>
      <p className={styles.note}>晴光眼科为虚构员工示例，正式发布按真实资料与获准入口生成。</p>
    </section>
  );
}
