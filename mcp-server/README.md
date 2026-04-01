# HelloLeads MCP Server

An **MCP (Model Context Protocol)** server that lets any MCP-compatible AI assistant — GitHub Copilot, Claude Desktop, Cursor, Zed, etc. — query your **HelloLeads CRM** data directly in natural language.

---

## What is MCP?

**Model Context Protocol** is an open standard by Anthropic that lets AI models talk to external tools and data sources in a safe, structured way.

Think of it like a plug between your AI assistant and your application:

```
AI Assistant  ←──► MCP Server  ←──► HelloLeads REST API  ←──► Database
  (Copilot)          (this)           (PHP / CodeIgniter)
```

You install this server once, point your AI client at it, and from then on you can ask things like:

> "Show me all leads assigned to John from the Trade Show 2025 list"  
> "How many leads are in the Contacted stage?"  
> "What is the activity history for lead #4821?"

---

## Available Tools

| Tool | Description |
|------|-------------|
| `get_leads` | Get leads for an account, optionally filtered by list or stage |
| `get_lead_by_id` | Get full details of a single lead by ID |
| `search_leads` | Search leads by name, email, mobile, or company |
| `get_lists` | Get all lists (events) in the account |
| `get_assigned_leads` | Get all leads assigned to a specific user |
| `get_users` | Get all team members in the organisation |
| `get_lead_activities` | Get the activity/comment history for a lead |

---

## Prerequisites

- **Node.js 18+**  
- A running HelloLeads application with its REST API accessible  
- An API key from HelloLeads (Settings → API)

---

## Setup

### 1. Install dependencies

```bash
cd mcp-server
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
HLS_BASE_URL=https://your-helloleads-domain.com
HLS_API_KEY=your_api_key_here
HLS_EMAIL=owner@yourdomain.com
HLS_ORG_ID=123          # optional default org ID
```

### 3. Test the server manually

```bash
npm start
```

The server starts on **stdio** — it will be silent until an MCP client connects. You should see:

```
[helloleads-mcp] Server running on stdio transport.
```

---

## Connecting to AI Clients

### GitHub Copilot (VS Code)

Add to your VS Code `settings.json` or `.vscode/mcp.json`:

```json
{
  "mcp": {
    "servers": {
      "helloleads": {
        "type": "stdio",
        "command": "node",
        "args": ["${workspaceFolder}/mcp-server/src/index.js"],
        "env": {
          "HLS_BASE_URL": "https://your-helloleads-domain.com",
          "HLS_API_KEY":  "your_api_key_here",
          "HLS_EMAIL":    "owner@yourdomain.com",
          "HLS_ORG_ID":   "123"
        }
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json` (usually at `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "helloleads": {
      "command": "node",
      "args": ["C:/path/to/hls-webapp/mcp-server/src/index.js"],
      "env": {
        "HLS_BASE_URL": "https://your-helloleads-domain.com",
        "HLS_API_KEY":  "your_api_key_here",
        "HLS_EMAIL":    "owner@yourdomain.com",
        "HLS_ORG_ID":   "123"
      }
    }
  }
}
```

### Cursor / Other MCP Clients

Use the same `command` / `args` / `env` pattern — refer to your client's MCP configuration docs.

---

## Example Prompts

Once connected, you can ask your AI assistant:

```
List the first 20 leads in my account.

Search for leads matching "Acme Corp".

Show me all leads assigned to user ID 42.

Get the activity history for lead 8871.

What lists do we have in our CRM?

Who are the team members in organisation 5?
```

---

## Architecture

```
mcp-server/
├── src/
│   └── index.js      ← MCP server — all tools defined here
├── .env.example      ← environment variable template
├── .env              ← your actual config  (git-ignored)
└── package.json
```

The server is intentionally a **single file** — easy to read, easy to extend.  
Each tool maps 1-to-1 with an existing HelloLeads REST API endpoint.

---

## Adding More Tools

To add a new tool, open `src/index.js` and follow the existing pattern:

```js
server.tool(
  "tool_name",
  "Human readable description the AI uses to decide when to call this tool.",
  {
    // Zod schema for input parameters
    paramName: z.string().describe("What this parameter does"),
  },
  async ({ paramName }) => {
    const data = await hlsGet("/api/some/endpoint", { key: paramName });
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);
```

---

## Security Notes

- API credentials are read from **environment variables only** — never hard-coded.  
- The server only makes **read (GET) requests** — no data is written or deleted.  
- Run the server locally; do not expose the stdio process over a network without proper authentication.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `HLS_BASE_URL … must be set` | Set all three required env vars |
| `API error 403` | Check your `HLS_API_KEY` and `HLS_EMAIL` match the API credentials in HelloLeads settings |
| `API error 429` | The HelloLeads API allows 100 requests/hour — you have exceeded the limit |
| Tools not appearing in Copilot | Restart VS Code after editing `mcp.json` / `settings.json` |
