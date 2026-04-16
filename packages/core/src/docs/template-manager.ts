import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DocumentStore } from '@kepler/shared';
import { TEMPLATES_PREFIX } from '@kepler/shared';

import { createLogger } from '../logger.js';

const log = createLogger('template-manager');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATES_DIR = path.join(__dirname, 'default-templates');

export interface TemplateInfo {
  name: string;
  path: string;
}

export class TemplateManager {
  constructor(private readonly store: DocumentStore) {}

  /** List all templates available in the document store. */
  async listTemplates(): Promise<TemplateInfo[]> {
    const templates: TemplateInfo[] = [];
    for await (const head of this.store.list(TEMPLATES_PREFIX)) {
      const name = head.path.slice(TEMPLATES_PREFIX.length).replace(/\.md$/, '');
      if (name) templates.push({ name, path: head.path });
    }
    return templates;
  }

  /** Get raw template content by name. */
  async getTemplate(name: string): Promise<string | null> {
    const templatePath = TEMPLATES_PREFIX + name + '.md';
    const doc = await this.store.get(templatePath);
    if (!doc) return null;
    return doc.content.toString('utf8');
  }

  /**
   * Apply a template by replacing `{{key}}` placeholders with the
   * provided values. Returns the resulting markdown as a string.
   */
  async applyTemplate(name: string, vars: Record<string, string>): Promise<string | null> {
    const template = await this.getTemplate(name);
    if (!template) return null;

    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replaceAll(`{{${key}}}`, value);
    }
    return result;
  }

  /**
   * Copy built-in default templates to the document store if they
   * don't already exist. Called on first orchestrator run.
   */
  async ensureDefaultTemplates(): Promise<void> {
    let files: string[];
    try {
      files = readdirSync(DEFAULT_TEMPLATES_DIR);
    } catch {
      log.warn('default templates directory not found — skipping');
      return;
    }

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const templatePath = TEMPLATES_PREFIX + file;
      const existing = await this.store.head(templatePath);
      if (existing) continue;

      const content = readFileSync(path.join(DEFAULT_TEMPLATES_DIR, file));
      await this.store.put(templatePath, content, {
        contentType: 'text/markdown',
        contentLength: content.length,
        lastModified: new Date(),
        custom: {},
      });
      log.info('installed default template', { template: file });
    }
  }
}
