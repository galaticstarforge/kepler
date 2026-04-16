import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface KeplerInstanceProps {
  deploymentName: string;
  vpc: ec2.IVpc;
  instanceRole: iam.IRole;
  instanceType: string;
  volumeSize: number;
  keplerVersion: string;
  stateBucketName: string;
  logGroupName: string;
  region: string;
}

export class KeplerInstance extends Construct {
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: KeplerInstanceProps) {
    super(scope, id);

    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc: props.vpc,
      description: `Kepler instance security group for ${props.deploymentName}`,
      allowAllOutbound: true,
    });
    // No inbound rules — SSM works via outbound-only

    cdk.Tags.of(securityGroup).add('kepler:deployment', props.deploymentName);
    cdk.Tags.of(securityGroup).add('kepler:managed', 'true');

    const userData = ec2.UserData.forLinux();
    userData.addCommands(this.buildUserDataScript(props));

    this.instance = new ec2.Instance(this, 'KeplerInstance', {
      instanceName: `kepler-${props.deploymentName}`,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role: props.instanceRole as iam.Role,
      securityGroup,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(props.volumeSize, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
      userData,
      detailedMonitoring: false,
      ssmSessionPermissions: true,
    });

    cdk.Tags.of(this.instance).add('kepler:deployment', props.deploymentName);
    cdk.Tags.of(this.instance).add('kepler:managed', 'true');
  }

  private buildUserDataScript(props: KeplerInstanceProps): string {
    return `set -euo pipefail

dnf update -y
dnf install -y docker amazon-cloudwatch-agent

systemctl enable --now docker
usermod -aG docker ec2-user

# Install Docker Compose v2 plugin
mkdir -p /usr/local/lib/docker/cli-plugins
curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Write docker-compose.yml for Kepler
mkdir -p /opt/kepler
cat > /opt/kepler/docker-compose.yml <<'COMPOSEFILE'
services:
  core:
    image: ghcr.io/vleader/kepler-core:\${KEPLER_VERSION}
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      - PORT=8080
      - KEPLER_DEPLOYMENT_NAME=\${KEPLER_DEPLOYMENT_NAME}
      - KEPLER_STATE_BUCKET=\${KEPLER_STATE_BUCKET}
      - KEPLER_REGION=\${AWS_REGION}
    logging:
      driver: awslogs
      options:
        awslogs-group: \${KEPLER_LOG_GROUP}
        awslogs-region: \${AWS_REGION}
        awslogs-stream-prefix: core
COMPOSEFILE

# Write env file with values from CDK substitution
cat > /opt/kepler/.env <<ENVFILE
KEPLER_VERSION=${props.keplerVersion}
KEPLER_DEPLOYMENT_NAME=${props.deploymentName}
KEPLER_STATE_BUCKET=${props.stateBucketName}
KEPLER_LOG_GROUP=${props.logGroupName}
AWS_REGION=${props.region}
ENVFILE

# Create systemd unit
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
systemctl enable --now kepler.service`;
  }
}
