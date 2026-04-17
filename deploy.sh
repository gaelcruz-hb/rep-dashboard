#!/usr/bin/env bash
set -euo pipefail

PROFILE="${DATABRICKS_PROFILE:-homebase-staging}"
APP_NAME="cs-rep-dashboard"
BRANCH="${1:-main}"

echo "▶ Building frontend..."
npm run build

echo "▶ Deploying app ($APP_NAME) from Git branch: $BRANCH..."
COMMIT=$(git rev-parse HEAD)
echo "  Commit: $COMMIT"

databricks api post /api/2.0/apps/${APP_NAME}/deployments \
  --profile "$PROFILE" \
  --json "{\"git_source\": {\"branch\": \"$BRANCH\"}}"

echo "✅ Done — https://cs-rep-dashboard-373323366197249.aws.databricksapps.com"
