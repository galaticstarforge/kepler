import { existsSync } from 'node:fs';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DeploymentConfig, DeploymentOutputs } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getStackName(deploymentName: string): string {
  return `kepler-${deploymentName}`;
}

async function findCdkBin(): Promise<string> {
  // Look for CDK binary in node_modules
  const candidates = [
    path.join(__dirname, '..', 'node_modules', '.bin', 'cdk'),
    path.join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'cdk'),
    path.join(__dirname, '..', 'node_modules', 'aws-cdk', 'bin', 'cdk'),
  ];

  for (const candidate of candidates) {
    // On Windows, check for .cmd variant
    const cmdVariant = candidate + '.cmd';
    if (existsSync(cmdVariant)) return cmdVariant;
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    'Could not find CDK binary. Ensure aws-cdk is installed as a dependency.',
  );
}

async function runCdk(
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
    onProgress?: (msg: string) => void;
  },
): Promise<string> {
  const { execa } = await import('execa');
  const cdkBin = await findCdkBin();

  const result = await execa(cdkBin, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
    reject: false,
  });

  if (result.stdout && options.onProgress) {
    for (const line of result.stdout.split('\n')) {
      if (line.trim()) options.onProgress(line);
    }
  }

  if (result.exitCode !== 0) {
    const errorMsg = result.stderr || result.stdout || 'CDK command failed';
    throw new Error(`CDK failed (exit ${result.exitCode}): ${errorMsg}`);
  }

  return result.stdout;
}

