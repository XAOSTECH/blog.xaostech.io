#!/bin/bash
# Inject build environment variables into wrangler.toml at build time

set -e

# Get the worker directory (current directory when called from Cloudflare)
WRANGLER_FILE="wrangler.toml"

if [ ! -f "$WRANGLER_FILE" ]; then
  echo "⚠️  wrangler.toml not found in $PWD"
  exit 0
fi

echo "Injecting build environment variables into wrangler.toml..."

# Inject KV namespace IDs
[ -n "$KV_SESSIONS_ID" ] && sed -i "s|id = \"\${KV_SESSIONS_ID}\"|id = \"$KV_SESSIONS_ID\"|g" "$WRANGLER_FILE"
[ -n "$KV_MESSAGES_ID" ] && sed -i "s|id = \"\${KV_MESSAGES_ID}\"|id = \"$KV_MESSAGES_ID\"|g" "$WRANGLER_FILE"
[ -n "$KV_CONSENT_ID" ] && sed -i "s|id = \"\${KV_CONSENT_ID}\"|id = \"$KV_CONSENT_ID\"|g" "$WRANGLER_FILE"
[ -n "$KV_TRANSLATIONS_ID" ] && sed -i "s|id = \"\${KV_TRANSLATIONS_ID}\"|id = \"$KV_TRANSLATIONS_ID\"|g" "$WRANGLER_FILE"
[ -n "$KV_CACHE_ID" ] && sed -i "s|id = \"\${KV_CACHE_ID}\"|id = \"$KV_CACHE_ID\"|g" "$WRANGLER_FILE"
[ -n "$KV_BLOG_MEDIA_ID" ] && sed -i "s|id = \"\${KV_BLOG_MEDIA_ID}\"|id = \"$KV_BLOG_MEDIA_ID\"|g" "$WRANGLER_FILE"

# Inject D1 database IDs
[ -n "$D1_ACCOUNT_DB_ID" ] && sed -i "s|database_id = \"\${D1_ACCOUNT_DB_ID}\"|database_id = \"$D1_ACCOUNT_DB_ID\"|g" "$WRANGLER_FILE"
[ -n "$D1_API_DB_ID" ] && sed -i "s|database_id = \"\${D1_API_DB_ID}\"|database_id = \"$D1_API_DB_ID\"|g" "$WRANGLER_FILE"
[ -n "$D1_BLOG_DB_ID" ] && sed -i "s|database_id = \"\${D1_BLOG_DB_ID}\"|database_id = \"$D1_BLOG_DB_ID\"|g" "$WRANGLER_FILE"
[ -n "$D1_DATA_DB_ID" ] && sed -i "s|database_id = \"\${D1_DATA_DB_ID}\"|database_id = \"$D1_DATA_DB_ID\"|g" "$WRANGLER_FILE"
[ -n "$D1_PAYMENTS_DB_ID" ] && sed -i "s|database_id = \"\${D1_PAYMENTS_DB_ID}\"|database_id = \"$D1_PAYMENTS_DB_ID\"|g" "$WRANGLER_FILE"

echo "✓ Build environment variables injected"