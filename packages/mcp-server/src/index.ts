#!/usr/bin/env node
/**
 * stdio entry point for the Budget MCP server.
 *
 * STDOUT BELONGS TO THE TRANSPORT. One stray `console.log` anywhere in this
 * package corrupts the JSON-RPC stream and the client dies with an unreadable
 * parse error — every diagnostic here goes to stderr.
 *
 * Startup order is deliberate (plan S3.6): environment, then contract, then
 * tools, then `GET /tokens/self`. Each step fails fast with a sentence the
 * operator can act on, because a half-working MCP server looks to the user like
 * a lying assistant rather than a broken process.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { ALLOWLIST } from './allowlist.js';
import { callTool, fetchTokenSelf, readApiConfig } from './http.js';
import { loadOpenApiDocument } from './openapi.js';
import { buildTools, toolsForScope, type BuiltTool } from './tools.js';
import { truncateResponse } from './truncate.js';

const SERVER_NAME = 'budget';
const SERVER_VERSION = '0.1.0';

function logStderr(message: string): void {
  process.stderr.write(`budget-mcp: ${message}\n`);
}

async function main(): Promise<void> {
  const config = readApiConfig(process.env);
  const doc = loadOpenApiDocument(process.env);
  const tools = buildTools(doc, ALLOWLIST);

  const introspection = await fetchTokenSelf(config);
  if (!introspection.ok) {
    logStderr(introspection.message);
    process.exit(1);
  }
  const { scope } = introspection.self;

  // A read token never even SEES the write tools (rationale on toolsForScope).
  const published = toolsForScope(tools, scope);
  const byName = new Map<string, BuiltTool>(published.map((tool) => [tool.name, tool]));

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  // Raw JSON Schema comes straight from the contract, so the handlers are wired
  // on the underlying Server: McpServer.registerTool only speaks Zod shapes.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: published.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (tool === undefined) {
      return { content: [{ type: 'text' as const, text: `Unknown tool "${request.params.name}".` }], isError: true };
    }
    const result = await callTool(config, tool, request.params.arguments ?? {});
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: result.message }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(truncateResponse(result.data)) }] };
  });

  await server.connect(new StdioServerTransport());
  logStderr(`ready — ${published.length} tools, token scope "${scope}", API ${config.baseUrl}`);
}

// Every startup failure (bad env, missing contract, allowlist drift, dead API)
// arrives here already phrased for a human — ToolBuildError carries its whole
// list of drifts in the message.
main().catch((error: unknown) => {
  logStderr(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
