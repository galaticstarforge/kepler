import type { ToolHandler } from '../types.js';

import { adminDiagnostics } from './admin-diagnostics.js';
import { adminEnrichmentRun } from './admin-enrichment-run.js';
import { adminEnrichmentStatus } from './admin-enrichment-status.js';
import { adminPassRunHistory } from './admin-pass-run-history.js';
import { adminPluginStatus } from './admin-plugin-status.js';
import { adminRecomputeMetrics } from './admin-recompute-metrics.js';
import { adminReindex } from './admin-reindex.js';
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
import { graphCallees } from './graph-callees.js';
import { graphCallers } from './graph-callers.js';
import { graphCommunityContext } from './graph-community-context.js';
import { graphFindSymbol } from './graph-find-symbol.js';
import { graphImpactOf } from './graph-impact-of.js';
import { graphListServices } from './graph-list-services.js';
import { graphModuleGraph } from './graph-module-graph.js';
import { graphQuery } from './graph-query.js';
import { graphRelatedDocs } from './graph-related-docs.js';
import { graphSemanticSearch } from './graph-semantic-search.js';
import { graphServiceTopology } from './graph-service-topology.js';
import { graphSymbolContext } from './graph-symbol-context.js';
import { graphSymbolDetails } from './graph-symbol-details.js';
import { graphSymbolsInDoc } from './graph-symbols-in-doc.js';

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // docs.*
  'docs.create': docsCreate,
  'docs.read': docsRead,
  'docs.update': docsUpdate,
  'docs.delete': docsDelete,
  'docs.list': docsList,
  'docs.search': docsSearch,
  'docs.propose': docsPropose,
  'docs.listTemplates': docsListTemplates,
  'docs.applyTemplate': docsApplyTemplate,
  // concepts.*
  'concepts.list': conceptsList,
  'concepts.read': conceptsRead,
  // graph.*
  'graph.query': graphQuery,
  'graph.findSymbol': graphFindSymbol,
  'graph.symbolDetails': graphSymbolDetails,
  'graph.callers': graphCallers,
  'graph.callees': graphCallees,
  'graph.impactOf': graphImpactOf,
  'graph.relatedDocs': graphRelatedDocs,
  'graph.symbolsInDoc': graphSymbolsInDoc,
  'graph.moduleGraph': graphModuleGraph,
  'graph.listServices': graphListServices,
  'graph.serviceTopology': graphServiceTopology,
  'graph.semanticSearch': graphSemanticSearch,
  'graph.symbolContext': graphSymbolContext,
  'graph.communityContext': graphCommunityContext,
  // admin.*
  'admin.enrichmentRun': adminEnrichmentRun,
  'admin.enrichmentStatus': adminEnrichmentStatus,
  'admin.reindex': adminReindex,
  'admin.pluginStatus': adminPluginStatus,
  'admin.passRunHistory': adminPassRunHistory,
  'admin.diagnostics': adminDiagnostics,
  'admin.recomputeMetrics': adminRecomputeMetrics,
};
