// ﻿/**
//  * HelloLeads MCP Server
//  *
//  * Exposes HelloLeads CRM data as MCP tools so any MCP-compatible AI assistant
//  * (GitHub Copilot, Claude Desktop, Cursor, etc.) can query your CRM directly.
//  *
//  * Transport  : stdio  (process stdin / stdout)
//  * Auth       : hls-key + Xemail headers
//  * Config     : environment variables via .env  or the configure_credentials tool
//  *
//  * Tools:
//  *   configure_credentials  — set API credentials (required first)
//  *   get_lists              — list all lists (returns list_key for other tools)
//  *   get_leads              — get / filter leads with pagination
//  *   get_custom_fields      — get custom fields for a list
//  *   get_users              — get all users / team members
//  *   get_lead_activities    — get activity history for a lead
//  *   get_user_activities    — get all lead activities for one or more users
//  *   create_lead            — create a new lead
//  *   update_lead            — update an existing lead
//  */

// import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
// import { randomUUID } from "node:crypto";
// import { z } from "zod";
// import express from "express";
// import { writeFileSync } from "node:fs";
// import { fileURLToPath } from "node:url";
// import { dirname, join } from "node:path";

// // ---------------------------------------------------------------------------
// // Bootstrap .env
// // ---------------------------------------------------------------------------
// const __dirname = dirname(fileURLToPath(import.meta.url));

// try {
//   const { config } = await import("dotenv");
//   config({ path: join(__dirname, "..", ".env") });
// } catch {
//   // dotenv not available — rely on real env vars
// }

// // ---------------------------------------------------------------------------
// // Runtime credentials (settable via configure_credentials tool)
// // ---------------------------------------------------------------------------
// let HLS_BASE_URL = (process.env.HLS_BASE_URL ?? "").replace(/\/$/, "");
// let HLS_API_KEY  = process.env.HLS_API_KEY  ?? "";
// let HLS_EMAIL    = process.env.HLS_EMAIL    ?? "";

// function missingCredsMessage() {
//   if (!HLS_BASE_URL || !HLS_API_KEY || !HLS_EMAIL) {
//     return (
//       "HelloLeads credentials are not configured yet. " +
//       "Please call the `configure_credentials` tool first and provide: " +
//       "baseUrl, apiKey, and email."
//     );
//   }
//   return null;
// }

// function authHeaders() {
//   return {
//     "hls-key": HLS_API_KEY,
//     "Xemail":  HLS_EMAIL,
//     "Content-Type": "application/json",
//     "Accept":       "application/json",
//   };
// }

// // ---------------------------------------------------------------------------
// // HTTP helpers
// // ---------------------------------------------------------------------------
// async function hlsGet(path, params = {}) {
//   const url = new URL(`${HLS_BASE_URL}${path}`);
//   for (const [k, v] of Object.entries(params)) {
//     if (v !== undefined && v !== null && v !== "") {
//       url.searchParams.set(k, String(v));
//     }
//   }
//   const res = await fetch(url.toString(), { method: "GET", headers: authHeaders() });
//   if (!res.ok) throw new Error(`HelloLeads API error ${res.status}: ${await res.text()}`);
//   return res.json();
// }

// async function hlsPost(path, body = {}) {
//   const res = await fetch(`${HLS_BASE_URL}${path}`, {
//     method:  "POST",
//     headers: authHeaders(),
//     body:    JSON.stringify(body),
//   });
//   if (!res.ok) throw new Error(`HelloLeads API error ${res.status}: ${await res.text()}`);
//   return res.json();
// }

// async function hlsPut(path, body = {}) {
//   const res = await fetch(`${HLS_BASE_URL}${path}`, {
//     method:  "PUT",
//     headers: authHeaders(),
//     body:    JSON.stringify(body),
//   });
//   if (!res.ok) throw new Error(`HelloLeads API error ${res.status}: ${await res.text()}`);
//   return res.json();
// }

// // ---------------------------------------------------------------------------
// // MCP Server factory — creates a fresh instance per HTTP request
// // ---------------------------------------------------------------------------
// function createServer() {
// const server = new McpServer({ name: "helloleads-crm", version: "2.0.0" });

// // ---------------------------------------------------------------------------
// // configure_credentials
// // ---------------------------------------------------------------------------
// server.tool(
//   "configure_credentials",
//   "Set your HelloLeads API credentials. Call this first before using any other tool. " +
//   "Credentials are saved to a local .env file so you only need to do this once.",
//   {
//     baseUrl: z.string().url().describe(
//       "Base URL of your HelloLeads app, e.g. https://app.helloleads.io (no trailing slash)."
//     ),
//     apiKey: z.string().min(1).describe(
//       "Your HelloLeads API key. Find it under Settings -> API in the HelloLeads web app."
//     ),
//     email: z.string().email().describe(
//       "Email address of the HelloLeads account owner / API user."
//     ),
//   },
//   async ({ baseUrl, apiKey, email }) => {
//     HLS_BASE_URL = baseUrl.replace(/\/$/, "");
//     HLS_API_KEY  = apiKey;
//     HLS_EMAIL    = email;

//     const envPath = join(__dirname, "..", ".env");
//     const lines = [
//       `HLS_BASE_URL=${HLS_BASE_URL}`,
//       `HLS_API_KEY=${HLS_API_KEY}`,
//       `HLS_EMAIL=${HLS_EMAIL}`,
//     ];
//     try {
//       writeFileSync(envPath, lines.join("\n") + "\n", "utf8");
//     } catch (writeErr) {
//       return {
//         content: [{
//           type: "text",
//           text:
//             "Credentials accepted and active for this session, but could not be saved " +
//             `to disk (${writeErr.message}). You will need to configure again after a restart.`,
//         }],
//       };
//     }
//     return {
//       content: [{
//         type: "text",
//         text:
//           `HelloLeads credentials saved successfully.\n` +
//           `  Base URL : ${HLS_BASE_URL}\n` +
//           `  Email    : ${HLS_EMAIL}\n\n` +
//           `You can now use all HelloLeads tools.`,
//       }],
//     };
//   }
// );

