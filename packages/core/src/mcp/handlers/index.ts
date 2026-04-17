import type { ToolHandler } from '../types.js';

import { adminEnrichmentRun } from './admin-enrichment-run.js';
import { adminEnrichmentStatus } from './admin-enrichment-status.js';
import { conceptsList } from './concepts-list.js';
import { conceptsRead } from './concepts-read.js';
import { docsApplyTemplate } from './docs-apply-template.js';
import { docsCreate } from './docs-create.js';
import { docsDelete } from './docs-delete.js';
import { docsListTemplates } from './docs-list-templates.js';
import { docsList } from './docs-list.js';
import { docsPropose } from './docs-propose.js';
import { docsRead } from './docs-read.js';
import { docsSearch } from './docs-search.js';
import { docsUpdate } from './docs-update.js';
import { graphQuery } from './graph-query.js';

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  'docs.create': docsCreate,
  'docs.read': docsRead,
  'docs.update': docsUpdate,
  'docs.delete': docsDelete,
  'docs.list': docsList,
  'docs.search': docsSearch,
  'docs.propose': docsPropose,
  'docs.listTemplates': docsListTemplates,
  'docs.applyTemplate': docsApplyTemplate,
  'concepts.list': conceptsList,
  'concepts.read': conceptsRead,
  'admin.enrichmentRun': adminEnrichmentRun,
  'admin.enrichmentStatus': adminEnrichmentStatus,
  'graph.query': graphQuery,
};
