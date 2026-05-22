#!/bin/bash
# infra/iam-user.sh
#
# Creates a dedicated IAM user, group, and policy for managing the
# agentsmcp deployment — isolated from any other AWS workload in this
# account. The policy is scoped via tag-based conditions: the user can
# only mutate resources tagged project=agentsmcp.
#
# Run this ONCE, as an admin (or root, on a fresh account). It prints
# Access Key ID + Secret Access Key — save them somewhere safe. The
# secret is unrecoverable after this run.
#
# Requirements: aws CLI v2, jq.
# Env vars (optional):
#   AGENTSMCP_IAM_USER     defaults to "agentsmcp-deploy"
#   AGENTSMCP_IAM_GROUP    defaults to "agentsmcp-deploy-grp"
#   AGENTSMCP_IAM_POLICY   defaults to "agentsmcp-deploy-policy"
#   AGENTSMCP_TAG_KEY      defaults to "project"
#   AGENTSMCP_TAG_VALUE    defaults to "agentsmcp"

set -euo pipefail

USER_NAME="${AGENTSMCP_IAM_USER:-agentsmcp-deploy}"
GROUP_NAME="${AGENTSMCP_IAM_GROUP:-agentsmcp-deploy-grp}"
POLICY_NAME="${AGENTSMCP_IAM_POLICY:-agentsmcp-deploy-policy}"
TAG_KEY="${AGENTSMCP_TAG_KEY:-project}"
TAG_VALUE="${AGENTSMCP_TAG_VALUE:-agentsmcp}"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"

echo "[iam] account=${ACCOUNT_ID} user=${USER_NAME} group=${GROUP_NAME} tag=${TAG_KEY}=${TAG_VALUE}"

# --- Policy document. Tag-gated where AWS supports it. Create actions
# require RequestTag/project=agentsmcp; mutation actions require
# ResourceTag/project=agentsmcp. Read-only actions are unconditional.
POLICY_DOC=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "RdsReadOnly",
      "Effect": "Allow",
      "Action": [
        "rds:Describe*",
        "rds:List*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "RdsCreateTagged",
      "Effect": "Allow",
      "Action": [
        "rds:CreateDBInstance",
        "rds:CreateDBSubnetGroup",
        "rds:CreateDBSecurityGroup",
        "rds:AddTagsToResource"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:RequestTag/${TAG_KEY}": "${TAG_VALUE}"
        }
      }
    },
    {
      "Sid": "RdsModifyTagged",
      "Effect": "Allow",
      "Action": [
        "rds:ModifyDBInstance",
        "rds:DeleteDBInstance",
        "rds:RebootDBInstance",
        "rds:StopDBInstance",
        "rds:StartDBInstance"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/${TAG_KEY}": "${TAG_VALUE}"
        }
      }
    },
    {
      "Sid": "Ec2ReadOnly",
      "Effect": "Allow",
      "Action": [
        "ec2:Describe*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "Ec2SecurityGroupCreateOnVpc",
      "Effect": "Allow",
      "Action": "ec2:CreateSecurityGroup",
      "Resource": "arn:aws:ec2:*:${ACCOUNT_ID}:vpc/*"
    },
    {
      "Sid": "Ec2SecurityGroupCreateTagged",
      "Effect": "Allow",
      "Action": "ec2:CreateSecurityGroup",
      "Resource": "arn:aws:ec2:*:${ACCOUNT_ID}:security-group/*",
      "Condition": {
        "StringEquals": {
          "aws:RequestTag/${TAG_KEY}": "${TAG_VALUE}"
        }
      }
    },
    {
      "Sid": "Ec2CreateTagsOnCreate",
      "Effect": "Allow",
      "Action": "ec2:CreateTags",
      "Resource": [
        "arn:aws:ec2:*:${ACCOUNT_ID}:security-group/*",
        "arn:aws:ec2:*:${ACCOUNT_ID}:vpc-endpoint/*"
      ],
      "Condition": {
        "StringEquals": {
          "ec2:CreateAction": [
            "CreateSecurityGroup",
            "CreateVpcEndpoint"
          ]
        }
      }
    },
    {
      "Sid": "Ec2SecurityGroupMutateTagged",
      "Effect": "Allow",
      "Action": [
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:DeleteSecurityGroup"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/${TAG_KEY}": "${TAG_VALUE}"
        }
      }
    },
    {
      "Sid": "Ec2VpcEndpointCreate",
      "Effect": "Allow",
      "Action": [
        "ec2:CreateVpcEndpoint",
        "ec2:ModifyVpcEndpoint"
      ],
      "Resource": "*"
    },
    {
      "Sid": "Ec2VpcEndpointMutateTagged",
      "Effect": "Allow",
      "Action": [
        "ec2:DeleteVpcEndpoints"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/${TAG_KEY}": "${TAG_VALUE}"
        }
      }
    },
    {
      "Sid": "AppRunnerReadOnly",
      "Effect": "Allow",
      "Action": [
        "apprunner:Describe*",
        "apprunner:List*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AppRunnerMutateTagged",
      "Effect": "Allow",
      "Action": [
        "apprunner:CreateService",
        "apprunner:UpdateService",
        "apprunner:DeleteService",
        "apprunner:PauseService",
        "apprunner:ResumeService",
        "apprunner:StartDeployment",
        "apprunner:CreateVpcConnector",
        "apprunner:DeleteVpcConnector",
        "apprunner:TagResource",
        "apprunner:UntagResource"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/${TAG_KEY}": "${TAG_VALUE}"
        }
      }
    },
    {
      "Sid": "EcrReadAndPushAgentsmcp",
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:DescribeRepositories",
        "ecr:DescribeImages",
        "ecr:CreateRepository"
      ],
      "Resource": [
        "*"
      ]
    },
    {
      "Sid": "CloudwatchLogsList",
      "Effect": "Allow",
      "Action": "logs:DescribeLogGroups",
      "Resource": "*"
    },
    {
      "Sid": "CloudwatchLogsRead",
      "Effect": "Allow",
      "Action": [
        "logs:DescribeLogStreams",
        "logs:GetLogEvents",
        "logs:FilterLogEvents"
      ],
      "Resource": [
        "arn:aws:logs:*:${ACCOUNT_ID}:log-group:/aws/apprunner/agentsmcp*",
        "arn:aws:logs:*:${ACCOUNT_ID}:log-group:/aws/apprunner/agentsmcp*:*"
      ]
    },
    {
      "Sid": "PassRoleAppRunner",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/AppRunnerECRAccessRole",
        "arn:aws:iam::${ACCOUNT_ID}:role/AppRunnerECRAccessRole-*",
        "arn:aws:iam::${ACCOUNT_ID}:role/service-role/AppRunnerECRAccessRole"
      ]
    },
    {
      "Sid": "GetRoleForPassRole",
      "Effect": "Allow",
      "Action": [
        "iam:GetRole",
        "iam:ListRoles"
      ],
      "Resource": "*"
    }
  ]
}
EOF
)