// // ---------------------------------------------------------------------------
// // get_lists  —  GET /index.php/private/api/lists
// // ---------------------------------------------------------------------------
// server.tool(
//   "get_lists",
//   "Get all lists from your HelloLeads CRM account. Each list has a list_key which is required to fetch or create leads.",
//   {},
//   async () => {
//     const credsErr = missingCredsMessage();
//     if (credsErr) return { content: [{ type: "text", text: credsErr }], isError: true };
//     try {
//       const data = await hlsGet("/index.php/private/api/lists");
//       return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
//     } catch (err) {
//       return { content: [{ type: "text", text: `Error fetching lists: ${err.message}` }], isError: true };
//     }
//   }
// );

// // ---------------------------------------------------------------------------
// // get_leads  —  GET /index.php/private/api/leads
// // ---------------------------------------------------------------------------
// server.tool(
//   "get_leads",
//   "Get leads (contacts) from the HelloLeads CRM account. Use get_lists first to obtain a list_key.",
//   {
//     list_key: z.string().optional().describe(
//       "Filter leads belonging to a specific list. Obtain from get_lists tool."
//     ),
//     page: z.number().int().min(1).optional().describe(
//       "Page number for pagination. Default is 1. Check total_pages in the response."
//     ),
//     lead_stage_id: z.string().optional().describe(
//       "Filter by lead stage ID. Single value (e.g. '3') or comma-separated (e.g. '2,3,5')."
//     ),
//     lead_category: z.string().optional().describe(
//       "Filter by lead category. Single value (e.g. 'sales') or comma-separated (e.g. 'sales,marketing')."
//     ),
//     orderByCreatedDateTime: z.enum(["ASC", "DESC"]).optional().describe(
//       "Sort by created date. DESC = newest first, ASC = oldest first."
//     ),
//     orderByModifiedDateTime: z.enum(["ASC", "DESC"]).optional().describe(
//       "Sort by modified date. DESC = newest first, ASC = oldest first."
//     ),
//     createdDateTime_From: z.string().optional().describe(
//       "Filter leads created on or after this date-time. Format: YYYY-MM-DD HH:mm:ss"
//     ),
//     createdDateTime_To: z.string().optional().describe(
//       "Filter leads created on or before this date-time. Format: YYYY-MM-DD HH:mm:ss"
//     ),
//     modifiedDateTime_From: z.string().optional().describe(
//       "Filter leads modified on or after this date-time. Format: YYYY-MM-DD HH:mm:ss"
//     ),
//     modifiedDateTime_To: z.string().optional().describe(
//       "Filter leads modified on or before this date-time. Format: YYYY-MM-DD HH:mm:ss"
//     ),
//   },
//   async (params) => {
//     const credsErr = missingCredsMessage();
//     if (credsErr) return { content: [{ type: "text", text: credsErr }], isError: true };
//     try {
//       const data = await hlsGet("/index.php/private/api/leads", params);
//       return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
//     } catch (err) {
//       return { content: [{ type: "text", text: `Error fetching leads: ${err.message}` }], isError: true };
//     }
//   }
// );

// // ---------------------------------------------------------------------------
// // get_custom_fields  —  GET /api/getCustomFields
// // ---------------------------------------------------------------------------
// server.tool(
//   "get_custom_fields",
//   "Get all custom fields mapped to a specific list. Useful before creating or updating leads with custom field values.",
//   {
//     list_key: z.string().describe(
//       "The list_key of the list to fetch custom fields for. Obtain from get_lists tool."
//     ),
//   },
//   async ({ list_key }) => {
//     const credsErr = missingCredsMessage();
//     if (credsErr) return { content: [{ type: "text", text: credsErr }], isError: true };
//     try {
//       const data = await hlsGet("/api/getCustomFields", { list_key });
//       return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
//     } catch (err) {
//       return { content: [{ type: "text", text: `Error fetching custom fields: ${err.message}` }], isError: true };
//     }
//   }
// );

// // ---------------------------------------------------------------------------
// // get_users  —  GET /index.php/private/api/users
// // ---------------------------------------------------------------------------
// server.tool(
//   "get_users",
//   "Get all users (team members / salespeople) in the HelloLeads CRM account.",
//   {
//     page: z.number().int().min(1).optional().describe(
//       "Page number for pagination."
//     ),
//     orderByCreatedDateTime: z.enum(["ASC", "DESC"]).optional().describe(
//       "Sort by created date. DESC = newest first, ASC = oldest first."
//     ),
//   },
//   async (params) => {
//     const credsErr = missingCredsMessage();
//     if (credsErr) return { content: [{ type: "text", text: credsErr }], isError: true };
//     try {
//       const data = await hlsGet("/index.php/private/api/users", params);
//       return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
//     } catch (err) {
//       return { content: [{ type: "text", text: `Error fetching users: ${err.message}` }], isError: true };
//     }
//   }
// );

// // ---------------------------------------------------------------------------
// // get_lead_activities  —  GET /index.php/private/api/leadActivities
// // ---------------------------------------------------------------------------
// server.tool(
//   "get_lead_activities",
//   "Get the activity history (comments, calls, emails, logs) for a specific lead.",
//   {
//     leadId: z.string().describe(
//       "The unique ID of the lead. Obtain from get_leads tool."
//     ),
//     activityType: z.enum(["all", "comments", "logs"]).optional().describe(
//       "Type of activities to retrieve: all, comments, or logs. Defaults to all."
//     ),
//     createdDateTime_From: z.string().optional().describe(
//       "Filter activities on or after this date-time. Format: YYYY-MM-DD HH:mm:ss"
//     ),
//     createdDateTime_To: z.string().optional().describe(
//       "Filter activities on or before this date-time. Format: YYYY-MM-DD HH:mm:ss"
//     ),
//     orderByCreatedDateTime: z.enum(["ASC", "DESC"]).optional().describe(
//       "Sort by created date. DESC = newest first, ASC = oldest first."
//     ),
//   },
//   async (params) => {
//     const credsErr = missingCredsMessage();
//     if (credsErr) return { content: [{ type: "text", text: credsErr }], isError: true };
//     try {
//       const data = await hlsGet("/index.php/private/api/leadActivities", params);
//       return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
//     } catch (err) {
//       return { content: [{ type: "text", text: `Error fetching lead activities: ${err.message}` }], isError: true };
//     }
//   }
// );

