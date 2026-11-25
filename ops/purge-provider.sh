#!/usr/bin/env bash
# 把某个已下线的供应商从**本机**清干净（profile 里的 provider 块 / allowedModels 引用 /
# ~/.bashrc 里那把 key）。
#
# 为什么要有它：profile 的 patch 层是**每台机器一份**（~/dsh/profiles/web/cordis.patch.yml），
# 仓库里的改动（模板、工具、测试）靠 git pull 就同步了，但 live profile 与 ~/.bashrc 不会。
# 于是"一台机器清干净了、另一台还挂着一个必然失败的条目"只能靠这个脚本按机器跑一遍。
#
# 用法（默认 dry-run，只打印将要删什么）：
#   bash ops/purge-provider.sh --base-url http://127.0.0.1:8045 --dry-run
#   bash ops/purge-provider.sh --base-url http://127.0.0.1:8045 --apply
#
# 参数：
#   --base-url URL      provider 块里 baseURL 等于它的，整块删（与 --api-key-env 至少给一个）
#   --api-key-env NAME  provider 块里 apiKeyEnv 等于它的，整块删；同时删 ~/.bashrc 的同名 export
#   --profile PATH      默认 ~/dsh/profiles/web/cordis.patch.yml
#   --bashrc PATH       默认 ~/.bashrc（--api-key-env 才用）
#   --apply             真改（不给就是 dry-run）
#
# 幂等：已经清过的机器再跑一次会说"没有需要清理的"，exit 0。
# 安全：只删 providers: 段里缩进匹配的子键；写盘前核对插件数量与 provider 数量，
#       对不上就整个放弃（宁可不改，也不要把 profile 改坏）。
set -euo pipefail

BASE_URL=""
API_KEY_ENV=""
PROFILE="${HOME}/dsh/profiles/web/cordis.patch.yml"
BASHRC="${HOME}/.bashrc"
APPLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --base-url)     BASE_URL="${2:?}"; shift 2 ;;
    --api-key-env)  API_KEY_ENV="${2:?}"; shift 2 ;;
    --profile)      PROFILE="${2:?}"; shift 2 ;;
    --bashrc)       BASHRC="${2:?}"; shift 2 ;;
    --apply)        APPLY=1; shift ;;
    --dry-run)      APPLY=0; shift ;;
    -h|--help)      sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

if [ -z "$BASE_URL" ] && [ -z "$API_KEY_ENV" ]; then
  echo "至少给一个 --base-url 或 --api-key-env（--help 看用法）" >&2
  exit 2
fi
[ -f "$PROFILE" ] || { echo "找不到 profile：$PROFILE" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "需要 python3" >&2; exit 1; }

export PURGE_TS="$(date +%Y%m%d-%H%M%S)" PURGE_BASE_URL="$BASE_URL" PURGE_ENV="$API_KEY_ENV"

python3 - "$PROFILE" "$BASHRC" "$APPLY" <<'PY'
import os, re, sys

profile, bashrc, apply = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
base_url = os.environ.get('PURGE_BASE_URL', '').strip()
env_name = os.environ.get('PURGE_ENV', '').strip()
ts = os.environ['PURGE_TS']

raw = open(profile, encoding='utf-8').read()
lines = raw.split('\n')

# ── 1) 定位 providers: 段，按**实际缩进**认出它的直接子键 ────────────────
pi = next((i for i, l in enumerate(lines) if re.match(r'^\s+providers:\s*$', l)), None)
if pi is None:
    print('profile：找不到 `providers:` 段 —— 放弃（不动文件）')
    sys.exit(1)
pind = len(lines[pi]) - len(lines[pi].lstrip())

end_section = len(lines)
for j in range(pi + 1, len(lines)):
    l = lines[j]
    if not l.strip():
        continue
    ind = len(l) - len(l.lstrip())
    if ind <= pind:
        end_section = j
        break

cind = None
for j in range(pi + 1, end_section):
    l = lines[j]
    if l.strip() and not l.lstrip().startswith('#'):
        cind = len(l) - len(l.lstrip())
        break
if cind is None or cind <= pind:
    print('profile：`providers:` 段为空或缩进异常 —— 放弃（不动文件）')
    sys.exit(1)

starts = []
for j in range(pi + 1, end_section):
    l = lines[j]
    if not l.strip() or l.lstrip().startswith('#'):
        continue
    if len(l) - len(l.lstrip()) == cind and re.match(r'^[A-Za-z0-9_.-]+:\s*$', l.strip()):
        starts.append(j)

blocks = []
for n, s in enumerate(starts):
    e = starts[n + 1] if n + 1 < len(starts) else end_section
    name = lines[s].strip().rstrip(':')
    body = '\n'.join(lines[s:e])
    hit = (base_url and re.search(r'^\s*baseURL:\s*' + re.escape(base_url) + r'\s*$', body, re.M)) or \
          (env_name and re.search(r'^\s*apiKeyEnv:\s*' + re.escape(env_name) + r'\s*$', body, re.M))
    if hit and name != 'providers':
        blocks.append((name, s, e))