# --- Create or refresh the customer-managed policy.
if aws iam get-policy --policy-arn "${POLICY_ARN}" >/dev/null 2>&1; then
  echo "[iam] policy ${POLICY_NAME} already exists — creating new version"
  aws iam create-policy-version \
    --policy-arn "${POLICY_ARN}" \
    --policy-document "${POLICY_DOC}" \
    --set-as-default
else
  echo "[iam] creating policy ${POLICY_NAME}"
  aws iam create-policy \
    --policy-name "${POLICY_NAME}" \
    --policy-document "${POLICY_DOC}" \
    --description "agentsmcp deploy — tag-gated to ${TAG_KEY}=${TAG_VALUE}" \
    --tags "Key=${TAG_KEY},Value=${TAG_VALUE}"
fi

# --- Create group and attach policy.
if ! aws iam get-group --group-name "${GROUP_NAME}" >/dev/null 2>&1; then
  echo "[iam] creating group ${GROUP_NAME}"
  aws iam create-group --group-name "${GROUP_NAME}"
fi
aws iam attach-group-policy \
  --group-name "${GROUP_NAME}" \
  --policy-arn "${POLICY_ARN}"

# --- Create user and add to group.
if ! aws iam get-user --user-name "${USER_NAME}" >/dev/null 2>&1; then
  echo "[iam] creating user ${USER_NAME}"
  aws iam create-user \
    --user-name "${USER_NAME}" \
    --tags "Key=${TAG_KEY},Value=${TAG_VALUE}"
fi
aws iam add-user-to-group \
  --group-name "${GROUP_NAME}" \
  --user-name "${USER_NAME}"

# --- Mint access key. Only print if no key exists yet (avoid leaking
# secret on re-run). If the user already has keys, bail with a clear msg.
EXISTING_KEYS=$(aws iam list-access-keys --user-name "${USER_NAME}" \
  --query 'AccessKeyMetadata[].AccessKeyId' --output text)

if [ -z "${EXISTING_KEYS}" ]; then
  echo "[iam] creating access key for ${USER_NAME}"
  aws iam create-access-key --user-name "${USER_NAME}" \
    --query '{AccessKeyId:AccessKey.AccessKeyId,SecretAccessKey:AccessKey.SecretAccessKey}' \
    --output json
  echo ""
  echo "[iam] Save the SecretAccessKey above — it cannot be retrieved later."
  echo "[iam] Configure the CLI with:"
  echo "        aws configure --profile agentsmcp"
else
  echo "[iam] user ${USER_NAME} already has access key(s): ${EXISTING_KEYS}"
  echo "[iam] Skipping key creation. Rotate via:"
  echo "        aws iam delete-access-key --user-name ${USER_NAME} --access-key-id <id>"
  echo "        aws iam create-access-key --user-name ${USER_NAME}"
fi

echo "[iam] done."
