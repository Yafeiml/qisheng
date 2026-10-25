"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { FeedbackMessage } from "./feedback-toast";

async function prepareLogo(file: File): Promise<string> {
  if (!/\.(png|jpe?g|webp)$/iu.test(file.name) || file.size > 2 * 1024 * 1024 || file.size === 0) {
    throw new Error("请选择不超过 2 MiB 的 PNG、JPEG 或 WebP 图片。");
  }
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width !== bitmap.height) throw new Error("请上传 1:1 图片，宽度与高度需相同。");
    for (const dimension of [256, 192, 128, 96]) {
      const size = Math.min(dimension, bitmap.width);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法处理图片，请更换浏览器后重试。");
      context.drawImage(bitmap, 0, 0, size, size);
      const value = canvas.toDataURL("image/png");
      if (value.length <= 80_022) return value;
    }
    throw new Error("图片过大，请压缩后重新选择。");
  } finally {
    bitmap.close();
  }
}

export function PlatformLogoUpload({
  value,
  disabled,
  onChange,
}: Readonly<{ value: string; disabled: boolean; onChange(value: string): void }>) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const version = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      version.current++;
    },
    [],
  );
  async function select(file?: File) {
    if (!file) return;
    const current = ++version.current;
    setLoading(true);
    setError(null);
    try {
      const result = await prepareLogo(file);
      if (current === version.current) onChange(result);
    } catch (reason) {
      if (current === version.current)
        setError(reason instanceof Error ? reason.message : "图片无法读取，请重新选择。");
    } finally {
      if (current === version.current) setLoading(false);
    }
  }
  return (
    <div className="platformLogoUpload">
      <div className="platformLogoPreview">
        {value ? (
          <Image src={value} width={72} height={72} alt="平台 Logo 预览" unoptimized />
        ) : (
          <span>暂无 Logo</span>
        )}
      </div>
      <div className="platformLogoUploadControls">
        <label>
          选择 Logo 文件
          <input
            aria-label="上传平台 Logo"
            ref={fileInput}
            type="file"
            accept=".png,.jpg,.jpeg,.webp"
            disabled={disabled || loading}
            onChange={(event) => {
              void select(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
        <small>
          {loading ? "正在处理图片…" : "1:1 · PNG / JPEG / WebP · 最大 2 MiB；保存更改后生效"}
        </small>
        {value ? (
          <button
            className="ghostButton"
            type="button"
            disabled={disabled || loading}
            onClick={() => {
              version.current++;
              onChange("");
              setError(null);
            }}
          >
            移除 Logo
          </button>
        ) : null}
        {error ? (
          <FeedbackMessage tone="error" field={fileInput}>
            {error}
          </FeedbackMessage>
        ) : null}
      </div>
    </div>
  );
}
