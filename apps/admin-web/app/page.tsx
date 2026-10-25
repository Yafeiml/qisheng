import Link from "next/link";
import { LandingAdminLink } from "./components/landing-admin-link";
import { LandingRegistrationLink } from "./components/landing-registration-link";
import { PlatformLogo, PlatformName } from "./components/platform-branding";
import styles from "./landing.module.css";

const benefits = [
  {
    index: "01",
    title: "走进真实关系",
    description: "员工分享，触达更多真实社交圈。",
  },
  {
    index: "02",
    title: "表达贴合品牌",
    description: "可信素材生成独立图文，先审后发。",
  },
  {
    index: "03",
    title: "效果有迹可循",
    description: "发布链接可验证，传播效果可复盘。",
  },
] as const;

const employees = ["A", "B", "C", "D", "E"] as const;

export default function HomePage() {
  return (
    <main className={styles.page}>
      <div className={styles.frame}>
        <header className={styles.header}>
          <Link aria-label="返回产品首页" className={styles.brand} href="/">
            <PlatformLogo className={styles.brandMark} />
            <span>
              <strong>
                <PlatformName />
              </strong>
              <small>企业全员内容营销</small>
            </span>
          </Link>
          <LandingAdminLink className={styles.loginLink} />
        </header>

        <section aria-labelledby="landing-headline" className={styles.hero}>
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>
              <span className={styles.eyebrowDot} /> 让品牌传播，从每一位员工开始
            </span>
            <h1 className={styles.headline} id="landing-headline">
              好的品牌内容，
              <br />
              <span>让每位员工真实分享。</span>
            </h1>
            <p className={styles.intro}>
              <strong>一份可信品牌资料，变成每位员工的专属表达。</strong>
              <span>内容先审核，再由员工发布；链接可验证，效果可复盘。</span>
            </p>
            <LandingRegistrationLink className={styles.registerLink} />
          </div>

          <div aria-hidden="true" className={styles.visual}>
            <div className={styles.visualHeader}>
              <span className={styles.visualSignal}>
                <i />
                <i />
                <i />
              </span>
              <span>一份品牌资料 · 多个真实声音</span>
            </div>
            <div className={styles.visualCanvas}>
              <div className={styles.sourceCard}>
                <span className={styles.visualLabel}>BRAND SOURCE</span>
                <strong>企业可信素材</strong>
                <small>品牌信息 · 产品资料 · 活动主题</small>
              </div>
              <div className={styles.branchLine} />
              <div className={styles.people}>
                {employees.map((employee) => (
                  <div className={styles.person} key={employee}>
                    <span className={styles.avatar}>员</span>
                    <strong>员工 {employee}</strong>
                    <small>独立图文</small>
                  </div>
                ))}
              </div>
              <div className={styles.resultStrip}>
                <span className={styles.resultIcon}>✓</span> 员工发布 <span>→</span> 链接验证{" "}
                <span>→</span> 效果复盘
              </div>
            </div>
            <p className={styles.visualFootnote}>有统一的品牌依据，也保留每个人的表达。</p>
          </div>
        </section>

        <section aria-labelledby="landing-benefits" className={styles.benefits}>
          <div className={styles.sectionIntro}>
            <span className={styles.kicker}>WHY IT WORKS</span>
            <h2 id="landing-benefits">让全员参与，真正服务于品牌宣传</h2>
          </div>
          <div className={styles.benefitGrid}>
            {benefits.map((benefit) => (
              <article className={styles.benefit} key={benefit.index}>
                <span className={styles.benefitIndex}>{benefit.index}</span>
                <div>
                  <h3>{benefit.title}</h3>
                  <p>{benefit.description}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
