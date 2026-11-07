/** MCP forwarding: read the user's Claude Code MCP config, decide what may reach a child. */
export {
  adapterCanHost,
  type BuildInvocationWithMcp,
  MCP_UNSUPPORTED,
  type McpForwarding,
  mcpCapableAdapters,
} from "./forward.js";
export {
  claudeJsonPath,
  type DroppedServer,
  describeServer,
  type ForwardResolution,
  forwardableNames,
  type ListOptions,
  listMcpServers,
  type McpScope,
  type McpServer,
  type McpTransport,
  memoRead,
  REASONS,
  type ReadText,
  referencedVariables,
  resolveForwardedServers,
} from "./resolve.js";
