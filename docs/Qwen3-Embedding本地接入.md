# Qwen3 Embedding 0.6B 接入

外部向量检索是可选能力；未配置时自托管闭环使用基础字符检索。本说明描述选择 Qwen 适配后的约束。安装脚本只供支持的平台使用，运行前核对自己的系统与工具安装目录。

## 已实现的适配

- 名称包含 `Qwen3-Embedding-0.6B` 的模型自动启用 Qwen 适配（包括官方 GGUF 文件名）。使用无法识别的自定义别名时，可通过模型登记 API 写入 `metadata.embeddingProfile = "QWEN3_0_6B"`；建议直接使用标准模型 ID，以便自动适配。
- 只有查询文本使用 `Instruct: {instruction}\nQuery:{query}`。检索任务说明使用英文；原查询仍用于关键词检索和活动证据，指令不会写入资料正文或 Chunk。
- 资料入库和 REINDEX 使用原始 Chunk，不加查询指令，不使用聊天模板。
- 服务端必须采用 last-token pooling。兼容客户端请求 float 输出，校验完整 1024 维及响应行索引，并在查询和入库两侧统一执行 L2 归一化。拒绝零向量、错误维度和逐 Token 输出，不截断来历不明的向量。
- Qwen 索引版本包含模型 ID、更新时间、服务端地址、模型别名与完整适配配置的哈希。API、入库 Worker 和索引补建共用同一计算函数；旧索引不参与新的向量召回，Worker 自动补建新索引。通用模型的原有行为与版本格式保持不变。
- Qwen 入库每次提交一个片段，避免把大量中文长片段合并成超出 llama.cpp 物理 batch 的请求。

当前查询任务说明：

```text
Given a content creation request, retrieve relevant brand materials about the specified people, procedures, products, and services.
```

## 本机服务

```bash
python3 scripts/embedding/setup-qwen.py
bash scripts/embedding/start-qwen.sh
```

安装脚本固定 llama.cpp `b10883` 与 Qwen 模型仓库提交 `370f27d7550e0def9b39c1f16d3fbaa13aa67728`，校验官方发布包及 Q8_0 模型的 SHA-256。下载内容保存在被 Git 忽略的 `.tools/` 中。

启动脚本固定使用 `--embedding --pooling last --embd-normalize 2`；模型别名为 `qwen3-embedding-0.6b`。默认监听 `127.0.0.1:8092`，API 基础地址为 `http://127.0.0.1:8092/v1`。可通过 `QWEN_EMBEDDING_PORT` 更换端口。

该 CPU 启动配置使用 4 个计算线程、8 个批处理线程、单并发和 8192 Token 上下文；模型本身支持更长上下文，本配置面向分块后的素材检索。超过服务上下文的输入需继续分块，不允许静默截断。

启动时生成专用密钥文件 `.artifacts/qwen-embedding/api-key`（权限 600，所在目录权限 700），通过 `--api-key-file` 读取，不把密钥放在命令参数或日志中。服务不开放 Web UI、静态目录和属性写入接口。

本机 HTTP 服务用于开发环境；生产环境的现有网络限制保持不变，需要通过符合平台网络策略的受控 HTTPS 服务地址接入，不可用开发放行配置绕过生产限制。

## 平台配置

1. 在“模型配置 → 供应商”添加本地 API 地址与专用密钥，系统自动读取模型列表。
2. 切换到“模型选择”，为 Embedding 选择本地供应商和 `qwen3-embedding-0.6b`。模型类型与检索指令自动适配，无需单独登记能力。
3. 点击“保存配置”，四项用途一起保存。保持 Worker 运行，由索引补建流程为已有有效资料生成新向量。

这项配置只负责素材检索，不替代资料理解和文案生成模型。

## 验证

```bash
bash scripts/dev/pnpm.sh --filter @xhs-agentic/ai-gateway build
node scripts/embedding/probe-qwen.cjs
```

探针使用与 API/Worker 相同的适配器执行查询与资料嵌入，检查 1024 维、单位范数，并验证示例查询相对于无关资料的排序。报告写入 `.artifacts/qwen-embedding/probe.json`；它是功能烟测，不是完整检索质量评测。

官方依据：

- https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
- https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF
- https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
