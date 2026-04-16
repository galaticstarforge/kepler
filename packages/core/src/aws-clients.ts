import { BedrockAgentClient } from '@aws-sdk/client-bedrock-agent';
import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';

let _s3: S3Client | undefined;
let _sqs: SQSClient | undefined;
let _bedrockAgent: BedrockAgentClient | undefined;
let _bedrockAgentRuntime: BedrockAgentRuntimeClient | undefined;

export function getS3Client(region: string): S3Client {
  if (!_s3) _s3 = new S3Client({ region });
  return _s3;
}

export function getSQSClient(region: string): SQSClient {
  if (!_sqs) _sqs = new SQSClient({ region });
  return _sqs;
}

export function getBedrockAgentClient(region: string): BedrockAgentClient {
  if (!_bedrockAgent) _bedrockAgent = new BedrockAgentClient({ region });
  return _bedrockAgent;
}

export function getBedrockAgentRuntimeClient(region: string): BedrockAgentRuntimeClient {
  if (!_bedrockAgentRuntime) _bedrockAgentRuntime = new BedrockAgentRuntimeClient({ region });
  return _bedrockAgentRuntime;
}

/** Reset cached clients (useful in tests). */
export function resetClients(): void {
  _s3 = undefined;
  _sqs = undefined;
  _bedrockAgent = undefined;
  _bedrockAgentRuntime = undefined;
}
