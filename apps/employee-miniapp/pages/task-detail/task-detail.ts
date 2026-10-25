import type { EmployeeTask, EmployeeTaskImage, TaskStatus } from "../../types";
import { apiRequest, messageOf, storageObjectUrl } from "../../utils/api";
import { loadSession } from "../../utils/session";

interface TaskDetailView extends EmployeeTask {
  canSubmit: boolean;
  canUseContentActions: boolean;
  expiresLabel: string;
  failureReasonText: string;
  hashtagsText: string;
  reviewDetail: string;
  reviewTitle: string;
  statusLabel: string;
  timingLabel: string;
  tone: string;
  visibleLabel: string;
}

interface DetailData {
  actionBusy: boolean;
  error: string;
  loading: boolean;
  notice: string;
  publicationUrl: string;
  task: TaskDetailView | null;
  taskId: string;
}

Page({
  data: {
    actionBusy: false,
    error: "",
    loading: true,
    notice: "",
    publicationUrl: "",
    task: null,
    taskId: "",
  } as DetailData,

  onLoad(options: Record<string, string | undefined>) {
    if (!loadSession()) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    const taskId = options.taskId;
    if (!taskId) {
      this.setData({ error: "缺少任务编号", loading: false });
      return;
    }
    this.setData({ taskId });
    void this.loadTask(true);
  },

  async loadTask(recordView = false) {
    if (!this.data.taskId) return;
    this.setData({ error: "", loading: true });
    try {
      let task = await apiRequest<EmployeeTask>(`/employee/tasks/${this.data.taskId}`);
      if (recordView && isActionable(task.status) && task.contentVisible) {
        task = await apiRequest<EmployeeTask>(`/employee/tasks/${this.data.taskId}/view`, {
          method: "POST",
        });
      }
      this.setData({ task: detailView(task) });
    } catch (reason) {
      this.setData({ error: messageOf(reason) });
    } finally {
      this.setData({ loading: false });
    }
  },

  onPublicationInput(event: { detail: { value: string } }) {
    this.setData({ publicationUrl: event.detail.value, error: "", notice: "" });
  },

  async copyContent() {
    const task = this.data.task;
    if (!task?.content) return;
    this.setData({ actionBusy: true, error: "", notice: "" });
    try {
      const updated = await apiRequest<EmployeeTask>(`/employee/tasks/${task.id}/events`, {
        body: { type: "COPY", revision: task.contentRevision },
        method: "POST",
      });
      if (!updated.content || updated.contentRevision !== task.contentRevision)
        throw new Error("内容已经更新，请重新查看并确认真实性。");
      await setClipboard(
        `${updated.content.title}\n\n${updated.content.body}\n\n${updated.content.hashtags.map((tag) => `#${tag}`).join(" ")}`,
      );
      this.setData({
        notice: "已核实当前稿件许可，完整文案已复制。",
        task: detailView(updated),
      });
      wx.showToast({ icon: "success", title: "文案已复制" });
    } catch (reason) {
      this.setData({ error: messageOf(reason) });
    } finally {
      this.setData({ actionBusy: false });
    }
  },

  async confirmFacts() {
    const task = this.data.task;
    if (!task) return;
    if (!task.contentVisible || !task.content) {
      this.setData({ error: "当前内容暂不可用，请退回企业复核发布安排。" });
      return;
    }
    this.setData({ actionBusy: true, error: "", notice: "" });
    try {
      const updated = await apiRequest<EmployeeTask>(`/employee/tasks/${task.id}/facts`, {
        method: "POST",
        body: { revision: task.contentRevision, confirmed: true },
      });
      this.setData({
        task: detailView(updated),
        notice: "已确认当前稿件事实与素材真实，可以复制文案并保存图片。",
      });
    } catch (reason) {
      this.setData({ error: messageOf(reason) });
    } finally {
      this.setData({ actionBusy: false });
    }
  },

  returnFacts() {
    const task = this.data.task;
    if (!task) return;
    const reasons = ["FACTS_MISMATCH", "MATERIAL_PRIVACY", "PUBLISHING_CHANGED"] as const;
    wx.showActionSheet({
      itemList: ["事实与本人情况不符", "图片授权或隐私需要复核", "实际发布条件发生变化"],
      success: (result) => {
        const reason = reasons[result.tapIndex];
        if (!reason) return;
        this.setData({ actionBusy: true, error: "", notice: "" });
        void apiRequest<EmployeeTask>(`/employee/tasks/${task.id}/facts`, {
          method: "POST",
          body: { revision: task.contentRevision, confirmed: false, reason },
        })
          .then((updated) =>
            this.setData({
              task: detailView(updated),
              notice: "已退回企业复核，请等待更新后的稿件。",
            }),
          )
          .catch((failure) => this.setData({ error: messageOf(failure) }))
          .finally(() => this.setData({ actionBusy: false }));
      },
    });
  },

  previewImage(event: { currentTarget: { dataset: { imageUrl?: string } } }) {
    const task = this.data.task;
    const current = event.currentTarget.dataset.imageUrl;
    if (!task?.content || !current) return;
    wx.previewImage({
      current,
      urls: task.content.images.map(({ imageUrl }) => imageUrl),
    });
  },

  async saveImage(event: { currentTarget: { dataset: { imageId?: string } } }) {
    const task = this.data.task;
    const imageId = event.currentTarget.dataset.imageId;
    const image = task?.content?.images.find(({ id }) => id === imageId);
    if (!task || !image) return;
    this.setData({ actionBusy: true, error: "", notice: "" });
    try {
      const updated = await apiRequest<EmployeeTask>(`/employee/tasks/${task.id}/events`, {
        body: { type: "DOWNLOAD", revision: task.contentRevision },
        method: "POST",
      });
      const permittedImage = updated.content?.images.find(({ id }) => id === imageId);
      if (!permittedImage || updated.contentRevision !== task.contentRevision)
        throw new Error("图片已经更新，请重新查看并确认真实性。");
      const localPath = await materializeImage(permittedImage);
      await saveToAlbum(localPath);
      this.setData({
        notice: image.synthetic ? "本机测试图片已保存。" : "本任务图片已保存到系统相册。",
        task: detailView(updated),
      });
      wx.showToast({ icon: "success", title: "图片已保存" });
    } catch (reason) {
      const suffix = image.synthetic
        ? " 当前为本机测试图片；若开发者工具不支持写入相册，可先使用图片预览。"
        : "";
      this.setData({ error: `${messageOf(reason)}${suffix}` });
    } finally {
      this.setData({ actionBusy: false });
    }
  },

  async createDevelopmentFixture() {
    const task = this.data.task;
    if (!task?.content?.synthetic) return;
    this.setData({ actionBusy: true, error: "", notice: "" });
    try {
      const fixture = await apiRequest<{ normalizedUrl: string }>(
        `/employee/tasks/${task.id}/dev-publication`,
        { body: { contentMode: "MATCH" }, method: "POST" },
      );
      this.setData({
        notice: "本机测试链接已生成，可以测试提交流程。",
        publicationUrl: fixture.normalizedUrl,
      });
    } catch (reason) {
      this.setData({ error: messageOf(reason) });
    } finally {
      this.setData({ actionBusy: false });
    }
  },

  async submitPublication() {
    const task = this.data.task;
    const url = this.data.publicationUrl.trim();
    if (!task || url.length < 8) {
      this.setData({ error: "请粘贴小红书链接或包含链接的分享文本" });
      return;
    }
    this.setData({ actionBusy: true, error: "", notice: "" });
    try {
      const result = await apiRequest<{ failureReason?: string; status: string }>(
        `/employee/tasks/${task.id}/submissions`,
        { body: { url }, method: "POST" },
      );
      this.setData({
        notice:
          result.status === "VALID"
            ? "本次发布已完成核验。"
            : result.failureReason || "链接已提交，系统正在确认内容。",
      });
      await this.loadTask(false);
    } catch (reason) {
      this.setData({ error: messageOf(reason) });
    } finally {
      this.setData({ actionBusy: false });
    }
  },

  copyPublicationUrl() {
    const url = this.data.task?.publication?.normalizedUrl;
    if (!url) return;
    void setClipboard(url).then(() => wx.showToast({ icon: "success", title: "链接已复制" }));
  },
});

