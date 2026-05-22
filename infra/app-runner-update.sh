#!/bin/bash
# infra/app-runner-update.sh
#
# Patches the running App Runner service's runtime env so it points at the
# RDS instance and enables CLOUD_MODE. Run this AFTER:
#   1. iam-user.sh        (creates the deploy identity)
#   2. security-group.sh  (creates app + rds SGs)
#   3. rds.sh             (creates the Postgres instance)
#   4. The RDS instance reaches "available".
#
# Requirements: aws CLI v2.
# Env vars:
#   AGENTSMCP_SERVICE_NAME   required. App Runner service name (e.g.
#                            "agentsmcp-server"). The script looks up
#                            the ARN.
#   AGENTSMCP_DB_PASSWORD    required. Same one used by rds.sh.
#   AGENTSMCP_DB_HOST        required. RDS endpoint, e.g.
#                            agentsmcp-db.xxxxx.us-east-1.rds.amazonaws.com
#   AGENTSMCP_API_KEY        OPTIONAL. Leave UNSET for the hosted free
#                            tier (rate limiting kicks in). Setting it
#                            disables rate limiting per spec.

set -euo pipefail

: "${AGENTSMCP_SERVICE_NAME:?required}"
: "${AGENTSMCP_DB_PASSWORD:?required}"
: "${AGENTSMCP_DB_HOST:?required}"

SERVICE_ARN=$(aws apprunner list-services \
  --query "ServiceSummaryList[?ServiceName=='${AGENTSMCP_SERVICE_NAME}'].ServiceArn | [0]" \
  --output text)
if [ -z "${SERVICE_ARN}" ] || [ "${SERVICE_ARN}" = "None" ]; then
  echo "[apprunner] ERROR: service ${AGENTSMCP_SERVICE_NAME} not found" >&2
  exit 2
fi
echo "[apprunner] service: ${SERVICE_ARN}"

DB_URL="postgresql://agentsmcp:${AGENTSMCP_DB_PASSWORD}@${AGENTSMCP_DB_HOST}:5432/agentsmcp"

# Build the runtime env map. Keep API_KEY out of git — passed in via env.
ENV_JSON=$(cat <<EOF
{
  "CLOUD_MODE": "true",
  "PORT": "8080",
  "AGENTSMCP_DB": "${DB_URL}"$(
    [ -n "${AGENTSMCP_API_KEY:-}" ] && printf ',\n  "AGENTSMCP_API_KEY": "%s"' "${AGENTSMCP_API_KEY}"
  )
}
EOF
)

# update-service replaces RuntimeEnvironmentVariables wholesale, so we
# pull the existing image config first and resubmit it with the new env.
EXISTING=$(aws apprunner describe-service --service-arn "${SERVICE_ARN}")
IMAGE_REPO=$(echo "${EXISTING}" | \
  python3 -c "import sys,json;d=json.load(sys.stdin);print(d['Service']['SourceConfiguration']['ImageRepository']['ImageIdentifier'])")
IMAGE_TYPE=$(echo "${EXISTING}" | \
  python3 -c "import sys,json;d=json.load(sys.stdin);print(d['Service']['SourceConfiguration']['ImageRepository']['ImageRepositoryType'])")
ACCESS_ROLE=$(echo "${EXISTING}" | \
  python3 -c "import sys,json;d=json.load(sys.stdin);print(d['Service']['SourceConfiguration'].get('AuthenticationConfiguration',{}).get('AccessRoleArn',''))")

SRC_CFG=$(cat <<EOF
{
  "ImageRepository": {
    "ImageIdentifier": "${IMAGE_REPO}",
    "ImageRepositoryType": "${IMAGE_TYPE}",
    "ImageConfiguration": {
      "Port": "8080",
      "RuntimeEnvironmentVariables": ${ENV_JSON}
    }
  },
  "AutoDeploymentsEnabled": false$(
    [ -n "${ACCESS_ROLE}" ] && printf ',\n  "AuthenticationConfiguration": {"AccessRoleArn":"%s"}' "${ACCESS_ROLE}"
  )
}
EOF
)

echo "[apprunner] applying update..."
aws apprunner update-service \
  --service-arn "${SERVICE_ARN}" \
  --source-configuration "${SRC_CFG}"

echo "[apprunner] update initiated. Track with:"
echo "        aws apprunner describe-service --service-arn ${SERVICE_ARN} \\"
echo "          --query 'Service.Status'"
