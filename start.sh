#!/bin/bash
# douyin-live 监控启动脚本
# 用法: ./start.sh

cd "$(dirname "$0")"

# 从 .env 文件加载（如果存在）
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

exec node monitor.js >> daemon.log 2>&1