function detailView(task: EmployeeTask): TaskDetailView {
  const confirmed = !task.factsConfirmationRequired || task.factsConfirmed;
  return {
    ...task,
    content: task.content
      ? {
          ...task.content,
          images: task.content.images.map((image) => ({
            ...image,
            imageUrl: storageObjectUrl(image.imageUrl),
          })),
        }
      : task.content,
    canSubmit:
      isActionable(task.status) &&
      !task.factsReturned &&
      confirmed &&
      new Date(task.expiresAt).getTime() > Date.now(),
    canUseContentActions: isActionable(task.status) && !task.factsReturned && confirmed,
    expiresLabel: formatDate(task.expiresAt),
    failureReasonText: failureReasonText(task.submissionFailureReason),
    hashtagsText: task.content?.hashtags.map((tag) => `#${tag}`).join(" ") ?? "",
    reviewDetail: "你已在有效期内提交，无需重复提交；核实期间不会把本期任务记为未完成。",
    reviewTitle: "链接正在核实",
    statusLabel: statusLabel(task.status),
    timingLabel: timingLabel(task),
    tone: statusTone(task.status),
    visibleLabel: formatDate(task.visibleAt),
  };
}

function isActionable(status: TaskStatus): boolean {
  return status === "AVAILABLE";
}

