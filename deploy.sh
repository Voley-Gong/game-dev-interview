#!/bin/bash
# 一键部署脚本 - gh auth login 完成后运行此脚本
# 用法: bash deploy.sh

set -e

PROJECT_DIR="/home/voley/projects/game-dev-interview-site"
REPO_NAME="game-dev-interview"
REPO_URL="https://github.com/Voley-Gong/${REPO_NAME}"

cd "$PROJECT_DIR"

echo "=== 检查 gh 认证状态 ==="
if ! gh auth status &>/dev/null; then
    echo "❌ 未认证！请先运行: gh auth login"
    echo "   选择: GitHub.com → HTTPS → Login with a web browser"
    exit 1
fi
echo "✅ 已认证"

echo ""
echo "=== 创建 GitHub 仓库 ==="
if gh repo view "$REPO_NAME" &>/dev/null 2>&1; then
    echo "⚠️  仓库已存在，跳过创建"
else
    gh repo create "$REPO_NAME" --public --description "游戏客户端开发面试题库 - Unity/Cocos/架构/网络/编程/软技能"
    echo "✅ 仓库已创建: $REPO_URL"
fi

echo ""
echo "=== 添加 remote 并推送 ==="
if git remote get-url origin &>/dev/null; then
    git remote set-url origin "$REPO_URL"
else
    git remote add origin "$REPO_URL"
fi

git push -u origin main

echo ""
echo "=== 部署完成！ ==="
echo "GitHub Actions 正在构建部署..."
echo "仓库地址: $REPO_URL"
echo ""
echo "⚠️  重要：请到 GitHub 仓库 Settings → Pages → Source 选择 'GitHub Actions'"
echo "部署完成后访问: https://voley-gong.github.io/game-dev-interview/"
