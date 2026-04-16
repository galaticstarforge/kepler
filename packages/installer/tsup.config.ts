import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  splitting: false,
  removeComments: true,
  external: ['aws-cdk-lib', 'constructs', '@aws-sdk/client-cloudformation', 'execa'],
});
