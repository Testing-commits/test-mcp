/**
 * HelloLeads MCP Server
 *
 * Exposes HelloLeads CRM data as MCP tools so any MCP-compatible AI assistant
 * (GitHub Copilot, Claude Desktop, Cursor, etc.) can query your CRM directly.
 *
 * Transport  : stdio  (process stdin / stdout)
 * Auth       : hls-key + Xemail headers
 * Config     : environment variables via .env  or the configure_credentials tool
 *
 * Tools:
 *   configure_credentials  — set API credentials (required first)
 *   get_lists              — list all lists (returns list_key for other tools)
 *   get_leads              — get / filter leads with pagination
 *   get_custom_fields      — get custom fields for a list
 *   get_users              — get all users / team members
 *   get_lead_activities    — get activity history for a lead
 *   get_user_activities    — get all lead activities for one or more users
 *   create_lead            — create a new lead
 *   update_lead            — update an existing lead
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import express from "express";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Bootstrap .env
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const { config } = await import("dotenv");
  config({ path: join(__dirname, "..", ".env") });
} catch {
  // dotenv not available — rely on real env vars
}

// ---------------------------------------------------------------------------
// Runtime credentials (settable via configure_credentials tool)
// ---------------------------------------------------------------------------
let HLS_BASE_URL = (process.env.HLS_BASE_URL ?? "").replace(/\/$/, "");
let HLS_API_KEY  = process.env.HLS_API_KEY  ?? "";
let HLS_EMAIL    = process.env.HLS_EMAIL    ?? "";

function missingCredsMessage() {
  if (!HLS_BASE_URL || !HLS_API_KEY || !HLS_EMAIL) {
    return (
      "HelloLeads credentials are not configured yet. " +
      "Please call the `configure_credentials` tool first and provide: " +
      "baseUrl, apiKey, and email."
    );
  }
  return null;
}

function authHeaders() {
  return {
    "hls-key": HLS_API_KEY,
    "Xemail":  HLS_EMAIL,
    "Content-Type": "application/json",
    "Accept":       "application/json",
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function hlsGet(path, params = {}) {
  const url = new URL(`${HLS_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), { method: "GET", headers: authHeaders() });
  if (!res.ok) throw new Error(`HelloLeads API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function hlsPost(path, body = {}) {
  const res = await fetch(`${HLS_BASE_URL}${path}`, {
    method:  "POST",
    headers: authHeaders(),
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HelloLeads API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function hlsPut(path, body = {}) {
  const res = await fetch(`${HLS_BASE_URL}${path}`, {
    method:  "PUT",
    headers: authHeaders(),
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HelloLeads API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// MCP Server factory — creates a fresh instance per HTTP request
// ---------------------------------------------------------------------------
function createServer() {
const server = new McpServer({ name: "helloleads-crm", version: "2.0.0" });

// ---------------------------------------------------------------------------
// configure_credentials
// ---------------------------------------------------------------------------
server.tool(
  "configure_credentials",
  "Set your HelloLeads API credentials. Call this first before using any other tool. " +
  "Credentials are saved to a local .env file so you only need to do this once.",
  {
    baseUrl: z.string().url().describe(
      "Base URL of your HelloLeads app, e.g. https://app.helloleads.io (no trailing slash)."
    ),
    apiKey: z.string().min(1).describe(
      "Your HelloLeads API key. Find it under Settings -> API in the HelloLeads web app."
    ),
    email: z.string().email().describe(
      "Email address of the HelloLeads account owner / API user."
    ),
  },
  async ({ baseUrl, apiKey, email }) => {
    HLS_BASE_URL = baseUrl.replace(/\/$/, "");
    HLS_API_KEY  = apiKey;
    HLS_EMAIL    = email;

    const envPath = join(__dirname, "..", ".env");
    const lines = [
      `HLS_BASE_URL=${HLS_BASE_URL}`,
      `HLS_API_KEY=${HLS_API_KEY}`,
      `HLS_EMAIL=${HLS_EMAIL}`,
    ];
    try {
      writeFileSync(envPath, lines.join("\n") + "\n", "utf8");
    } catch (writeErr) {
      return {
        content: [{
          type: "text",
          text:
            "Credentials accepted and active for this session, but could not be saved " +
            `to disk (${writeErr.message}). You will need to configure again after a restart.`,
        }],
      };
    }
    return {
      content: [{
        type: "text",
        text:
          `HelloLeads credentials saved successfully.\n` +
          `  Base URL : ${HLS_BASE_URL}\n` +
          `  Email    : ${HLS_EMAIL}\n\n` +
          `You can now use all HelloLeads tools.`,
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// get_lists  —  GET /index.php/private/api/lists
// ---------------------------------------------------------------------------
server.tool(
  "get_lists",
  "Get all lists from your HelloLeads CRM account. Each list has a list_key which is required to fetch or create leads.",
  {},
  async () => {
    const credsErr = missingCredsMessage();
    if (credsErr) return { content: [{ type: "text", text: credsErr }], isError: true };
    try {
      const data = await hlsGet("/index.php/private/api/lists");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error fetching lists: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// get_leads  —  GET /index.php/private/api/leads
// ---------------------------------------------------------------------------
server.tool(
  "get_leads",
  "Get leads (contacts) from the HelloLeads CRM account. Use get_lists first to obtain a list_key.",
  {
    list_key: z.string().optional().describe(
      "Filter leads belonging to a specific list. Obtain from get_lists tool."
    ),
    page: z.number().int().min(1).optional().describe(
      "Page number for pagination. Default is 1. Check total_pages in the response."
    ),
    lead_stage_id: z.string().optional().describe(
      "Filter by lead stage ID. Single value (e.g. '3') or comma-separated (e.g. '2,3,5')."
    ),
    lead_category: z.string().optional().describe(
      "Filter by lead category. Single value (e.g. 'sales') or comma-separated (e.g. 'sales,marketing')."
    ),
    orderByCreatedDateTime: z.enum(["ASC", "DESC"]).optional().describe(
      "Sort by created date. DESC = newest first, ASC = oldest first."
    ),
    orderByModifiedDateTime: z.enum(["ASC", "DESC"]).optional().describe(
      "Sort by modified date. DESC = newest first, ASC = oldest first."
    ),
    createdDateTime_From: z.string().optional().describe(
      "Filter leads created on or after this date-time. Format: YYYY-MM-DD HH:mm:ss"
    ),
    createdDateTime_To: z.string().optional().describe(
      "Filter leads created on or before this date-time. Format: YYYY-MM-DD HH:mm:ss"
    ),
    modifiedDateTime_From: z.string().optional().describe(
      "Filter leads modified on or after this date-time. Format: YYYY-MM-DD HH:mm:ss"
    ),
    modifiedDateTime_To: z.string().optional().describe(
      "Filter leads modified on or before this date-time. Format: YYYY-MM-DD HH:mm:ss"
    ),
  },
  async (params) => {
    const credsErr = missingCredsMessage();
    if (credsErr) return { content: [{ type: "text", text: credsErr }], isError: true };
    try {
      const data = await hlsGet("/index.php/private/api/leads", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error fetching leads: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// get_custom_fields  —  GET /api/getCustomFields
// ---------------------------------------------------------------------------
server.tool(
  "get_custom_fields",
  "Get all custom fields mapped to a specific list. Useful before creating or updating leads with custom field values.",
  {
    list_key: z.string().describe(
      "The list_key of the list to fetch custom fields for. Obtain from get_lists tool."
    ),
  },
  async ({ list_key }) => {
    const credsErr = missingCredsMessage();
    if (credsErr) return { content: [{ type: "text", text: credsErr }], isError: true };
    try {
      const data = await hlsGet("/api/getCustomFields", { list_key });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error fetching custom fields: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// get_users  —  GET /index.php/private/api/users
// ---------------------------------------------------------------------------
server.tool(
  "get_users",
  "Get all users (team members / salespeople) in the HelloLeads CRM account.",
  {
    page: z.number().int().min(1).optional().describe(
      "Page number for pagination."
    ),
    orderByCreatedDateTime: z.enum(["ASC", "DESC"]).optional().describe(
      "Sort by created date. DESC = newest first, ASC = oldest first."
    ),
  },
  async (params) => {
    const credsErr = missingCredsMessage();
    if (credsErr) return { content: [{ type: "text", text: credsErr }], isError: true };
    try {
      const data = await hlsGet("/index.php/private/api/users", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error fetching users: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// get_lead_activities  —  GET /index.php/private/api/leadActivities
// ---------------------------------------------------------------------------
server.tool(
  "get_lead_activities",
  "Get the activity history (comments, calls, emails, logs) for a specific lead.",
  {
    leadId: z.string().describe(
      "The unique ID of the lead. Obtain from get_leads tool."
    ),
    activityType: z.enum(["all", "comments", "logs"]).optional().describe(
      "Type of activities to retrieve: all, comments, or logs. Defaults to all."
    ),
    createdDateTime_From: z.string().optional().describe(
      "Filter activities on or after this date-time. Format: YYYY-MM-DD HH:mm:ss"
    ),
    createdDateTime_To: z.string().optional().describe(
      "Filter activities on or before this date-time. Format: YYYY-MM-DD HH:mm:ss"
    ),
    orderByCreatedDateTime: z.enum(["ASC", "DESC"]).optional().describe(
      "Sort by created date. DESC = newest first, ASC = oldest first."
    ),
  },
  async (params) => {
    const credsErr = missingCredsMessage();
    if (credsErr) return { content: [{ type: "text", text: credsErr }], isError: true };
    try {
      const data = await hlsGet("/index.php/private/api/leadActivities", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error fetching lead activities: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// get_user_activities  —  GET /index.php/private/api/allLeadActivities
// ---------------------------------------------------------------------------
server.tool(
  "get_user_activities",
  "Get all lead activities performed by one or more users. Useful for tracking a salesperson's workload.",
  {
    userId: z.string().describe(
      "User ID(s) to fetch activities for. Single ID or comma-separated for multiple. Obtain from get_users."
    ),
    activityType: z.enum(["all", "comments", "logs"]).optional().describe(
      "Type of activities: all, comments, or logs. Defaults to all."
    ),
    page: z.number().int().min(1).optional().describe(
      "Page number for pagination. Check totalPages in the response."
    ),
    createdDateTime_From: z.string().optional().describe(
      "Filter activities on or after this date-time. Format: YYYY-MM-DD HH:mm:ss"
    ),
    createdDateTime_To: z.string().optional().describe(
      "Filter activities on or before this date-time. Format: YYYY-MM-DD HH:mm:ss"
    ),
    orderByCreatedDateTime: z.enum(["ASC", "DESC"]).optional().describe(
      "Sort by created date. DESC = newest first, ASC = oldest first."
    ),
  },
  async (params) => {
    const credsErr = missingCredsMessage();
    if (credsErr) return { content: [{ type: "text", text: credsErr }], isError: true };
    try {
      const data = await hlsGet("/index.php/private/api/allLeadActivities", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error fetching user activities: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// create_lead  —  POST /index.php/private/api/leads
// ---------------------------------------------------------------------------
server.tool(
  "create_lead",
  "Create a new lead (contact) in the HelloLeads CRM. Use get_lists to get a list_key and get_custom_fields to get custom field IDs.",
  {
    list_key: z.string().describe(
      "The list_key of the list to add the lead to. Required. Obtain from get_lists tool."
    ),
    first_name: z.string().min(1).describe("First name of the lead."),
    last_name: z.string().optional().describe("Last name of the lead."),
    email: z.string().email().optional().describe("Email address of the lead."),
    mobile: z.string().optional().describe("Mobile number of the lead."),
    mobile_code: z.string().optional().describe("Country dial code for mobile, e.g. +1, +91."),
    phone: z.string().optional().describe("Landline / office phone number."),
    fax: z.string().optional().describe("Fax number."),
    company: z.string().optional().describe("Company name."),
    designation: z.string().optional().describe("Job title / designation."),
    website: z.string().optional().describe("Website URL."),
    address_line1: z.string().optional().describe("Address line 1."),
    address_line2: z.string().optional().describe("Address line 2."),
    city: z.string().optional().describe("City."),
    state: z.string().optional().describe("State / province."),
    country: z.string().optional().describe("Country."),
    postal_code: z.string().optional().describe("Postal / ZIP code."),
    notes: z.string().optional().describe("Free-text notes about the lead."),
    tags: z.string().optional().describe("Comma-separated tags."),
    product_group: z.string().optional().describe("Product group the lead belongs to."),
    customer_group: z.string().optional().describe("Customer group the lead belongs to."),
    deal_size: z.string().optional().describe("Estimated deal size / value."),
    potential: z.enum(["Low", "Medium", "High"]).optional().describe(
      "Lead potential: Low, Medium, or High."
    ),
    custfields: z.record(z.string(), z.string()).optional().describe(
      "Custom field values as key-value pairs {CustomFieldID: value}. Use get_custom_fields to obtain IDs."
    ),
  },
  async (params) => {
    const credsErr = missingCredsMessage();
    if (credsErr) return { content: [{ type: "text", text: credsErr }], isError: true };
    try {
      const data = await hlsPost("/index.php/private/api/leads", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error creating lead: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// update_lead  —  PUT /index.php/private/api/lead/:id
// ---------------------------------------------------------------------------
server.tool(
  "update_lead",
  "Update an existing lead in the HelloLeads CRM. Use get_leads to obtain the lead ID.",
  {
    id: z.string().describe(
      "The unique ID of the lead to update. Obtain from get_leads tool."
    ),
    list_key: z.string().optional().describe("The list_key of the list the lead belongs to."),
    modified_by: z.string().optional().describe("Email address of the user making the update."),
    first_name: z.string().optional().describe("First name."),
    last_name: z.string().optional().describe("Last name."),
    email: z.string().email().optional().describe("Email address."),
    mobile: z.string().optional().describe("Mobile number."),
    mobile_code: z.string().optional().describe("Country dial code, e.g. +1, +91."),
    phone: z.string().optional().describe("Landline / office phone."),
    telephone_office: z.string().optional().describe("Office telephone number."),
    company: z.string().optional().describe("Company name."),
    designation: z.string().optional().describe("Job title / designation."),
    website: z.string().optional().describe("Website URL."),
    address_line1: z.string().optional().describe("Address line 1."),
    address_line2: z.string().optional().describe("Address line 2."),
    city: z.string().optional().describe("City."),
    state: z.string().optional().describe("State / province."),
    country: z.string().optional().describe("Country."),
    postal_code: z.string().optional().describe("Postal / ZIP code."),
    notes: z.string().optional().describe("Free-text notes."),
    lead_stage_id: z.string().optional().describe("Lead stage ID to move the lead to."),
    deal_size: z.string().optional().describe("Estimated deal size / value."),
    potential: z.enum(["Low", "Medium", "High"]).optional().describe(
      "Lead potential: Low, Medium, or High."
    ),
    custfields: z.record(z.string(), z.string()).optional().describe(
      "Custom field values as {CustomFieldID: value}. Use get_custom_fields to find IDs."
    ),
    followUpDetails: z
      .object({
        assignedToUserEmail: z.string().email().optional().describe(
          "Email of the user to assign the follow-up to."
        ),
        followUpDateTime: z.string().optional().describe(
          "Follow-up date and time. Format: YYYY-MM-DD HH:mm:ss"
        ),
        followUpNotes: z.string().optional().describe("Notes for the follow-up."),
        repeatFollowUpFrequency: z.string().optional().describe(
          "Repeat frequency, e.g. None, Daily, Weekly."
        ),
        doNotFollowUpStatus: z.enum(["ON", "OFF"]).optional().describe(
          "Whether to suppress follow-up reminders."
        ),
        doNotFollowUpReason: z.string().nullable().optional().describe(
          "Reason for suppressing follow-up."
        ),
      })
      .optional()
      .describe("Follow-up scheduling details."),
  },
  async ({ id, ...rest }) => {
    const credsErr = missingCredsMessage();
    if (credsErr) return { content: [{ type: "text", text: credsErr }], isError: true };
    try {
      const data = await hlsPut(`/index.php/private/api/lead/${encodeURIComponent(id)}`, rest);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error updating lead: ${err.message}` }], isError: true };
    }
  }
);

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server for Railway deployment
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// CORS — required for web-based MCP clients (Convocore, etc.)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "helloleads-mcp" });
});

// ---------------------------------------------------------------------------
// Stateful MCP sessions — keeps initialize + tools/list in the same session
// ---------------------------------------------------------------------------
const sessions = new Map(); // sessionId -> StreamableHTTPServerTransport

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport = sessionId ? sessions.get(sessionId) : null;

    if (!transport) {
      // New session: create server + transport together
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
      });
      const mcpServer = createServer();
      await mcpServer.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: null });
    }
  }
});

// GET /mcp — SSE streaming for server-sent notifications
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? sessions.get(sessionId) : null;
  if (!transport) {
    return res.status(400).json({ error: "No active session. POST to /mcp first." });
  }
  await transport.handleRequest(req, res);
});

// DELETE /mcp — client-initiated session termination
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions.has(sessionId)) {
    try { await sessions.get(sessionId).close(); } catch { /* ignore */ }
    sessions.delete(sessionId);
  }
  res.status(200).end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  process.stderr.write(`[helloleads-mcp] HTTP server listening on port ${PORT}\n`);
});