function failureReasonText(reason: string | null): string {
  if (!reason) return "系统未能确认这条链接与本次专属图文一致。";
  if (/[一-鿿]/u.test(reason)) return reason;
  if (reason.includes("already been claimed") || reason.includes("claimed concurrently")) {
    return "这个链接已经被其他任务使用，请提交本人本次发布的新链接。";
  }
  if (reason.includes("image does not match")) {
    return "发布图片不是本任务分配的图片，请核对后重新发布并提交新链接。";
  }
  if (reason.includes("text match score")) {
    return "发布正文与本任务文案差异较大，请使用完整文案重新发布并提交新链接。";
  }
  return "系统未能确认发布内容与本次专属图文一致，请核对文案、图片和链接后重新提交。";
}

function statusLabel(status: TaskStatus): string {
  const labels: Record<TaskStatus, string> = {
    AVAILABLE: "待提交发布链接",
    CANCELLED: "已取消",
    COMPLETED: "已按时完成",
    EXPIRED: "未按时提交链接",
    LATE_CORRECTED: "逾期核实有效",
    LOCKED: "尚未开放",
    VERIFYING: "链接核实中",
  };
  return labels[status];
}

function statusTone(status: TaskStatus): string {
  if (["COMPLETED", "LATE_CORRECTED"].includes(status)) return "success";
  if (status === "EXPIRED") return "danger";
  if (["LOCKED", "CANCELLED"].includes(status)) return "neutral";
  return "warning";
}

function timingLabel(task: EmployeeTask): string {
  const now = Date.now();
  const visibleAt = new Date(task.visibleAt).getTime();
  const expiresAt = new Date(task.expiresAt).getTime();
  if (task.status === "CANCELLED") return "本期任务已取消，无需处理";
  if (task.status === "COMPLETED") return "本期发布任务已按时完成";
  if (task.status === "LATE_CORRECTED") return "逾期后已由管理员核实为有效发布";
  if (task.status === "EXPIRED") return "开放后 24 小时内未提交发布链接";
  if (task.status === "VERIFYING") return "已按时提交链接，等待确认结果";
  if (now >= expiresAt) return "提交时间已结束";
  if (now < visibleAt) return `将在 ${formatDate(task.visibleAt)} 开放`;
  const hours = Math.max(1, Math.ceil((expiresAt - now) / 3_600_000));
  return `还剩约 ${hours} 小时提交发布链接`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function setClipboard(data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.setClipboardData({
      data,
      fail: (reason) => reject(new Error(reason.errMsg)),
      success: () => resolve(),
    });
  });
}

function materializeImage(image: EmployeeTaskImage): Promise<string> {
  if (!image.imageUrl.startsWith("data:")) {
    return new Promise((resolve, reject) => {
      wx.downloadFile({
        fail: (reason) => reject(new Error(reason.errMsg)),
        success: (result) =>
          result.statusCode >= 200 && result.statusCode < 300
            ? resolve(result.tempFilePath)
            : reject(new Error(`图片下载失败（${result.statusCode}）`)),
        url: storageObjectUrl(image.imageUrl),
      });
    });
  }

  const match = /^data:([^;,]+)(;base64)?,(.*)$/u.exec(image.imageUrl);
  if (!match?.[1] || match[3] === undefined) {
    return Promise.reject(new Error("开发图片数据格式无效"));
  }
  const extension = imageExtension(match[1]);
  const filePath = `${wx.env.USER_DATA_PATH}/assigned-${image.id}.${extension}`;
  const fileSystem = wx.getFileSystemManager();
  return new Promise((resolve, reject) => {
    const common = {
      fail: (reason: WechatMiniprogram.GeneralCallbackResult) => reject(new Error(reason.errMsg)),
      filePath,
      success: () => resolve(filePath),
    };
    if (match[2]) {
      fileSystem.writeFile({
        ...common,
        data: wx.base64ToArrayBuffer(match[3] ?? ""),
      });
      return;
    }
    fileSystem.writeFile({
      ...common,
      data: decodeURIComponent(match[3] ?? ""),
      encoding: "utf8",
    });
  });
}

function saveToAlbum(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.saveImageToPhotosAlbum({
      fail: (reason) => reject(new Error(reason.errMsg)),
      filePath,
      success: () => resolve(),
    });
  });
}

function imageExtension(mimeType: string): string {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "svg";
}
