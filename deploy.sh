#!/usr/bin/env bash
set -euo pipefail

PROFILE="${DATABRICKS_PROFILE:-homebase-staging}"
APP_NAME="cs-rep-dashboard"
WORKSPACE_PATH="/Workspace/Users/gcruz@joinhomebase.com/rep-dashboard"

echo "▶ Building frontend..."
npm run build

echo "▶ Syncing to Databricks workspace ($WORKSPACE_PATH)..."
databricks sync . "$WORKSPACE_PATH" \
  --profile "$PROFILE" \
  --full

echo "▶ Deploying app ($APP_NAME)..."
databricks apps deploy "$APP_NAME" \
  --source-code-path "$WORKSPACE_PATH" \
  --profile "$PROFILE"

echo "✅ Done — https://cs-rep-dashboard-373323366197249.aws.databricksapps.com"