// // ---------------------------------------------------------------------------
// // get_user_activities  —  GET /index.php/private/api/allLeadActivities
// // ---------------------------------------------------------------------------
// server.tool(
//   "get_user_activities",
//   "Get all lead activities performed by one or more users. Useful for tracking a salesperson's workload.",
//   {
//     userId: z.string().describe(
//       "User ID(s) to fetch activities for. Single ID or comma-separated for multiple. Obtain from get_users."
//     ),
//     activityType: z.enum(["all", "comments", "logs"]).optional().describe(
//       "Type of activities: all, comments, or logs. Defaults to all."
//     ),
//     page: z.number().int().min(1).optional().describe(
//       "Page number for pagination. Check totalPages in the response."
//     ),
//     createdDateTime_From: z.string().optional().describe(
//       "Filter activities on or after this date-time. Format: YYYY-MM-DD HH:mm:ss"
//     ),
//     createdDateTime_To: z.string().optional().describe(
//       "Filter activities on or before this date-time. Format: YYYY-MM-DD HH:mm:ss"
//     ),
//     orderByCreatedDateTime: z.enum(["ASC", "DESC"]).optional().describe(
//       "Sort by created date. DESC = newest first, ASC = oldest first."
//     ),
//   },
//   async (params) => {
//     const credsErr = missingCredsMessage();
//     if (credsErr) return { content: [{ type: "text", text: credsErr }], isError: true };
//     try {
//       const data = await hlsGet("/index.php/private/api/allLeadActivities", params);
//       return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
//     } catch (err) {
//       return { content: [{ type: "text", text: `Error fetching user activities: ${err.message}` }], isError: true };
//     }
//   }
// );

// // ---------------------------------------------------------------------------
// // create_lead  —  POST /index.php/private/api/leads
// // ---------------------------------------------------------------------------
// server.tool(
//   "create_lead",
//   "Create a new lead (contact) in the HelloLeads CRM. Use get_lists to get a list_key and get_custom_fields to get custom field IDs.",
//   {
//     list_key: z.string().describe(
//       "The list_key of the list to add the lead to. Required. Obtain from get_lists tool."
//     ),
//     first_name: z.string().min(1).describe("First name of the lead."),
//     last_name: z.string().optional().describe("Last name of the lead."),
//     email: z.string().email().optional().describe("Email address of the lead."),
//     mobile: z.string().optional().describe("Mobile number of the lead."),
//     mobile_code: z.string().optional().describe("Country dial code for mobile, e.g. +1, +91."),
//     phone: z.string().optional().describe("Landline / office phone number."),
//     fax: z.string().optional().describe("Fax number."),
//     company: z.string().optional().describe("Company name."),
//     designation: z.string().optional().describe("Job title / designation."),
//     website: z.string().optional().describe("Website URL."),
//     address_line1: z.string().optional().describe("Address line 1."),
//     address_line2: z.string().optional().describe("Address line 2."),
//     city: z.string().optional().describe("City."),
//     state: z.string().optional().describe("State / province."),
//     country: z.string().optional().describe("Country."),
//     postal_code: z.string().optional().describe("Postal / ZIP code."),
//     notes: z.string().optional().describe("Free-text notes about the lead."),
//     tags: z.string().optional().describe("Comma-separated tags."),
//     product_group: z.string().optional().describe("Product group the lead belongs to."),
//     customer_group: z.string().optional().describe("Customer group the lead belongs to."),
//     deal_size: z.string().optional().describe("Estimated deal size / value."),
//     potential: z.enum(["Low", "Medium", "High"]).optional().describe(
//       "Lead potential: Low, Medium, or High."
//     ),
//     custfields: z.record(z.string(), z.string()).optional().describe(
//       "Custom field values as key-value pairs {CustomFieldID: value}. Use get_custom_fields to obtain IDs."
//     ),
//   },
//   async (params) => {
//     const credsErr = missingCredsMessage();
//     if (credsErr) return { content: [{ type: "text", text: credsErr }], isError: true };
//     try {
//       const data = await hlsPost("/index.php/private/api/leads", params);
//       return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
//     } catch (err) {
//       return { content: [{ type: "text", text: `Error creating lead: ${err.message}` }], isError: true };
//     }
//   }
// );

