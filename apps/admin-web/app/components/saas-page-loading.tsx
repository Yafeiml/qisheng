export function SaasPageLoading({ label = "正在预载页面" }: Readonly<{ label?: string }>) {
  return (
    <section aria-busy="true" aria-live="polite" className="appWorkspace pagePreload" role="status">
      <div className="pagePreloadCenter">
        <span aria-hidden="true" className="xhsLoader large">
          <i />
          <i />
          <i />
        </span>
        <strong suppressHydrationWarning>{label}</strong>
        <small>正在准备页面结构和最新数据</small>
      </div>
      <div aria-hidden="true" className="pagePreloadSkeleton">
        <span className="wide" />
        <span className="medium" />
        <div>
          <i />
          <i />
          <i />
          <i />
        </div>
        <b />
        <b />
      </div>
    </section>
  );
}
