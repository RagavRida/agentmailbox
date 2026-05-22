#!/bin/bash
# infra/rds.sh
#
# Provisions RDS Postgres 16 for agentsmcp. Idempotent: re-running when
# the instance already exists is a no-op (logs a notice and exits 0).
#
# Requirements: aws CLI v2.
# Env vars:
#   AGENTSMCP_DB_PASSWORD   required. Master password for the master user.
#   SECURITY_GROUP_ID       required. The RDS-side SG from security-group.sh.
#   AGENTSMCP_DB_SUBNET_GROUP  optional. If unset, uses default DB subnet group.
#   AGENTSMCP_TAG_KEY       defaults to "project"
#   AGENTSMCP_TAG_VALUE     defaults to "agentsmcp"

set -euo pipefail

if [ -z "${AGENTSMCP_DB_PASSWORD:-}" ]; then
  echo "[rds] ERROR: AGENTSMCP_DB_PASSWORD is required" >&2
  exit 2
fi
if [ -z "${SECURITY_GROUP_ID:-}" ]; then
  echo "[rds] ERROR: SECURITY_GROUP_ID is required" >&2
  exit 2
fi

TAG_KEY="${AGENTSMCP_TAG_KEY:-project}"
TAG_VALUE="${AGENTSMCP_TAG_VALUE:-agentsmcp}"
DB_ID="agentsmcp-db"

if aws rds describe-db-instances --db-instance-identifier "${DB_ID}" \
  >/dev/null 2>&1; then
  echo "[rds] instance ${DB_ID} already exists — skipping create"
  aws rds describe-db-instances --db-instance-identifier "${DB_ID}" \
    --query 'DBInstances[0].{status:DBInstanceStatus,endpoint:Endpoint.Address}'
  exit 0
fi

SUBNET_GROUP_FLAG=""
if [ -n "${AGENTSMCP_DB_SUBNET_GROUP:-}" ]; then
  SUBNET_GROUP_FLAG="--db-subnet-group-name ${AGENTSMCP_DB_SUBNET_GROUP}"
fi

echo "[rds] creating ${DB_ID} (db.t3.micro, Postgres 16, 20GB gp3)"
aws rds create-db-instance \
  --db-instance-identifier "${DB_ID}" \
  --db-instance-class db.t3.micro \
  --engine postgres \
  --engine-version 16 \
  --master-username agentsmcp \
  --master-user-password "${AGENTSMCP_DB_PASSWORD}" \
  --allocated-storage 20 \
  --storage-type gp3 \
  --vpc-security-group-ids "${SECURITY_GROUP_ID}" \
  --db-name agentsmcp \
  --backup-retention-period 7 \
  --no-publicly-accessible \
  ${SUBNET_GROUP_FLAG} \
  --tags "Key=${TAG_KEY},Value=${TAG_VALUE}"

echo "[rds] create initiated. Wait for the instance to become available:"
echo "        aws rds wait db-instance-available --db-instance-identifier ${DB_ID}"
echo "[rds] Then fetch the endpoint with:"
echo "        aws rds describe-db-instances --db-instance-identifier ${DB_ID} \\"
echo "          --query 'DBInstances[0].Endpoint.Address' --output text"
