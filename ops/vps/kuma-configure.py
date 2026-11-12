#!/usr/bin/env python3
"""配置 Uptime Kuma（2026-11-11）：ntfy 通知 + 补齐监控项。

为什么用脚本改 DB 而不是点 UI：这台机器没有可用的浏览器会话，而 Kuma 1.23
没有公开的「建监控/建通知」REST API（只有 push 与状态页）。所以这里按 Kuma
自己的表结构写库 —— 写入前先 **停服务 + 备份 DB**，写完启动并校验；任何异常
都自动回滚 DB 并恢复服务。

幂等：按 name 识别；重复运行不会建重复项，只会把配置对齐。
推送令牌写到 /etc/kuma/push-tokens.env（600），供 dsh-health-push.sh 使用。

用法（在 VPS 上 root）：
  python3 kuma-configure.py                 # 应用
  python3 kuma-configure.py --dry-run       # 只打印将要做什么
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone

DB = "/opt/uptime-kuma/data/kuma.db"
TOKEN_FILE = "/etc/kuma/push-tokens.env"
SERVICE = "uptime-kuma"

# 监控项定义：name -> 配置
MONITORS = [
    {
        "name": "DSH /go",
        "machine": "ygy12",
        "type": "http",
        "interval": 60,
        "retry_interval": 60,
        "url": "http://100.109.125.37:22022/go",
        # /go 会 302 到 /?token=...，Kuma 跟随重定向后落到 401（DSH 要求令牌）。
        # 两者都算「服务活着」，真正挂掉时是 5xx/超时。
        "accepted_statuscodes_json": '["200-399", "401"]',
        "method": "GET",
        "maxredirects": 10,
    },
    {
        # 第二台（MSI）的入口。每台 PC 在 VPS 上独占一个 220xx 端口，
        # 所以每台都要单独一条 —— 只监控 22022 时，本机隧道挂掉没有任何告警。
        # 命名带端口，便于在手机通知里区分是哪台。
        "name": "DSH /go (22023 MSI)",
        "machine": "msi",
        "type": "http",
        "interval": 60,
        "retry_interval": 60,
        "url": "http://100.109.125.37:22023/go",
        # 同上：302→401 都表示服务活着，真正挂掉是 5xx/超时。
        "accepted_statuscodes_json": '["200-399", "401"]',
        "method": "GET",
        "maxredirects": 10,
    },
    {
        # 每台 PC 一条：PC 侧自检（DSH/桥接/路由/入口/隧道/磁盘）用 push 推上来。
        # 外部 HTTP 探测只能发现"整个链路挂了"；DSH 自己崩而入口代理还在时，
        # 外部仍然 302，只有 PC 内部检查能发现。
        "name": "PC 健康 (主力 22022)",
        "type": "push",
        "interval": 3600,
        "retry_interval": 600,
        "url": "http://100.109.125.37:3001",
        "push_env": "KUMA_PUSH_PC_MAIN",
    },
    {
        "name": "PC 健康 (MSI 22023)",
        "type": "push",
        "interval": 3600,
        "retry_interval": 600,
        "url": "http://100.109.125.37:3001",
        "push_env": "KUMA_PUSH_PC_MSI",
    },
    {
        "name": "DSH 备份新鲜度",
        "type": "push",
        "interval": 86400,
        "retry_interval": 300,
        # push 监控没有页面可点，但 Kuma 的 ntfy provider 会无条件把 monitor.url
        # 塞进 action 按钮；留空会被 ntfy 拒绝（400 actions invalid）。指向 Kuma 本身。
        "url": "http://100.109.125.37:3001",
        "push_env": "KUMA_PUSH_BACKUP",
    },
    {
        "name": "VPS 健康",
        "type": "push",
        "interval": 3600,
        "retry_interval": 300,
        "url": "http://100.109.125.37:3001",
        "push_env": "KUMA_PUSH_HEALTH",
    },
]


def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=check, capture_output=True, text=True)


def systemctl(*args: str) -> subprocess.CompletedProcess:
    return run(["systemctl", *args], check=False)


def backup_db(dst: str) -> None:
    src = sqlite3.connect(DB)
    out = sqlite3.connect(dst)
    with out:
        src.backup(out)
    out.close()
    src.close()


def read_topic(path: str) -> str:
    with open(path, "r", encoding="utf-8") as fh:
        topic = fh.read().strip()
    if not topic:
        raise SystemExit(f"话题文件为空：{path}")
    return topic


def upsert_notification(cur: sqlite3.Cursor, ntfy_url: str, topic: str) -> int:
    config = json.dumps(
        {
            "type": "ntfy",
            "ntfyserverurl": ntfy_url,
            "ntfytopic": topic,
            "ntfyPriority": 4,
            "ntfyIcon": "",
            "ntfyAuthenticationMethod": None,
        },
        ensure_ascii=False,
    )
    row = cur.execute("SELECT id FROM notification WHERE name = ?", ("ntfy (VPS)",)).fetchone()
    if row:
        cur.execute(
            "UPDATE notification SET active = 1, is_default = 1, config = ? WHERE id = ?",
            (config, row[0]),
        )
        print(f"  · 通知已存在，更新配置：id={row[0]}")
        return row[0]
    cur.execute(
        "INSERT INTO notification (name, active, user_id, is_default, config) VALUES (?, 1, 1, 1, ?)",
        ("ntfy (VPS)", config),
    )
    nid = cur.lastrowid
    print(f"  · 新建通知 ntfy (VPS)：id={nid}")
    return nid


# ── 端口映射：唯一真相源 config/machines.json ──────────────────────────────
# 只覆盖 http 类入口监控的 URL 主机端口；push 类监控指向 Kuma 自己，不参与。
# 文件缺失/解析失败 → 原样返回（回退到上面写死的值）。
# 注意：监控 name 里含端口数字，将来真改端口时需手工同步文案；Kuma 以 id 为准，
# 改 name 不会重建监控，但会让人看不懂。
# 优先 DSH_MACHINES_JSON（VPS 上脚本可能被拷到 /tmp 运行），否则按仓库布局推断。
_MACHINES_JSON = os.environ.get("DSH_MACHINES_JSON") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "config", "machines.json")


def _apply_machine_ports(monitors: list[dict]) -> list[dict]:
    try:
        with open(_MACHINES_JSON, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except Exception:
        return monitors

    vps_ip = ((cfg.get("vps") or {}).get("tailnet_ip") or "").strip()
    by_host = {
        str(m.get("host", "")).lower(): m
        for m in (cfg.get("machines") or [])
        if isinstance(m, dict)
    }
    if not vps_ip or not by_host:
        return monitors

    out = []
    for spec in monitors:
        host = str(spec.get("machine", "")).lower()
        machine = by_host.get(host)
        if spec.get("type") == "http" and machine:
            port = machine.get("tunnel_port")
            if isinstance(port, int) and port > 0:
                spec = {**spec, "url": re.sub(r"//[^/]+", f"//{vps_ip}:{port}", spec["url"], count=1)}
            else:
                spec = {**spec, "url": re.sub(r"//[^/]+", f"//{vps_ip}", spec["url"], count=1)}
        out.append(spec)
    return out


MONITORS = _apply_machine_ports(MONITORS)


def load_push_tokens() -> dict[str, str]:
    tokens: dict[str, str] = {}
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or "=" not in line or line.startswith("#"):
                    continue
                key, _, value = line.partition("=")
                tokens[key.strip()] = value.strip().strip('"').strip("'")
    return tokens


def save_push_tokens(tokens: dict[str, str]) -> None:
    os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
    lines = [
        "# 由 ops/vps/kuma-configure.py 生成；Kuma push 监控令牌。600 root。",
        "# 用法：set -a; . /etc/kuma/push-tokens.env; set +a",
    ]
    for key in sorted(tokens):
        lines.append(f"{key}={tokens[key]}")
    tmp = f"{TOKEN_FILE}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, TOKEN_FILE)


def upsert_monitor(cur: sqlite3.Cursor, spec: dict, tokens: dict[str, str]) -> int:
    row = cur.execute("SELECT id FROM monitor WHERE name = ?", (spec["name"],)).fetchone()
    common = {
        "name": spec["name"],
        "active": 1,
        "user_id": 1,
        "interval": spec["interval"],
        "retry_interval": spec.get("retry_interval", 60),
        "maxretries": spec.get("maxretries", 0),
        "timeout": spec.get("timeout", 48),
        "weight": 2000,
        "type": spec["type"],
        "created_date": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "resend_interval": 0,
    }

    if spec["type"] == "push":
        env_key = spec["push_env"]
        token = tokens.get(env_key) or secrets.token_urlsafe(18).replace("-", "").replace("_", "")
        tokens[env_key] = token
        common["push_token"] = token
        # 仅用于通知里的「打开」按钮（见上），push 检测本身不读它。
        if spec.get("url"):
            common["url"] = spec["url"]
    else:
        common.update(
            {
                "url": spec["url"],
                "accepted_statuscodes_json": spec["accepted_statuscodes_json"],
                "method": spec.get("method", "GET"),
                "maxredirects": spec.get("maxredirects", 10),
                "ignore_tls": 0,
                "upside_down": 0,
            }
        )

    if row:
        mid = row[0]
        cols = ", ".join(f"{k} = ?" for k in common)
        cur.execute(f"UPDATE monitor SET {cols} WHERE id = ?", (*common.values(), mid))
        print(f"  · 监控已存在，更新：{spec['name']} (id={mid})")
        return mid

    cols = ", ".join(common.keys())
    marks = ", ".join("?" for _ in common)
    cur.execute(f"INSERT INTO monitor ({cols}) VALUES ({marks})", tuple(common.values()))
    mid = cur.lastrowid
    print(f"  · 新建监控：{spec['name']} (id={mid}, type={spec['type']})")
    return mid


def link(cur: sqlite3.Cursor, monitor_id: int, notification_id: int) -> None:
    exists = cur.execute(
        "SELECT id FROM monitor_notification WHERE monitor_id = ? AND notification_id = ?",
        (monitor_id, notification_id),
    ).fetchone()
    if exists:
        return
    cur.execute(
        "INSERT INTO monitor_notification (monitor_id, notification_id) VALUES (?, ?)",
        (monitor_id, notification_id),
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=None)
    ap.add_argument("--ntfy-url", default="http://100.109.125.37:8080")
    ap.add_argument("--topic-file", default="/etc/ntfy/topic")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    global DB
    if args.db:
        DB = args.db

    topic = read_topic(args.topic_file)
    tokens = load_push_tokens()

    if args.dry_run:
        print("dry-run：将执行")
        print(f"  通知 ntfy (VPS) -> {args.ntfy_url} topic={topic}")
        for spec in MONITORS:
            extra = ""
            if spec["type"] == "push":
                extra = f" token_env={spec['push_env']}"
            print(f"  监控 {spec['name']} ({spec['type']}, {spec['interval']}s){extra}")
        return 0

    bak = f"{DB}.bak-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    backup_db(bak)
    print(f"✓ DB 已备份：{bak}")

    if systemctl("is-active", SERVICE).stdout.strip() == "active":
        print("· 停止 uptime-kuma")
        systemctl("stop", SERVICE)
        time.sleep(1)

    conn = sqlite3.connect(DB)
    ok = False
    try:
        with conn:
            cur = conn.cursor()
            user = cur.execute("SELECT id FROM user ORDER BY id LIMIT 1").fetchone()
            if not user:
                raise RuntimeError("Kuma 里还没有用户，先完成一次网页初始化")
            nid = upsert_notification(cur, args.ntfy_url, topic)
            ids = [upsert_monitor(cur, spec, tokens) for spec in MONITORS]
            existing = [r[0] for r in cur.execute("SELECT id FROM monitor")]
            for mid in existing:
                link(cur, mid, nid)
            print(f"  · 通知已关联到 {len(existing)} 个监控")
        conn.commit()
        ok = True
    finally:
        conn.close()

    if ok:
        save_push_tokens(tokens)
        print(f"✓ 推送令牌写入 {TOKEN_FILE}")
    else:
        shutil.copyfile(bak, DB)
        print("✗ 写库失败，已回滚 DB", file=sys.stderr)

    print("· 启动 uptime-kuma")
    systemctl("start", SERVICE)
    time.sleep(2)
    active = systemctl("is-active", SERVICE).stdout.strip()
    print(f"✓ uptime-kuma: {active}")
    return 0 if ok and active == "active" else 1


if __name__ == "__main__":
    sys.exit(main())