if not blocks:
    print('profile：没有需要清理的 provider 块（已是干净状态）')
else:
    for name, s, e in blocks:
        print(f'profile：provider `{name}` 整块删除（第 {s+1}–{e} 行，{e-s} 行）')
        for l in lines[s:min(e, s + 5)]:
            print('   -', l.strip())

names = [b[0] for b in blocks]

# ── 2) 同一 profile 里 allowedModels 对它的引用（任意缩进，认 `- provider: 名`）──
drop_refs = 0
if names:
    pat = re.compile(r'^\s+- provider: (' + '|'.join(re.escape(n) for n in names) + r')\s*$')
    out, i = [], 0
    while i < len(lines):
        if pat.match(lines[i]) and i + 1 < len(lines) and lines[i + 1].lstrip().startswith('model:'):
            print(f'profile：allowedModels 引用删除 {lines[i].strip()} / {lines[i+1].strip()}')
            drop_refs += 1
            i += 2
            continue
        out.append(lines[i]); i += 1
    lines = out

# ── 3) 删块（从后往前，避免行号漂移）───────────────────────────────────
for name, s, e in sorted(blocks, key=lambda b: b[1], reverse=True):
    del lines[s:e]

new = '\n'.join(lines)

# ── 4) bashrc 里的 export ───────────────────────────────────────────────
bash_new = None
if env_name and os.path.isfile(bashrc):
    b = open(bashrc, encoding='utf-8').read().split('\n')
    kept = [l for l in b if not l.startswith(f'export {env_name}=')]
    if len(kept) != len(b):
        print(f'bashrc：删除 export {env_name}=…（{len(b)-len(kept)} 行）')
        bash_new = '\n'.join(kept)
    else:
        print(f'bashrc：没有 {env_name}（已清）')

# ── 5) 写盘前的健全性核对（对不上就整体放弃）────────────────────────────
def count(txt, pat):
    return len(re.findall(pat, txt, re.M))

checks = [
    ('插件条目数不变', count(raw, r'^  - id: '), count(new, r'^  - id: ')),
    ('`providers:` 段数不变', count(raw, r'^\s+providers:\s*$'), count(new, r'^\s+providers:\s*$')),
]
for label, a, b in checks:
    if a != b:
        print(f'✗ 健全性核对失败：{label}（改前 {a} / 改后 {b}）—— 不落盘')
        sys.exit(1)
if blocks:
    removed = len(blocks)
    before = len(starts)
    # 改后 providers: 段的子键数量应当正好少 removed 个
    new_pi = next((i for i, l in enumerate(new.split('\n')) if re.match(r'^\s+providers:\s*$', l)), None)
    nl = new.split('\n')
    nend = len(nl)
    for j in range(new_pi + 1, len(nl)):
        l = nl[j]
        if not l.strip():
            continue
        if len(l) - len(l.lstrip()) <= pind:
            nend = j; break
    after = sum(1 for j in range(new_pi + 1, nend)
                if nl[j].strip() and not nl[j].lstrip().startswith('#')
                and len(nl[j]) - len(nl[j].lstrip()) == cind
                and re.match(r'^[A-Za-z0-9_.-]+:\s*$', nl[j].strip()))
    if after != before - removed:
        print(f'✗ 健全性核对失败：provider 子键数（改前 {before} / 改后 {after} / 应删 {removed}）—— 不落盘')
        sys.exit(1)
    print(f'✓ 健全性核对通过：providers 子键 {before} → {after}')

changed = new != raw or bash_new is not None
if not changed:
    print('\n没有需要清理的，退出。')
    sys.exit(0)

if not apply:
    print('\n[dry-run] 以上改动未落盘；加 --apply 执行。')
    sys.exit(0)

if new != raw:
    bak = f'{profile}.bak-purge-{ts}'
    open(bak, 'w', encoding='utf-8').write(raw)
    print(f'\n备份：{bak}')
    open(profile, 'w', encoding='utf-8').write(new)
if bash_new is not None:
    bak = f'{bashrc}.bak-purge-{ts}'
    open(bak, 'w', encoding='utf-8').write(open(bashrc, encoding='utf-8').read())
    print(f'备份：{bak}')
    open(bashrc, 'w', encoding='utf-8').write(bash_new)
print('已落盘。')
PY

cat <<'TIP'

下一步（在这台机器上）：
  1. 验证：node tools/tests/model-policy.mjs   # 应全绿；「策略表里已无 …」那条守卫会兜底
  2. 看盘面：node install.mjs --check
  3. 生效：profile 热重载（刷新页面即可）；provider-router 的 host 代码要重启 DSH 才换。
     注意：**重启由你自己执行**。
TIP
