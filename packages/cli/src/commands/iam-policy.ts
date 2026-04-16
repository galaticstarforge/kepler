import { CreatePolicyCommand } from '@aws-sdk/client-iam';
import { Command } from 'commander';

import { getIAMClient } from '../lib/aws-clients.js';
import { readLocalState } from '../lib/config.js';
import { logger, handleError, output, isJsonOutput } from '../lib/logger.js';
import { checkAwsCredentials } from '../lib/prerequisites.js';
import { promptInput } from '../lib/prompts.js';

function buildPolicyDocument(stateBucket?: string): object {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'KeplerStateBucket',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:DeleteObject'],
        Resource: stateBucket
          ? [`arn:aws:s3:::${stateBucket}`, `arn:aws:s3:::${stateBucket}/*`]
          : ['arn:aws:s3:::kepler-state-*', 'arn:aws:s3:::kepler-state-*/*'],
      },
      {
        Sid: 'KeplerCloudFormation',
        Effect: 'Allow',
        Action: [
          'cloudformation:DescribeStacks',
          'cloudformation:CreateStack',
          'cloudformation:UpdateStack',
          'cloudformation:DeleteStack',
          'cloudformation:GetTemplate',
          'cloudformation:ListStackResources',
        ],
        Resource: 'arn:aws:cloudformation:*:*:stack/kepler-*/*',
      },
      {
        Sid: 'KeplerEC2',
        Effect: 'Allow',
        Action: [
          'ec2:DescribeInstances',
          'ec2:DescribeVpcs',
          'ec2:DescribeSubnets',
          'ec2:DescribeSecurityGroups',
          'ec2:CreateVpc',
          'ec2:CreateSubnet',
          'ec2:CreateInternetGateway',
          'ec2:CreateNatGateway',
          'ec2:CreateRouteTable',
          'ec2:CreateSecurityGroup',
          'ec2:CreateTags',
          'ec2:RunInstances',
          'ec2:TerminateInstances',
          'ec2:AllocateAddress',
          'ec2:ReleaseAddress',
          'ec2:AssociateRouteTable',
          'ec2:AttachInternetGateway',
          'ec2:CreateRoute',
          'ec2:DeleteVpc',
          'ec2:DeleteSubnet',
          'ec2:DeleteInternetGateway',
          'ec2:DeleteNatGateway',
          'ec2:DeleteRouteTable',
          'ec2:DeleteSecurityGroup',
          'ec2:DeleteRoute',
          'ec2:DetachInternetGateway',
          'ec2:DisassociateRouteTable',
          'ec2:ModifyVpcAttribute',
        ],
        Resource: '*',
        Condition: {
          StringEquals: {
            'aws:ResourceTag/kepler:managed': 'true',
          },
        },
      },
      {
        Sid: 'KeplerEC2Untagged',
        Effect: 'Allow',
        Action: [
          'ec2:DescribeInstances',
          'ec2:DescribeVpcs',
          'ec2:DescribeSubnets',
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeInternetGateways',
          'ec2:DescribeNatGateways',
          'ec2:DescribeRouteTables',
          'ec2:DescribeAddresses',
          'ec2:DescribeAvailabilityZones',
          'ec2:DescribeImages',
        ],
        Resource: '*',
      },
      {
        Sid: 'KeplerSSM',
        Effect: 'Allow',
        Action: [
          'ssm:StartSession',
          'ssm:TerminateSession',
          'ssm:DescribeInstanceInformation',
        ],
        Resource: '*',
      },
      {
        Sid: 'KeplerSTS',
        Effect: 'Allow',
        Action: ['sts:GetCallerIdentity'],
        Resource: '*',
      },
      {
        Sid: 'KeplerIAM',
        Effect: 'Allow',
        Action: [
          'iam:CreateRole',
          'iam:DeleteRole',
          'iam:AttachRolePolicy',
          'iam:DetachRolePolicy',
          'iam:PutRolePolicy',
          'iam:DeleteRolePolicy',
          'iam:CreateInstanceProfile',
          'iam:RemoveRoleFromInstanceProfile',
          'iam:DeleteInstanceProfile',
          'iam:AddRoleToInstanceProfile',
          'iam:PassRole',
          'iam:GetRole',
          'iam:GetInstanceProfile',
          'iam:TagRole',
        ],
        Resource: [
          'arn:aws:iam::*:role/kepler-*',
          'arn:aws:iam::*:instance-profile/kepler-*',
        ],
      },
      {
        Sid: 'KeplerS3Buckets',
        Effect: 'Allow',
        Action: [
          's3:CreateBucket',
          's3:DeleteBucket',
          's3:PutBucketVersioning',
          's3:PutBucketEncryption',
          's3:PutBucketPublicAccessBlock',
          's3:PutBucketLifecycleConfiguration',
          's3:PutBucketPolicy',
          's3:GetBucketPolicy',
          's3:ListBucket',
          's3:ListAllMyBuckets',
          's3:GetBucketLocation',
        ],
        Resource: '*',
      },
      {
        Sid: 'KeplerLogs',
        Effect: 'Allow',
        Action: [
          'logs:CreateLogGroup',
          'logs:DeleteLogGroup',
          'logs:PutRetentionPolicy',
          'logs:TagLogGroup',
        ],
        Resource: 'arn:aws:logs:*:*:log-group:/kepler/*',
      },
    ],
  };
}

export const iamPolicyCommand = new Command('iam-policy')
  .description('Print or create the recommended IAM policy')
  .option('--create', 'Create the IAM policy in AWS')
  .action(async (options: { create?: boolean }) => {
    try {
      const state = readLocalState();
      const policyDoc = buildPolicyDocument(state?.stateBucket);

      if (!options.create) {
        // Just print the policy
        if (isJsonOutput()) {
          output(policyDoc);
        } else {
          process.stdout.write(JSON.stringify(policyDoc, null, 2) + '\n');
        }
        return;
      }

      // Create the policy in AWS
      await checkAwsCredentials();
      const policyName = await promptInput('Policy name:', 'KeplerUserAccess');

      const iam = getIAMClient();
      const result = await iam.send(
        new CreatePolicyCommand({
          PolicyName: policyName,
          PolicyDocument: JSON.stringify(policyDoc),
          Description: 'IAM policy for Kepler CLI users',
        }),
      );

      const arn = result.Policy?.Arn || '';
      if (isJsonOutput()) {
        output({ status: 'created', policyArn: arn, policyName });
      } else {
        logger.info(`Policy created: ${arn}`);
        logger.info(`\nTo attach to a user:\n  aws iam attach-user-policy --user-name <USER> --policy-arn ${arn}`);
        logger.info(`\nTo attach to a role:\n  aws iam attach-role-policy --role-name <ROLE> --policy-arn ${arn}`);
      }
    } catch (error) {
      handleError(error);
    }
  });
