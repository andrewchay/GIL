#!/bin/sh
# 在你自己的终端里运行：sh .context/commit.sh
#
# 为什么需要这个脚本：Agent 沙箱禁止创建或重命名到 .git（Operation not
# permitted），也禁止用 GIT_DIR 或 --git-dir 指定仓库布局。因此提交必须在
# 沙箱之外执行。脚本内容就是三条动作：恢复标准布局、清理失效的忽略规则、提交。
set -e
cd "$(dirname "$0")/.."

if [ -d .git ]; then
  echo "已是标准布局，跳过重命名"
else
  mv .gitstore .git
  echo "已恢复 .gitstore -> .git"
fi

# .gitstore/ 这条忽略规则在恢复布局后不再需要。
python3 - <<'PY'
import pathlib
path = pathlib.Path('.gitignore')
lines = path.read_text(encoding='utf-8').splitlines(keepends=True)
kept = [line for line in lines if line.strip() not in ('.gitstore/', '.gitstore')]
if len(kept) != len(lines):
    path.write_text(''.join(kept), encoding='utf-8')
    print('已从 .gitignore 移除 .gitstore/ 规则')
PY

git status --short
git add -A
git commit -F - <<'MSG'
fix(core): 时序绑定统一为 B1，并修复 knowledge 命名遮蔽

体检发现两个真实的语义问题，均已修复并加反例测试。

时序绑定（B1）：
- always / eventually / eventually within 统一绑定到比较级，Core 与 RL 一致
- `always a == b` 即 `always (a == b)`；`&&` 仍在其外，需要括号
- `not` 在 Core 仍只绑定 unary
- EBNF 的 temporalExpr 同步改为 equalityExpr
- 带括号的写法新旧 AST 完全相同：clinical workflow.gil / ontology.gil
  的摘要在改动前后逐字一致（已用改动前的源码副本对照验证）
- 酒店示例 `always chosen.totalPrice <= ...` 现在按原意解析，无需改示例

knowledge 命名遮蔽：
- knowledge 名与 context/input/state/output 同名时未知，monitor 返回 true，
  open 声明被同名的 input 静默盖掉
- 现在报 DUPLICATE_NAME；这一条正是"不静默当作已满足"要防的情况
- 顺带修复：operationalize 没有 name，两条会被误判为重复（键都是 undefined），
  改为以原文短语为键，且不占用名字空间

其他：
- parser 的报错探测列表只保留仍未实现的 in/after/[/%，{ ? | source within
  已有语法，走普通 PARSE_ERROR
- 文档漂移：interpretation-profile 的"暂不支持 lexicon/assume"已过期，
  phase4 与 evaluation 计划状态落后，CLAUDE.md 里记录的旧时序规则已更正

验证：218 项测试全绿；8 个 demo、parse:examples、check:clinical 均可运行。
MSG

git log --oneline | head -5