// // ---------------------------------------------------------------------------
// // update_lead  —  PUT /index.php/private/api/lead/:id
// // ---------------------------------------------------------------------------
// server.tool(
//   "update_lead",
//   "Update an existing lead in the HelloLeads CRM. Use get_leads to obtain the lead ID.",
//   {
//     id: z.string().describe(
//       "The unique ID of the lead to update. Obtain from get_leads tool."
//     ),
//     list_key: z.string().optional().describe("The list_key of the list the lead belongs to."),
//     modified_by: z.string().optional().describe("Email address of the user making the update."),
//     first_name: z.string().optional().describe("First name."),
//     last_name: z.string().optional().describe("Last name."),
//     email: z.string().email().optional().describe("Email address."),
//     mobile: z.string().optional().describe("Mobile number."),
//     mobile_code: z.string().optional().describe("Country dial code, e.g. +1, +91."),
//     phone: z.string().optional().describe("Landline / office phone."),
//     telephone_office: z.string().optional().describe("Office telephone number."),
//     company: z.string().optional().describe("Company name."),
//     designation: z.string().optional().describe("Job title / designation."),
//     website: z.string().optional().describe("Website URL."),
//     address_line1: z.string().optional().describe("Address line 1."),
//     address_line2: z.string().optional().describe("Address line 2."),
//     city: z.string().optional().describe("City."),
//     state: z.string().optional().describe("State / province."),
//     country: z.string().optional().describe("Country."),
//     postal_code: z.string().optional().describe("Postal / ZIP code."),
//     notes: z.string().optional().describe("Free-text notes."),
//     lead_stage_id: z.string().optional().describe("Lead stage ID to move the lead to."),
//     deal_size: z.string().optional().describe("Estimated deal size / value."),
//     potential: z.enum(["Low", "Medium", "High"]).optional().describe(
//       "Lead potential: Low, Medium, or High."
//     ),
//     custfields: z.record(z.string(), z.string()).optional().describe(
//       "Custom field values as {CustomFieldID: value}. Use get_custom_fields to find IDs."
//     ),
//     followUpDetails: z
//       .object({
//         assignedToUserEmail: z.string().email().optional().describe(
//           "Email of the user to assign the follow-up to."
//         ),
//         followUpDateTime: z.string().optional().describe(
//           "Follow-up date and time. Format: YYYY-MM-DD HH:mm:ss"
//         ),
//         followUpNotes: z.string().optional().describe("Notes for the follow-up."),
//         repeatFollowUpFrequency: z.string().optional().describe(
//           "Repeat frequency, e.g. None, Daily, Weekly."
//         ),
//         doNotFollowUpStatus: z.enum(["ON", "OFF"]).optional().describe(
//           "Whether to suppress follow-up reminders."
//         ),
//         doNotFollowUpReason: z.string().nullable().optional().describe(
//           "Reason for suppressing follow-up."
//         ),
//       })
//       .optional()
//       .describe("Follow-up scheduling details."),
//   },
//   async ({ id, ...rest }) => {
//     const credsErr = missingCredsMessage();
//     if (credsErr) return { content: [{ type: "text", text: credsErr }], isError: true };
//     try {
//       const data = await hlsPut(`/index.php/private/api/lead/${encodeURIComponent(id)}`, rest);
//       return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
//     } catch (err) {
//       return { content: [{ type: "text", text: `Error updating lead: ${err.message}` }], isError: true };
//     }
//   }
// );

//   return server;
// }

// // ---------------------------------------------------------------------------
// // HTTP server for Railway deployment
// // ---------------------------------------------------------------------------
// const app = express();
// app.use(express.json());

// // CORS — required for web-based MCP clients (Convocore, etc.)
// app.use((req, res, next) => {
//   res.setHeader("Access-Control-Allow-Origin", "*");
//   res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
//   res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
//   if (req.method === "OPTIONS") return res.status(204).end();
//   next();
// });

// app.get("/health", (_req, res) => {
//   res.json({ status: "ok", service: "helloleads-mcp" });
// });

// // ---------------------------------------------------------------------------
// // Stateful MCP sessions — keeps initialize + tools/list in the same session
// // ---------------------------------------------------------------------------
// const sessions = new Map(); // sessionId -> StreamableHTTPServerTransport

// app.post("/mcp", async (req, res) => {
//   try {
//     const sessionId = req.headers["mcp-session-id"];
//     let transport = sessionId ? sessions.get(sessionId) : null;

//     if (!transport) {
//       // New session: create server + transport together
//       transport = new StreamableHTTPServerTransport({
//         sessionIdGenerator: () => randomUUID(),
//         onsessioninitialized: (id) => {
//           sessions.set(id, transport);
//         },
//       });
//       const mcpServer = createServer();
//       await mcpServer.connect(transport);
//     }

//     await transport.handleRequest(req, res, req.body);
//   } catch (err) {
//     if (!res.headersSent) {
//       res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: null });
//     }
//   }
// });

// // GET /mcp — SSE streaming for server-sent notifications
// app.get("/mcp", async (req, res) => {
//   const sessionId = req.headers["mcp-session-id"];
//   const transport = sessionId ? sessions.get(sessionId) : null;
//   if (!transport) {
//     return res.status(400).json({ error: "No active session. POST to /mcp first." });
//   }
//   await transport.handleRequest(req, res);
// });

// // DELETE /mcp — client-initiated session termination
// app.delete("/mcp", async (req, res) => {
//   const sessionId = req.headers["mcp-session-id"];
//   if (sessionId && sessions.has(sessionId)) {
//     try { await sessions.get(sessionId).close(); } catch { /* ignore */ }
//     sessions.delete(sessionId);
//   }
//   res.status(200).end();
// });

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//   process.stderr.write(`[helloleads-mcp] HTTP server listening on port ${PORT}\n`);
// });

