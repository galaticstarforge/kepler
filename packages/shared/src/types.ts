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

export interface StateBucketEntry {
  deploymentName: string;
  config: DeploymentConfig;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface LocalState {
  stateBucket: string;
  region: string;
  lastUsedDeployment?: string;
}

export interface HistoryEntry {
  timestamp: string;
  action: string;
  deploymentName: string;
  details: Record<string, unknown>;
  identity: string;
}

export type InstanceTier = 'small' | 'medium' | 'large';

export const INSTANCE_TIER_MAP: Record<InstanceTier, { instanceType: string; volumeSize: number; costEstimate: string }> = {
  small: { instanceType: 't3.large', volumeSize: 100, costEstimate: '~$70/month' },
  medium: { instanceType: 'm7i.large', volumeSize: 200, costEstimate: '~$120/month' },
  large: { instanceType: 'm7i.2xlarge', volumeSize: 400, costEstimate: '~$280/month' },
};
