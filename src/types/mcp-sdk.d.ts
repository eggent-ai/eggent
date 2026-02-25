/**
 * Type declarations for MCP SDK client subpaths (stdio, streamableHttp).
 * Runtime resolution uses package exports; TS uses these declarations.
 */
declare module "@modelcontextprotocol/sdk/client/stdio" {
  export interface StdioServerParameters {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
  }
  export class StdioClientTransport {
    constructor(server: StdioServerParameters);
    start(): Promise<void>;
    close(): Promise<void>;
    send(message: unknown): Promise<void>;
  }
}

declare module "@modelcontextprotocol/sdk/client/streamableHttp" {
  export interface StreamableHTTPClientTransportOptions {
    requestInit?: RequestInit;
  }
  export class StreamableHTTPClientTransport {
    constructor(url: URL, opts?: StreamableHTTPClientTransportOptions);
    close(): Promise<void>;
    send(message: unknown): Promise<void>;
  }
}