async function prepareCdkApp(config: DeploymentConfig): Promise<string> {
  const tmpDir = path.join(
    process.env['TMPDIR'] || process.env['TEMP'] || '/tmp',
    `kepler-cdk-${config.deploymentName}-${Date.now()}`,
  );
  await mkdir(tmpDir, { recursive: true });

  // Write the CDK app as a self-contained script
  const appCode = `
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';

const config = ${JSON.stringify(config)};

const INSTANCE_TIER_MAP = {
  small: { instanceType: 't3.large', volumeSize: 100 },
  medium: { instanceType: 'm7i.large', volumeSize: 200 },
  large: { instanceType: 'm7i.2xlarge', volumeSize: 400 },
};

const app = new cdk.App();
const tierConfig = INSTANCE_TIER_MAP[config.instanceTier] || INSTANCE_TIER_MAP.small;

const stack = new cdk.Stack(app, 'kepler-' + config.deploymentName, {
  env: { region: config.region },
  description: 'Kepler deployment: ' + config.deploymentName,
});

cdk.Tags.of(stack).add('kepler:deployment', config.deploymentName);
cdk.Tags.of(stack).add('kepler:managed', 'true');
cdk.Tags.of(stack).add('kepler:version', config.keplerVersion);

// VPC
let vpc;
if (config.vpcStrategy === 'existing' && config.existingVpcId) {
  vpc = ec2.Vpc.fromLookup(stack, 'ExistingVpc', { vpcId: config.existingVpcId });
} else if (config.vpcStrategy === 'default') {
  vpc = ec2.Vpc.fromLookup(stack, 'DefaultVpc', { isDefault: true });
} else {
  vpc = new ec2.Vpc(stack, 'KeplerVpc', {
    vpcName: 'kepler-' + config.deploymentName,
    ipAddresses: ec2.IpAddresses.cidr('10.42.0.0/16'),
    maxAzs: 1,
    natGateways: 1,
    subnetConfiguration: [
      { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
    ],
  });
  cdk.Tags.of(vpc).add('kepler:deployment', config.deploymentName);
  cdk.Tags.of(vpc).add('kepler:managed', 'true');
}

// Storage
const docsBucket = new s3.Bucket(stack, 'DocsBucket', {
  versioned: true,
  encryption: s3.BucketEncryption.S3_MANAGED,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
  lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(30) }],
});
cdk.Tags.of(docsBucket).add('kepler:deployment', config.deploymentName);
cdk.Tags.of(docsBucket).add('kepler:managed', 'true');

const logGroup = new logs.LogGroup(stack, 'LogGroup', {
  logGroupName: '/kepler/' + config.deploymentName,
  retention: logs.RetentionDays.ONE_MONTH,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});

// IAM
const role = new iam.Role(stack, 'InstanceRole', {
  roleName: 'kepler-instance-' + config.deploymentName,
  assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
  description: 'Kepler instance role for deployment ' + config.deploymentName,
});
role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
role.addToPolicy(new iam.PolicyStatement({
  sid: 'StateBucketRead',
  effect: iam.Effect.ALLOW,
  actions: ['s3:GetObject', 's3:ListBucket'],
  resources: ['arn:aws:s3:::' + config.stateBucketName, 'arn:aws:s3:::' + config.stateBucketName + '/*'],
}));
docsBucket.grantReadWrite(role);
role.addToPolicy(new iam.PolicyStatement({
  sid: 'BedrockInvoke',
  effect: iam.Effect.ALLOW,
  actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
  resources: ['*'],
}));
logGroup.grantWrite(role);
role.addToPolicy(new iam.PolicyStatement({
  sid: 'EcrPull',
  effect: iam.Effect.ALLOW,
  actions: ['ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage', 'ecr:GetAuthorizationToken'],
  resources: ['*'],
}));
cdk.Tags.of(role).add('kepler:deployment', config.deploymentName);
cdk.Tags.of(role).add('kepler:managed', 'true');

// Security Group
const sg = new ec2.SecurityGroup(stack, 'InstanceSg', {
  vpc: vpc,
  description: 'Kepler instance SG for ' + config.deploymentName,
  allowAllOutbound: true,
});
cdk.Tags.of(sg).add('kepler:deployment', config.deploymentName);
cdk.Tags.of(sg).add('kepler:managed', 'true');

// User Data
const userData = ec2.UserData.forLinux();
userData.addCommands(\`set -euo pipefail

dnf update -y
dnf install -y docker amazon-cloudwatch-agent

systemctl enable --now docker
usermod -aG docker ec2-user

mkdir -p /usr/local/lib/docker/cli-plugins
curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \\\\
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

mkdir -p /opt/kepler
cat > /opt/kepler/docker-compose.yml <<'COMPOSEFILE'
services:
  core:
    image: ghcr.io/vleader/kepler-core:\\\${KEPLER_VERSION}
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      - PORT=8080
      - KEPLER_DEPLOYMENT_NAME=\\\${KEPLER_DEPLOYMENT_NAME}
      - KEPLER_STATE_BUCKET=\\\${KEPLER_STATE_BUCKET}
      - KEPLER_REGION=\\\${AWS_REGION}
    logging:
      driver: awslogs
      options:
        awslogs-group: \\\${KEPLER_LOG_GROUP}
        awslogs-region: \\\${AWS_REGION}
        awslogs-stream-prefix: core
COMPOSEFILE

cat > /opt/kepler/.env <<ENVFILE
KEPLER_VERSION=\${config.keplerVersion}
KEPLER_DEPLOYMENT_NAME=\${config.deploymentName}
KEPLER_STATE_BUCKET=\${config.stateBucketName}
KEPLER_LOG_GROUP=/kepler/\${config.deploymentName}
AWS_REGION=\${config.region}
ENVFILE

cat > /etc/systemd/system/kepler.service <<'UNITFILE'
[Unit]
Description=Kepler Stack
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/kepler
EnvironmentFile=/opt/kepler/.env
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
UNITFILE

systemctl daemon-reload
systemctl enable --now kepler.service\`);

// Instance
const instance = new ec2.Instance(stack, 'KeplerInstance', {
  instanceName: 'kepler-' + config.deploymentName,
  vpc: vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  instanceType: new ec2.InstanceType(tierConfig.instanceType),
  machineImage: ec2.MachineImage.latestAmazonLinux2023(),
  role: role,
  securityGroup: sg,
  blockDevices: [{
    deviceName: '/dev/xvda',
    volume: ec2.BlockDeviceVolume.ebs(tierConfig.volumeSize, {
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
    }),
  }],
  userData: userData,
  detailedMonitoring: false,
  ssmSessionPermissions: true,
});
cdk.Tags.of(instance).add('kepler:deployment', config.deploymentName);
cdk.Tags.of(instance).add('kepler:managed', 'true');

// Outputs
new cdk.CfnOutput(stack, 'InstanceId', { value: instance.instanceId });
new cdk.CfnOutput(stack, 'VpcId', { value: vpc.vpcId });
new cdk.CfnOutput(stack, 'DocsBucketName', { value: docsBucket.bucketName });
new cdk.CfnOutput(stack, 'LogGroupName', { value: logGroup.logGroupName });
new cdk.CfnOutput(stack, 'Region', { value: config.region });
new cdk.CfnOutput(stack, 'DeploymentName', { value: config.deploymentName });
`;

  await writeFile(path.join(tmpDir, 'app.mjs'), appCode);
  await writeFile(
    path.join(tmpDir, 'cdk.json'),
    JSON.stringify({
      app: 'node app.mjs',
    }),
  );

  return tmpDir;
}

