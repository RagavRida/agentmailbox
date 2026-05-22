#!/bin/bash
# infra/security-group.sh
#
# Creates a VPC security group that lets the App Runner VPC connector
# reach RDS Postgres on port 5432. Postgres is provisioned with
# --no-publicly-accessible, so this SG is the only inbound path.
#
# Two SGs are created:
#   agentsmcp-app-runner-sg  attached to the App Runner VPC connector
#   agentsmcp-rds-sg         attached to the RDS instance; allows 5432
#                            ONLY from agentsmcp-app-runner-sg.
#
# Requirements: aws CLI v2, jq.
# Env vars (optional):
#   AWS_REGION              defaults to your CLI default
#   AGENTSMCP_VPC_ID        VPC to put the SGs in. Defaults to the default VPC.
#   AGENTSMCP_TAG_KEY       defaults to "project"
#   AGENTSMCP_TAG_VALUE     defaults to "agentsmcp"
#
# Prints both SG IDs as JSON on stdout for downstream scripts:
#   {"appRunnerSgId":"sg-...","rdsSgId":"sg-..."}

set -euo pipefail

TAG_KEY="${AGENTSMCP_TAG_KEY:-project}"
TAG_VALUE="${AGENTSMCP_TAG_VALUE:-agentsmcp}"
APP_SG_NAME="agentsmcp-app-runner-sg"
RDS_SG_NAME="agentsmcp-rds-sg"

if [ -z "${AGENTSMCP_VPC_ID:-}" ]; then
  AGENTSMCP_VPC_ID=$(aws ec2 describe-vpcs \
    --filters "Name=is-default,Values=true" \
    --query 'Vpcs[0].VpcId' --output text)
  echo "[sg] using default VPC: ${AGENTSMCP_VPC_ID}" >&2
fi

create_or_lookup_sg () {
  local name="$1"
  local desc="$2"
  local existing
  existing=$(aws ec2 describe-security-groups \
    --filters "Name=group-name,Values=${name}" "Name=vpc-id,Values=${AGENTSMCP_VPC_ID}" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")
  if [ "${existing}" != "None" ] && [ -n "${existing}" ]; then
    echo "${existing}"
    return
  fi
  aws ec2 create-security-group \
    --group-name "${name}" \
    --description "${desc}" \
    --vpc-id "${AGENTSMCP_VPC_ID}" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=${TAG_KEY},Value=${TAG_VALUE}}]" \
    --query 'GroupId' --output text
}

APP_SG_ID=$(create_or_lookup_sg "${APP_SG_NAME}" "agentsmcp App Runner VPC connector")
RDS_SG_ID=$(create_or_lookup_sg "${RDS_SG_NAME}" "agentsmcp RDS Postgres - App Runner only")

echo "[sg] app_sg=${APP_SG_ID} rds_sg=${RDS_SG_ID}" >&2

# Idempotent: ignore InvalidPermission.Duplicate if rule already exists.
aws ec2 authorize-security-group-ingress \
  --group-id "${RDS_SG_ID}" \
  --protocol tcp --port 5432 \
  --source-group "${APP_SG_ID}" \
  2>/dev/null || true

# Emit the IDs as JSON for downstream scripts.
printf '{"appRunnerSgId":"%s","rdsSgId":"%s","vpcId":"%s"}\n' \
  "${APP_SG_ID}" "${RDS_SG_ID}" "${AGENTSMCP_VPC_ID}"
