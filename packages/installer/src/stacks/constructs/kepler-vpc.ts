import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface KeplerVpcProps {
  deploymentName: string;
  vpcStrategy: 'create' | 'existing' | 'default';
  existingVpcId?: string;
}

export class KeplerVpc extends Construct {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: KeplerVpcProps) {
    super(scope, id);

    if (props.vpcStrategy === 'existing' && props.existingVpcId) {
      this.vpc = ec2.Vpc.fromLookup(this, 'ExistingVpc', {
        vpcId: props.existingVpcId,
      });
    } else if (props.vpcStrategy === 'default') {
      this.vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', {
        isDefault: true,
      });
    } else {
      this.vpc = new ec2.Vpc(this, 'KeplerVpc', {
        vpcName: `kepler-${props.deploymentName}`,
        ipAddresses: ec2.IpAddresses.cidr('10.42.0.0/16'),
        maxAzs: 1,
        natGateways: 1,
        subnetConfiguration: [
          {
            name: 'Public',
            subnetType: ec2.SubnetType.PUBLIC,
            cidrMask: 24,
          },
          {
            name: 'Private',
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            cidrMask: 24,
          },
        ],
      });

      cdk.Tags.of(this.vpc).add('kepler:deployment', props.deploymentName);
      cdk.Tags.of(this.vpc).add('kepler:managed', 'true');
    }
  }
}