export async function deploy(
  config: DeploymentConfig,
  onProgress: (msg: string) => void,
): Promise<DeploymentOutputs> {
  const stackName = getStackName(config.deploymentName);
  const tmpDir = await prepareCdkApp(config);

  try {
    // Try bootstrap first (idempotent if already done)
    onProgress('Ensuring CDK bootstrap...');
    try {
      await runCdk(
        ['bootstrap', '--require-approval', 'never'],
        {
          cwd: tmpDir,
          env: { CDK_DEFAULT_REGION: config.region },
          onProgress,
        },
      );
    } catch {
      onProgress('CDK bootstrap skipped or already done.');
    }

    // Deploy
    onProgress('Deploying stack...');
    await runCdk(
      ['deploy', '--require-approval', 'never', '--outputs-file', 'outputs.json'],
      {
        cwd: tmpDir,
        env: { CDK_DEFAULT_REGION: config.region },
        onProgress,
      },
    );

    // Read outputs
    const { readFile } = await import('node:fs/promises');
    let outputs: DeploymentOutputs;
    try {
      const outputsRaw = await readFile(path.join(tmpDir, 'outputs.json'), 'utf8');
      const parsed = JSON.parse(outputsRaw) as Record<string, Record<string, string>>;
      const stackOutputs = parsed[stackName] || {};

      outputs = {
        stackName,
        instanceId: stackOutputs['InstanceId'] || '',
        vpcId: stackOutputs['VpcId'] || '',
        docsBucketName: stackOutputs['DocsBucketName'] || '',
        logGroupName: stackOutputs['LogGroupName'] || '',
        region: stackOutputs['Region'] || config.region,
        deploymentName: stackOutputs['DeploymentName'] || config.deploymentName,
        status: 'CREATE_COMPLETE',
      };
    } catch {
      // If outputs file doesn't exist, construct from config
      outputs = {
        stackName,
        instanceId: '',
        vpcId: '',
        docsBucketName: '',
        logGroupName: `/kepler/${config.deploymentName}`,
        region: config.region,
        deploymentName: config.deploymentName,
        status: 'CREATE_COMPLETE',
      };
    }

    return outputs;
  } finally {
    // Clean up temp directory
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function destroy(
  deploymentName: string,
  region: string,
  onProgress: (msg: string) => void,
): Promise<void> {
  const dummyConfig: DeploymentConfig = {
    deploymentName,
    region,
    stateBucketName: '',
    instanceTier: 'small',
    vpcStrategy: 'create',
    keplerVersion: '0.0.1',
  };

  const tmpDir = await prepareCdkApp(dummyConfig);

  try {
    onProgress('Destroying stack...');
    await runCdk(
      ['destroy', '--force'],
      {
        cwd: tmpDir,
        env: { CDK_DEFAULT_REGION: region },
        onProgress,
      },
    );
    onProgress('Stack destroyed successfully.');
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function getStatus(
  deploymentName: string,
  region: string,
): Promise<DeploymentOutputs | null> {
  // Use CloudFormation SDK directly for status checks
  const { CloudFormationClient, DescribeStacksCommand } = await import(
    '@aws-sdk/client-cloudformation'
  );

  const cfn = new CloudFormationClient({ region });
  const stackName = getStackName(deploymentName);

  try {
    const response = await cfn.send(
      new DescribeStacksCommand({ StackName: stackName }),
    );

    const stack = response.Stacks?.[0];
    if (!stack) return null;

    const outputs: Record<string, string> = {};
    for (const output of stack.Outputs || []) {
      if (output.OutputKey && output.OutputValue) {
        outputs[output.OutputKey] = output.OutputValue;
      }
    }

    return {
      stackName,
      instanceId: outputs['InstanceId'] || '',
      vpcId: outputs['VpcId'] || '',
      docsBucketName: outputs['DocsBucketName'] || '',
      logGroupName: outputs['LogGroupName'] || '',
      region: outputs['Region'] || region,
      deploymentName: outputs['DeploymentName'] || deploymentName,
      status: stack.StackStatus || 'UNKNOWN',
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('does not exist')) {
      return null;
    }
    throw error;
  }
}
