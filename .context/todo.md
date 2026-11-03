# 采用材料 + 真实模型接入

用户方向：先补采用材料（外部开发者从零到第一个合同的上手路径），再接真实大模型。
模型接入约束：OpenAI 兼容 chat/completions 协议（覆盖 OpenAI/GLM/DeepSeek/本地 vLLM），env 配置，不在代码或文档中写任何密钥；离线测试与夹具全部保留。

- [x] 确认范围与顺序（采用材料 → 真实模型）
- [ ] `src/agent-model-openai.ts`：OpenAI 兼容 ModelProvider（严格 JSON 解析、超时、密钥不泄漏、仅 https/loopback）
- [ ] 假 OpenAI 服务器测试：happy path / fence 剥离 / 401 / 非 JSON / 超时 / 配置校验
- [ ] HTTP `/v1/proposals/live` 路由 + `agent-server` env 装配 + Python live 客户端
- [ ] `docs/agent-integration.md` 增补 live 模型章节（成本、失败语义）
- [ ] `examples/getting-started/` 三件套，check/simulate/负例命令逐一实测
- [ ] `docs/getting-started.md` 上手指南（三条采用路径 + 五个教程 + 误用清单 + 上线检查单）
- [ ] README 双语链接、CLAUDE.md、.context 收尾
- [ ] 全量回归 + 分两次提交 + 推送

红线：不读取或复用任何本地文件中的既有 API key；演示 token 与模型 key 一律由操作者 env 提供；live 调用的拒绝路径（MODEL_CONTRACT_REJECTED / EFFECT_NOT_GRANTED）是特性，不是故障。