// Murali's Code
#!/usr/bin/env node
/**
 * HLS MCP Server
 * Generated from HLS_MCP-APIs Postman collection
 *
 * Exposes all HLS CRM API endpoints as MCP tools.
 * Set environment variables before running:
 *   HLS_BASE_URL   - e.g. https://your-hls-instance.com
 *   HLS_TOKEN      - Bearer token (or use mcp_login tool to obtain one)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ─── Config ─────────────────────────────────────────────────────────────────
const BASE_URL = (process.env.HLS_BASE_URL || "https://dev.helloleads.io").replace(/\/$/, "");
let AUTH_TOKEN = process.env.HLS_TOKEN || "";
let USER_ID = process.env.HLS_USER_ID || "";

// ─── HTTP Helper ─────────────────────────────────────────────────────────────
async function hlsRequest({ method, path, query = {}, body = null, token }) {
  const bearerToken = token !== undefined ? token : AUTH_TOKEN;
  const userIdHeader = USER_ID;
  const url = new URL(`${BASE_URL}${path}`);

  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  });

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "ApiClient": "MCP"
  };
  if (bearerToken) headers["Auth"] = bearerToken;
  if (userIdHeader) headers["Xemail"] = userIdHeader;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url.toString(), opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) throw new Error(`HLS API error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// ─── Logging Helper ──────────────────────────────────────────────────────────
import fs from "fs";
import path from "path";
const LOG_FILE = path.join(process.cwd(), "mcp_server.log");
function log_message(tool, params) {
  const logEntry = `[${new Date().toISOString()}] Tool: ${tool}, Params: ${JSON.stringify(params)}\n`;
  fs.appendFileSync(LOG_FILE, logEntry);
}

// ─── Server ──────────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "hls-mcp-server",
  version: "1.0.0",
  description: "MCP Server for HLS CRM APIs",
});

// ════════════════════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════════════════════

server.tool(
  "mcp_login",
  "Login to HLS and obtain a bearer token. Call this first if HLS_TOKEN env var is not set.",
  {
    username: z.string().describe("HLS account username / email"),
    password: z.string().describe("HLS account password"),
  },
  async (params) => {
    log_message("mcp_login", params);
    const { username, password } = params;
    const data = await hlsRequest({
      method: "POST",
      path: "/index.php/api/account/mcplogin",
      body: { username, password },
      token: "",
    });
    if (data?.token) AUTH_TOKEN = data.token;
    if (data?.userId) USER_ID = data.userId;
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ════════════════════════════════════════════════════════════════════════════
// LEADS
// ════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_leads_summary",
  "Get a summary of leads for an organization/visitor.",
  {
    organizationId: z.string().describe("Organization ID"),
    visitorId: z.string().optional().describe("Visitor / lead ID"),
  },
  async (params) => {
    log_message("get_leads_summary", params);
    const { organizationId, visitorId } = params;
    const data = await hlsRequest({
      method: "GET",
      path: "/api/mcp/v1/leads/leadSummary",
      query: { organizationId, visitorId },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_leads",
  "Retrieve leads with rich filtering (pagination, stage, tags, dates, deal size, etc.).",
  {
    org_id: z.string().describe("Organization ID"),
    page: z.string().optional().default("1").describe("Page number"),
    page_size: z.string().optional().default("50").describe("Results per page (max 50)"),
    lead_ids: z.string().optional().describe("Comma-separated lead IDs"),
    list_ids: z.string().optional().describe("Comma-separated list IDs"),
    assigned_to_ids: z.string().optional().describe("Comma-separated user IDs or 'unassigned'"),
    assigned_by_ids: z.string().optional().describe("Comma-separated user IDs"),
    captured_by_ids: z.string().optional().describe("Comma-separated user IDs"),
    stage_ids: z.string().optional().describe("Comma-separated stage IDs"),
    customer_group_ids: z.string().optional().describe("Comma-separated customer group IDs"),
    product_group_ids: z.string().optional().describe("Comma-separated product group IDs"),
    tag_ids: z.string().optional().describe("Comma-separated tag IDs"),
    lead_source_code: z.string().optional().describe("Comma-separated source codes e.g. M_FO,W_EX"),
    potential: z.string().optional().describe("Comma-separated values: High, Medium, Low"),
    score_min: z.string().optional().describe("Minimum lead score"),
    score_max: z.string().optional().describe("Maximum lead score"),
    deal_size_op: z.string().optional().describe("Deal size operator: between, gt, lt"),
    deal_size_min: z.string().optional().describe("Minimum deal size"),
    deal_size_max: z.string().optional().describe("Maximum deal size"),
    created_from: z.string().optional().describe("Created from ISO8601 e.g. 2025-01-01T00:00:00Z"),
    created_to: z.string().optional().describe("Created to ISO8601"),
    modified_from: z.string().optional().describe("Modified from ISO8601"),
    modified_to: z.string().optional().describe("Modified to ISO8601"),
    followup_from: z.string().optional().describe("Follow-up from ISO8601"),
    followup_to: z.string().optional().describe("Follow-up to ISO8601"),
    dob_from: z.string().optional().describe("Date of birth from YYYY-MM-DD"),
    dob_to: z.string().optional().describe("Date of birth to YYYY-MM-DD"),
    special_date_from: z.string().optional().describe("Special date from YYYY-MM-DD"),
    special_date_to: z.string().optional().describe("Special date to YYYY-MM-DD"),
    sort_by: z.string().optional().describe("Sort field e.g. modified_at"),
    sort_order: z.string().optional().describe("asc or desc"),
  },
  async (params) => {
    log_message("get_leads", params);
    const data = await hlsRequest({ method: "GET", path: "/api/mcp/v1/leads/leads", query: params });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_unattended_leads",
  "Get leads that have not been attended to within specified criteria.",
  {
    organizationId: z.string().describe("Organization ID"),
    userId: z.string().optional().describe("User ID"),
    roleId: z.string().optional().describe("Role ID"),
    assigned_user_ids: z.string().optional().describe("Comma-separated assigned user IDs"),
    lead_captured_during: z.string().optional().describe("Time period filter"),
    lead_source_code: z.string().optional().describe("Lead source codes"),
    lead_stage_ids: z.string().optional().describe("Comma-separated stage IDs"),
    list_ids: z.string().optional().describe("Comma-separated list IDs"),
    no_activity_days: z.string().optional().describe("Days without activity threshold"),
    page_size: z.string().optional().describe("Results per page"),
  },
  async (params) => {
    log_message("get_unattended_leads", params);
    const data = await hlsRequest({
      method: "GET",
      path: "/index.php/api/mcp/v1/leads/unattendedLeads",
      query: params,
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "create_lead",
  "Create a new lead in HLS.",
  {
    organizationId: z.string().describe("Organization ID"),
    visitorId: z.string().optional().describe("Visitor ID (if pre-existing)"),
    listId: z.number().describe("List ID to add the lead into"),
    firstName: z.string().optional().describe("First name"),
    lastName: z.string().optional().describe("Last name"),
    email: z.string().optional().describe("Email address"),
    phone: z.string().optional().describe("Phone number"),
    notes: z.string().optional().describe("Notes about the lead"),
    extraFields: z.record(z.unknown()).optional().describe("Any additional fields as key-value pairs"),
  },
  async (params) => {
    log_message("create_lead", params);
    const { organizationId, visitorId, listId, firstName, lastName, email, phone, notes, extraFields } = params;
    const body = { listId, ...extraFields };
    if (firstName) body.firstName = firstName;
    if (lastName) body.lastName = lastName;
    if (email) body.email = email;
    if (phone) body.phone = phone;
    if (notes) body.notes = notes;
    const data = await hlsRequest({
      method: "POST",
      path: "/api/mcp/v1/leads/leadCreate",
      query: { organizationId, visitorId },
      body,
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "create_lead_comment",
  "Add a comment to an existing lead.",
  {
    lead_id: z.number().describe("Visitor / lead ID"),
    org_id: z.number().describe("Organization ID"),
    comment: z.string().describe("Comment text"),
    comment_userId: z.number().describe("User ID posting the comment"),
  },
  async (params) => {
    log_message("create_lead_comment", params);
    const { lead_id, org_id, comment, comment_userId } = params;
    const data = await hlsRequest({
      method: "POST",
      path: "/api/mcp/v1/leads/leadCommentCreate",
      body: {
        lead_id: String(lead_id),
        org_id: org_id, // keep as integer
        comment,
        comment_userId: String(comment_userId)
      },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "update_lead_profile",
  "Update a lead's profile information (name, email, phone, etc.).",
  {
    visitorId: z.string().describe("Visitor / lead ID"),
    organizationId: z.string().describe("Organization ID"),
    firstName: z.string().optional().describe("First name"),
    lastName: z.string().optional().describe("Last name"),
    email: z.string().optional().describe("Email address"),
    phone: z.string().optional().describe("Phone number"),
    extraFields: z.record(z.unknown()).optional().describe("Additional profile fields"),
  },
  async ({ visitorId, organizationId, firstName, lastName, email, phone, extraFields }) => {
    const body = { visitorId, organizationId, ...extraFields };
    if (firstName) body.firstName = firstName;
    if (lastName) body.lastName = lastName;
    if (email) body.email = email;
    if (phone) body.phone = phone;
    const data = await hlsRequest({ method: "PUT", path: "/api/mcp/v1/leads/profile", body });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "update_lead_qualifiers",
  "Update qualifiers (stage, potential, tags, product/customer groups) for a lead.",
  {
    visitorId: z.string().describe("Visitor / lead ID"),
    organizationId: z.string().describe("Organization ID"),
    stageId: z.number().optional().describe("Lead stage ID"),
    potential: z.string().optional().describe("High, Medium, or Low"),
    tagIds: z.array(z.number()).optional().describe("Array of tag IDs"),
    productGroupIds: z.array(z.number()).optional().describe("Array of product group IDs"),
    customerGroupId: z.number().optional().describe("Customer group ID"),
  },
  async ({ visitorId, organizationId, ...rest }) => {
    const data = await hlsRequest({
      method: "PUT",
      path: "/api/mcp/v1/leads/qualifiers",
      body: { visitorId, organizationId, ...rest },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "update_lead_followup",
  "Update the follow-up date/time for a lead.",
  {
    visitorId: z.string().describe("Visitor / lead ID"),
    organizationId: z.string().describe("Organization ID"),
    followupDate: z.string().describe("Follow-up datetime ISO8601 or YYYY-MM-DD HH:mm:ss"),
    followupNote: z.string().optional().describe("Note for the follow-up"),
  },
  async ({ visitorId, organizationId, followupDate, followupNote }) => {
    const data = await hlsRequest({
      method: "PUT",
      path: "/api/mcp/v1/leads/followup",
      body: { visitorId, organizationId, followupDate, followupNote },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "update_lead_info_plus",
  "Update extended lead information (Info Plus custom fields).",
  {
    visitorId: z.string().describe("Visitor / lead ID"),
    organizationId: z.string().describe("Organization ID"),
    fields: z.record(z.unknown()).describe("Key-value map of Info Plus fields to update"),
  },
  async ({ visitorId, organizationId, fields }) => {
    const data = await hlsRequest({
      method: "PUT",
      path: "/api/mcp/v1/leads/infoPlus",
      body: { visitorId, organizationId, ...fields },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ════════════════════════════════════════════════════════════════════════════
// ORG & QUALIFIERS
// ════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_org",
  "Get organization details.",
  { organizationId: z.string().describe("Organization ID") },
  async ({ organizationId }) => {
    const data = await hlsRequest({
      method: "GET",
      path: "/index.php/api/mcp/v1/org",
      query: { organizationId },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_product_groups",
  "List all product groups for an organization.",
  { organizationId: z.string().describe("Organization ID") },
  async ({ organizationId }) => {
    const data = await hlsRequest({
      method: "GET",
      path: "/api/mcp/v1/org/productGroups",
      query: { organizationId },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_customer_groups",
  "List all customer groups for an organization.",
  { organizationId: z.string().describe("Organization ID") },
  async ({ organizationId }) => {
    const data = await hlsRequest({
      method: "GET",
      path: "/api/mcp/v1/org/customerGroups",
      query: { organizationId },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_tags",
  "List all tags for an organization.",
  { organizationId: z.string().describe("Organization ID") },
  async ({ organizationId }) => {
    const data = await hlsRequest({ method: "GET", path: "/api/mcp/v1/org/tags", query: { organizationId } });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_custom_fields",
  "List all custom fields defined for an organization.",
  { organizationId: z.string().describe("Organization ID") },
  async ({ organizationId }) => {
    const data = await hlsRequest({
      method: "GET",
      path: "/api/mcp/v1/org/customFields",
      query: { organizationId },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_lead_stages",
  "List all lead stages for an organization.",
  { organizationId: z.string().describe("Organization ID") },
  async ({ organizationId }) => {
    const data = await hlsRequest({
      method: "GET",
      path: "/api/mcp/v1/org/leadStages",
      query: { organizationId },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ════════════════════════════════════════════════════════════════════════════
// BULK QUALIFIER UPDATES
// ════════════════════════════════════════════════════════════════════════════

server.tool(
  "bulk_update_lead_stage",
  "Bulk update lead stage for multiple leads.",
  {
    organizationId: z.string().describe("Organization ID"),
    visitorIds: z.string().describe("Comma-separated visitor IDs"),
    stageId: z.number().describe("Target stage ID"),
  },
  async ({ organizationId, visitorIds, stageId }) => {
    const data = await hlsRequest({
      method: "PUT",
      path: "/api/mcp/v1/BulkQualifier/updateLeadStage",
      query: { organizationId },
      body: { visitorIds, stageId },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "bulk_update_potential",
  "Bulk update potential for multiple leads.",
  {
    organizationId: z.string().describe("Organization ID"),
    visitorIds: z.string().describe("Comma-separated visitor IDs"),
    potential: z.enum(["High", "Medium", "Low"]).describe("Potential value"),
  },
  async ({ organizationId, visitorIds, potential }) => {
    const data = await hlsRequest({
      method: "PUT",
      path: "/api/mcp/v1/BulkQualifier/updatePotential",
      query: { organizationId },
      body: { visitorIds, potential },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "bulk_update_customer_group",
  "Bulk update customer group for multiple leads.",
  {
    organizationId: z.string().describe("Organization ID"),
    visitorIds: z.string().describe("Comma-separated visitor IDs"),
    categoryId: z.number().describe("Customer group / category ID"),
  },
  async ({ organizationId, visitorIds, categoryId }) => {
    const data = await hlsRequest({
      method: "PUT",
      path: "/api/mcp/v1/BulkQualifier/updateCustomerGroup",
      query: { organizationId },
      body: { visitorIds, categoryId },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "bulk_update_product_groups",
  "Bulk update product groups for multiple leads.",
  {
    organizationId: z.string().describe("Organization ID"),
    visitorIds: z.string().describe("Comma-separated visitor IDs"),
    services: z
      .array(z.object({ id: z.string(), name: z.string() }))
      .describe("Array of product group objects [{id, name}]"),
    updateMode: z.enum(["append", "replace"]).default("append").describe("append or replace existing groups"),
  },
  async ({ organizationId, visitorIds, services, updateMode }) => {
    const data = await hlsRequest({
      method: "PUT",
      path: "/api/mcp/v1/BulkQualifier/updateProductGroups",
      query: { organizationId },
      body: { visitorIds, services, updateMode },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "bulk_update_tags",
  "Bulk update tags for multiple leads.",
  {
    organizationId: z.string().describe("Organization ID"),
    userId: z.string().describe("User ID performing the update"),
    visitorIds: z.string().describe("Comma-separated visitor IDs"),
    tags: z
      .array(z.object({ id: z.number(), tag: z.string() }))
      .describe("Array of tag objects [{id, tag}]"),
    updateMode: z.enum(["append", "replace"]).default("append").describe("append or replace existing tags"),
  },
  async ({ organizationId, userId, visitorIds, tags, updateMode }) => {
    const data = await hlsRequest({
      method: "PUT",
      path: "/api/mcp/v1/BulkQualifier/updateTags",
      query: { organizationId },
      body: { tags, updateMode, visitorIds, orgnizationId: organizationId, userId },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "bulk_assign_leads",
  "Bulk assign multiple leads to a user.",
  {
    organizationId: z.string().describe("Organization ID"),
    visitorIds: z.string().describe("Comma-separated visitor IDs"),
    assignTo: z.string().describe("User ID to assign leads to"),
    assignBy: z.string().describe("User ID performing the assignment"),
    assignedAt: z.string().optional().describe("Assignment timestamp YYYY-MM-DD HH:mm:ss (defaults to now)"),
    dontFollow: z.string().optional().default("0").describe("0 = follow, 1 = don't follow"),
  },
  async ({ organizationId, visitorIds, assignTo, assignBy, assignedAt, dontFollow }) => {
    const data = await hlsRequest({
      method: "PUT",
      path: "/api/mcp/v1/BulkQualifier/bulkAssign",
      query: { organizationId },
      body: {
        visitorIds,
        organizationId,
        gAssignTo: assignTo,
        assignBy,
        gAssigne: assignTo,
        dontFollow: dontFollow || "0",
        dontFollowRes: "",
        assignedAt: assignedAt || new Date().toISOString().replace("T", " ").slice(0, 19),
      },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ════════════════════════════════════════════════════════════════════════════
// TODOS
// ════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_todos",
  "Get todos/tasks for a lead.",
  {
    organizationId: z.string().describe("Organization ID"),
    visitorId: z.string().describe("Visitor / lead ID"),
  },
  async ({ organizationId, visitorId }) => {
    const data = await hlsRequest({
      method: "GET",
      path: "/index.php/api/mcp/v1/todo/todo/todo",
      query: { organizationId, visitorId },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "create_todo",
  "Create a new todo/task for a lead.",
  {
    organizationId: z.string().describe("Organization ID"),
    visitorId: z.string().describe("Visitor / lead ID"),
    assignedTo: z.number().describe("User ID to assign the todo to"),
    createdBy: z.number().describe("User ID creating the todo"),
    modifiedBy: z.number().describe("User ID modifying the todo"),
    title: z.string().optional().describe("Todo title"),
    dueDateTime: z.string().describe("Due date-time YYYY-MM-DD HH:mm:ss"),
    critical: z.number().optional().default(0).describe("1 = critical, 0 = normal"),
    donePercent: z.number().optional().default(0).describe("Completion percentage 0–100"),
    extraFields: z.record(z.unknown()).optional().describe("Additional fields"),
  },
  async ({ organizationId, visitorId, assignedTo, createdBy, modifiedBy, title, dueDateTime, critical, donePercent, extraFields }) => {
    const body = {
      organizationId,
      visitorId,
      assignedTo,
      assignedToPre: 0,
      createdBy,
      modifiedBy,
      critical,
      donePercent,
      dueDateTime,
      ...extraFields,
    };
    if (title) body.title = title;
    const data = await hlsRequest({ method: "POST", path: "/index.php/api/mcp/v1/todo/todo/todo", body });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "update_todo",
  "Update an existing todo/task.",
  {
    id: z.number().describe("Todo ID"),
    organizationId: z.string().describe("Organization ID"),
    assignedTo: z.number().describe("User ID assigned to"),
    modifiedBy: z.number().describe("User ID making the update"),
    dueDateTime: z.string().optional().describe("New due date-time YYYY-MM-DD HH:mm:ss"),
    critical: z.number().optional().describe("1 = critical, 0 = normal"),
    donePercent: z.number().optional().describe("Completion percentage 0–100"),
    extraFields: z.record(z.unknown()).optional().describe("Additional fields to update"),
  },
  async ({ id, organizationId, assignedTo, modifiedBy, dueDateTime, critical, donePercent, extraFields }) => {
    const body = { id, organizationId, assignedTo, assignedToPre: 0, modifiedBy, ...extraFields };
    if (dueDateTime) body.dueDateTime = dueDateTime;
    if (critical !== undefined) body.critical = critical;
    if (donePercent !== undefined) body.donePercent = donePercent;
    const data = await hlsRequest({
      method: "PUT",
      path: "/index.php/api/mcp/v1/todo/todo/todo",
      query: { id, organizationId, assignedTo },
      body,
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ════════════════════════════════════════════════════════════════════════════
// USERS
// ════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_users",
  "Get users in an organization.",
  {
    org_id: z.string().describe("Organization ID"),
    user_id: z.string().optional().describe("Specific user ID to fetch"),
  },
  async ({ org_id, user_id }) => {
    const data = await hlsRequest({
      method: "GET",
      path: "/api/mcp/v1/users/users",
      query: { org_id, user_id },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "create_user",
  "Create a new user in the organization.",
  {
    org_id: z.string().describe("Organization ID"),
    firstName: z.string().describe("First name"),
    lastName: z.string().optional().describe("Last name"),
    email: z.string().describe("Email address"),
    phone: z.string().optional().describe("Phone number"),
    roleId: z.number().optional().describe("Role ID"),
    extraFields: z.record(z.unknown()).optional().describe("Additional user fields"),
  },
  async ({ org_id, firstName, lastName, email, phone, roleId, extraFields }) => {
    const data = await hlsRequest({
      method: "POST",
      path: "/api/mcp/v1/users/users",
      query: { org_id },
      body: { firstName, lastName, email, phone, roleId, ...extraFields },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "update_user",
  "Update an existing user's information.",
  {
    org_id: z.string().describe("Organization ID"),
    userId: z.string().describe("User ID to update"),
    firstName: z.string().optional().describe("First name"),
    lastName: z.string().optional().describe("Last name"),
    email: z.string().optional().describe("Email address"),
    phone: z.string().optional().describe("Phone number"),
    extraFields: z.record(z.unknown()).optional().describe("Additional fields to update"),
  },
  async ({ org_id, userId, firstName, lastName, email, phone, extraFields }) => {
    const data = await hlsRequest({
      method: "PUT",
      path: "/api/mcp/v1/users/users",
      body: { org_id, userId, firstName, lastName, email, phone, ...extraFields },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ════════════════════════════════════════════════════════════════════════════
// TEAM PERFORMANCE REPORTS
// ════════════════════════════════════════════════════════════════════════════

const reportSchema = {
  organizationId: z.string().describe("Organization ID"),
  userIds: z.array(z.string()).describe("Array of user ID strings"),
  currentStartDate: z.string().describe("Report start date YYYY-MM-DD HH:mm:ss"),
  currentEndDate: z.string().describe("Report end date YYYY-MM-DD HH:mm:ss"),
};

server.tool(
  "get_sales_performance",
  "Get sales performance report for team members over a date range.",
  reportSchema,
  async ({ organizationId, userIds, currentStartDate, currentEndDate }) => {
    const data = await hlsRequest({
      method: "POST",
      path: "/api/mcp/v1/teamreport/salesPerformance",
      query: { organizationId },
      body: { userIds, currentStartDate, currentEndDate },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_lead_management_activity",
  "Get lead management activity report for team members.",
  reportSchema,
  async ({ organizationId, userIds, currentStartDate, currentEndDate }) => {
    const data = await hlsRequest({
      method: "POST",
      path: "/api/mcp/v1/teamreport/leadManagementActivity",
      query: { organizationId },
      body: { userIds, currentStartDate, currentEndDate },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_customer_communication",
  "Get customer communication report for team members.",
  reportSchema,
  async ({ organizationId, userIds, currentStartDate, currentEndDate }) => {
    const data = await hlsRequest({
      method: "POST",
      path: "/api/mcp/v1/teamreport/customerCommunication",
      query: { organizationId },
      body: { userIds, currentStartDate, currentEndDate },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_activity_metrics",
  "Get activity metrics report for team members.",
  reportSchema,
  async ({ organizationId, userIds, currentStartDate, currentEndDate }) => {
    const data = await hlsRequest({
      method: "POST",
      path: "/api/mcp/v1/teamreport/activityMetrics",
      query: { organizationId },
      body: { userIds, currentStartDate, currentEndDate },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("HLS MCP Server running on stdio");


