export interface DeploymentConfig {
  deploymentName: string;
  region: string;
  stateBucketName: string;
  instanceTier: 'small' | 'medium' | 'large';
  vpcStrategy: 'create' | 'existing' | 'default';
  existingVpcId?: string;
  keplerVersion: string;
}

export interface DeploymentOutputs {
  stackName: string;
  instanceId: string;
  vpcId: string;
  docsBucketName: string;
  logGroupName: string;
  region: string;
  deploymentName: string;
  status: 'CREATE_COMPLETE' | 'UPDATE_COMPLETE' | 'CREATE_IN_PROGRESS' | string;
}
