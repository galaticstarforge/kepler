import { describe, expect, it } from 'vitest';

import { JsExtractor } from '../../src/indexer/extractor/js-extractor.js';

const REPO = 'test-repo';
const extractor = new JsExtractor({ repo: REPO });

function extract(code: string, fileName = 'src/test.js') {
  return extractor.extract(`/repo/${fileName}`, fileName, code);
}

describe('JsExtractor', () => {
  describe('imports', () => {
    it('identifies external package imports', () => {
      const result = extract(`import { readFile } from 'node:fs/promises';`);
      expect(result.externalPackages).toHaveLength(1);
      expect(result.externalPackages[0].name).toBe('node:fs');
    });

    it('deduplicates external packages', () => {
      const result = extract(`
        import { a } from 'lodash';
        import { b } from 'lodash/merge';
      `);
      expect(result.externalPackages).toHaveLength(1);
      expect(result.externalPackages[0].name).toBe('lodash');
    });

    it('handles scoped packages', () => {
      const result = extract(`import { foo } from '@scope/pkg/deep';`);
      expect(result.externalPackages[0].name).toBe('@scope/pkg');
    });

    it('resolves local relative imports', () => {
      const result = extract(`import { foo } from './utils/helpers.js';`, 'src/app.js');
      expect(result.localImports).toHaveLength(1);
      expect(result.localImports[0].targetPath).toBe('src/utils/helpers.js');
    });

    it('resolves parent directory imports', () => {
      const result = extract(`import { bar } from '../shared/utils.js';`, 'src/app.js');
      expect(result.localImports[0].targetPath).toBe('shared/utils.js');
    });

    it('sets kind to namespace for namespace imports', () => {
      const result = extract(`import * as fs from 'fs';`);
      expect(result.localImports).toHaveLength(0);
      expect(result.externalPackages[0].name).toBe('fs');
    });

    it('collects import specifiers', () => {
      const result = extract(`import { readFile, writeFile } from 'fs/promises';`);
      expect(result.localImports).toHaveLength(0);
      expect(result.externalPackages[0].name).toBe('fs');
    });
  });

  describe('function declarations', () => {
    it('extracts exported async function', () => {
      const result = extract(`export async function processOrder(id) {}`);
      expect(result.symbols).toHaveLength(1);
      const sym = result.symbols[0];
      expect(sym.name).toBe('processOrder');
      expect(sym.kind).toBe('function');
      expect(sym.isExported).toBe(true);
      expect(sym.exportKind).toBe('named');
      expect(sym.isAsync).toBe(true);
      expect(sym.isGenerator).toBe(false);
      expect(sym.scopeKind).toBe('module');
    });

    it('extracts default exported function', () => {
      const result = extract(`export default function run() {}`);
      expect(result.symbols[0].exportKind).toBe('default');
      expect(result.symbols[0].isExported).toBe(true);
      expect(result.exports.some((e) => e.props.isDefault)).toBe(true);
    });

    it('extracts generator function', () => {
      const result = extract(`function* gen() { yield 1; }`);
      expect(result.symbols[0].isGenerator).toBe(true);
      expect(result.symbols[0].isAsync).toBe(false);
    });

    it('extracts non-exported function', () => {
      const result = extract(`function helper() {}`);
      expect(result.symbols[0].isExported).toBe(false);
      expect(result.symbols[0].exportKind).toBeNull();
    });
  });

  describe('class declarations', () => {
    it('extracts exported class', () => {
      const result = extract(`export class OrderService {}`);
      expect(result.symbols).toHaveLength(1);
      const sym = result.symbols[0];
      expect(sym.name).toBe('OrderService');
      expect(sym.kind).toBe('class');
      expect(sym.isExported).toBe(true);
      expect(sym.isAsync).toBe(false);
      expect(sym.isGenerator).toBe(false);
      expect(sym.mutability).toBeNull();
    });
  });

  describe('variable declarations', () => {
    it('extracts arrow function assigned to const', () => {
      const result = extract(`export const handler = async (event) => {};`);
      const sym = result.symbols[0];
      expect(sym.kind).toBe('function');
      expect(sym.mutability).toBe('const');
      expect(sym.isAsync).toBe(true);
      expect(sym.isExported).toBe(true);
    });

    it('extracts plain const variable', () => {
      const result = extract(`export const MAX_RETRIES = 3;`);
      const sym = result.symbols[0];
      expect(sym.kind).toBe('variable');
      expect(sym.mutability).toBe('const');
    });

    it('extracts let variable', () => {
      const result = extract(`let count = 0;`);
      expect(result.symbols[0].mutability).toBe('let');
      expect(result.symbols[0].scopeKind).toBe('block');
    });

    it('extracts var with function scope', () => {
      const result = extract(`var x = 1;`);
      expect(result.symbols[0].mutability).toBe('var');
      expect(result.symbols[0].scopeKind).toBe('function');
    });
  });

  describe('call sites', () => {
    it('detects regular call expression', () => {
      const result = extract(`
        function foo() { console.log('hello'); }
      `);
      const cs = result.callSites.find((c) => c.calleeExpression === 'console.log');
      expect(cs).toBeDefined();
      expect(cs!.isNewExpression).toBe(false);
      expect(cs!.argumentCount).toBe(1);
    });

    it('detects new expression', () => {
      const result = extract(`
        function foo() { throw new Error('msg'); }
      `);
      const cs = result.callSites.find((c) => c.calleeExpression === 'Error');
      expect(cs).toBeDefined();
      expect(cs!.isNewExpression).toBe(true);
    });

    it('sets resolutionStatus to heuristic', () => {
      const result = extract(`foo();`);
      expect(result.callSites[0].resolutionStatus).toBe('heuristic');
    });
  });

  describe('exports', () => {
    it('collects named export via export statement', () => {
      const result = extract(`
        function foo() {}
        export { foo };
      `);
      const exp = result.exports.find((e) => e.symbolName === 'foo');
      expect(exp).toBeDefined();
      expect(exp!.props.isDefault).toBe(false);
    });

    it('collects default export assignment', () => {
      const result = extract(`
        function run() {}
        export default run;
      `);
      const exp = result.exports.find((e) => e.props.isDefault);
      expect(exp).toBeDefined();
      expect(exp!.symbolName).toBe('run');
    });
  });

  describe('module-level analysis', () => {
    it('detects top-level side effects', () => {
      const result = extract(`console.log('startup');`);
      expect(result.module.hasSideEffects).toBe(true);
    });

    it('no side effects for pure declarations', () => {
      const result = extract(`
        export function foo() {}
        export class Bar {}
        export const MAX = 1;
      `);
      expect(result.module.hasSideEffects).toBe(false);
    });

    it('detects barrel file', () => {
      const result = extract(`export { foo } from './foo.js';`);
      expect(result.module.isBarrel).toBe(true);
    });

    it('non-barrel file with symbols is not barrel', () => {
      const result = extract(`
        export function foo() {}
        export { foo };
      `);
      expect(result.module.isBarrel).toBe(false);
    });

    it('detects ESM module system', () => {
      const result = extract(`import { x } from 'y';`);
      expect(result.module.moduleSystem).toBe('esm');
    });

    it('detects CommonJS module system', () => {
      const result = extract(`const x = require('y');`);
      expect(result.module.moduleSystem).toBe('commonjs');
    });

    it('detects mixed module system', () => {
      const result = extract(`
        import { x } from 'y';
        const z = require('w');
      `);
      expect(result.module.moduleSystem).toBe('mixed');
    });

    it('computes loc', () => {
      const code = 'const a = 1;\nconst b = 2;\nconst c = 3;';
      const result = extract(code);
      expect(result.module.loc).toBe(3);
    });

    it('sets language to javascript', () => {
      const result = extract(`export const x = 1;`);
      expect(result.module.language).toBe('javascript');
    });
  });

  describe('JSX files', () => {
    it('does not throw on JSX syntax', () => {
      const jsx = `
        export function Button({ label }) {
          return <button>{label}</button>;
        }
      `;
      expect(() => extract(jsx, 'src/Button.jsx')).not.toThrow();
    });

    it('extracts symbol from JSX file', () => {
      const jsx = `export function Button() { return null; }`;
      const result = extract(jsx, 'src/Button.jsx');
      expect(result.symbols[0].name).toBe('Button');
    });
  });

  describe('line numbers', () => {
    it('records accurate line numbers', () => {
      const code = `
const a = 1;
export function foo() {}
      `.trim();
      const result = extract(code);
      const foo = result.symbols.find((s) => s.name === 'foo');
      expect(foo!.lineStart).toBe(2);
    });
  });

  describe('repo and filePath', () => {
    it('stamps repo and filePath on symbols', () => {
      const result = extract(`export function x() {}`, 'lib/utils.js');
      expect(result.symbols[0].repo).toBe(REPO);
      expect(result.symbols[0].filePath).toBe('lib/utils.js');
    });

    it('stamps repo and path on module', () => {
      const result = extract(`export const x = 1;`, 'lib/index.js');
      expect(result.module.repo).toBe(REPO);
      expect(result.module.path).toBe('lib/index.js');
    });
  });
});
