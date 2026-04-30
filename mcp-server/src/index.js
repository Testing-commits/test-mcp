/**
 * HLS MCP Server — synced for ChatGPT + Claude
 *
 * Changes from original:
 *  1. Transport: StdioServerTransport → HTTP + SSE (required for ChatGPT/Claude connectors)
 *  2. Auth: mcp_login tool removed — credentials come from .env, never from LLM
 *  3. Per-request context: AUTH_TOKEN + USER_ID read from env at startup (OAuth layer adds later)
 *  4. Logging: async appendFile (non-blocking)
 *  5. CORS: allows ChatGPT + Claude origins
 *  6. Health check: GET /mcp returns server manifest
 *  7. orgnizationId typo fixed in bulk_update_tags
 *
 * All 32 HLS API tools, paths, query params, and body shapes — UNCHANGED.
 *
 * Environment variables (.env):
 *   HLS_BASE_URL   = https://dev.helloleads.io
 *   HLS_TOKEN      = your session token (Auth header)
 *   HLS_USER_ID    = your userId (Xemail header)
 *   PORT           = 3000
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ─────────────────────────────────────────────────────────────────
const BASE_URL       = (process.env.HLS_BASE_URL || "https://dev.helloleads.io").replace(/\/$/, "");
const AUTH_TOKEN     = process.env.HLS_TOKEN   || "";
const USER_ID        = process.env.HLS_USER_ID || "";
const PORT           = parseInt(process.env.PORT || "3000");
const USE_HTTPS      = process.env.USE_HTTPS === "1" || process.env.USE_HTTPS === "true";
const HTTPS_KEY_PATH = process.env.HTTPS_KEY_PATH || "";
const HTTPS_CERT_PATH= process.env.HTTPS_CERT_PATH || "";
const HTTPS_PFX_PATH = process.env.HTTPS_PFX_PATH || "";
const HTTPS_PASSPHRASE = process.env.HTTPS_PASSPHRASE || "";
const OAUTH_ENABLED  = process.env.OAUTH_ENABLED === "1" || process.env.OAUTH_ENABLED === "true";

// ─── Token cache + validation ───────────────────────────────────────────────
const tokenCache = new Map(); // token → { userId, sessionId, expiry, ... }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function extractToken(req) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.substring(7).trim();
}

async function validateBearerToken(token) {
  if (!token) return null;

  const cached = tokenCache.get(token);
  if (cached && cached.expiry > Date.now()) {
    console.error(`[Auth] Using cached token session for userId=${cached.userId}`);
    return cached;
  }

  try {
    let response = await fetch(`${BASE_URL}/api/mcp/validateToken`, {
      headers: { token },
    });

    if (response.status === 404) {
      response = await fetch(`${BASE_URL}/api/mcp/v1/oauth/validate`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
    }

    if (!response.ok) {
      const error = await response.text();
      console.error(`[Auth] Token validation failed: ${response.status} ${error}`);
      return null;
    }

    const data = await response.json();
    const session = {
      userId:    data.userId,
      sessionId: token,
      orgId:     data.orgId,
      emailId:   data.emailId,
      userName:  data.userName,
      orgName:   data.orgName,
      expiry:    Date.now() + CACHE_TTL,
    };
    tokenCache.set(token, session);
    return session;
  } catch (err) {
    console.error(`[Auth] Token validation error: ${err.message}`);
    return null;
  }
}

const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 100; // max requests per window

function checkRateLimit(sessionId, max = RATE_LIMIT_MAX, window = RATE_LIMIT_WINDOW) {
  if (!sessionId) throw new Error("Missing sessionId for rate limiting");
  const now = Date.now();
  const entry = rateLimitStore.get(sessionId) || { count: 0, windowStart: now };

  if (now - entry.windowStart > window) {
    entry.count = 0;
    entry.windowStart = now;
  }

  entry.count += 1;
  rateLimitStore.set(sessionId, entry);

  if (entry.count > max) {
    throw new Error("Rate limit exceeded");
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of tokenCache.entries()) {
    if (session.expiry < now) {
      tokenCache.delete(token);
    }
  }

  for (const [sessionId, entry] of rateLimitStore.entries()) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW) {
      rateLimitStore.delete(sessionId);
    }
  }
}, 60000);

// ─── Logging Helper (async) ──────────────────────────────────────────────────
const LOG_FILE = path.join(__dirname, "mcp_server.log");
function log_message(tool, params) {
  const entry = `[${new Date().toISOString()}] Tool: ${tool}, Params: ${JSON.stringify(params)}\n`;
  fs.appendFile(LOG_FILE, entry, () => {}); // non-blocking
}

// ─── HTTP Helper ─────────────────────────────────────────────────────────────
// All 32 HLS APIs receive the same Xemail + Auth headers — unchanged.
// Now supports per-request OAuth credentials via authContext parameter.
async function hlsRequest({ method, path: apiPath, query = {}, body = null, authContext = null }) {
  const url = new URL(`${BASE_URL}${apiPath}`);

  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  });

  const headers = {
    "Content-Type": "application/json",
    Accept:         "application/json",
    ApiClient:      "MCP",
  };

  // Use OAuth context if provided, otherwise fall back to env vars
  if (authContext) {
    headers["Auth"]   = authContext.sessionId;
    headers["Xemail"] = authContext.userId;
  } else {
    if (AUTH_TOKEN) headers["Auth"]   = AUTH_TOKEN;
    if (USER_ID)    headers["Xemail"] = USER_ID;
  }

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res  = await fetch(url.toString(), opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) throw new Error(`HLS API error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// ─── MCP Server factory ──────────────────────────────────────────────────────
// Called once per SSE session — returns a fully-configured McpServer instance.
// OAuth authContext is passed to all tool handlers for per-user authentication.
function createMcpServer(authContext = null) {
  const server = new McpServer({
    name:        "hls-mcp-server",
    version:     "1.0.0",
    description: "MCP Server for HLS CRM APIs",
  });

  // Helper to inject authContext into all hlsRequest calls
  const authedHlsRequest = (params) => hlsRequest({ ...params, authContext });

  // ══════════════════════════════════════════════════════════════════════════
  // LEADS
  // ══════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_leads_summary",
    "Get a summary of leads for an organization/visitor.",
    {
      organizationId: z.string().describe("Organization ID"),
      visitorId:      z.string().optional().describe("Visitor / lead ID"),
    },
    async (params) => {
      log_message("get_leads_summary", params);
      const { organizationId, visitorId } = params;
      const data = await authedHlsRequest({
        method: "GET",
        path:   "/api/mcp/v1/leads/leadSummary",
        query:  { organizationId, visitorId },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_leads",
    "Retrieve leads with rich filtering (pagination, stage, tags, dates, deal size, etc.).",
    {
      org_id:             z.string().describe("Organization ID"),
      page:               z.string().optional().default("1").describe("Page number"),
      page_size:          z.string().optional().default("50").describe("Results per page (max 50)"),
      lead_ids:           z.string().optional().describe("Comma-separated lead IDs"),
      list_ids:           z.string().optional().describe("Comma-separated list IDs"),
      assigned_to_ids:    z.string().optional().describe("Comma-separated user IDs or 'unassigned'"),
      assigned_by_ids:    z.string().optional().describe("Comma-separated user IDs"),
      captured_by_ids:    z.string().optional().describe("Comma-separated user IDs"),
      stage_ids:          z.string().optional().describe("Comma-separated stage IDs"),
      customer_group_ids: z.string().optional().describe("Comma-separated customer group IDs"),
      product_group_ids:  z.string().optional().describe("Comma-separated product group IDs"),
      tag_ids:            z.string().optional().describe("Comma-separated tag IDs"),
      lead_source_code:   z.string().optional().describe("Comma-separated source codes e.g. M_FO,W_EX"),
      potential:          z.string().optional().describe("Comma-separated values: High, Medium, Low"),
      score_min:          z.string().optional().describe("Minimum lead score"),
      score_max:          z.string().optional().describe("Maximum lead score"),
      deal_size_op:       z.string().optional().describe("Deal size operator: between, gt, lt"),
      deal_size_min:      z.string().optional().describe("Minimum deal size"),
      deal_size_max:      z.string().optional().describe("Maximum deal size"),
      created_from:       z.string().optional().describe("Created from ISO8601 e.g. 2025-01-01T00:00:00Z"),
      created_to:         z.string().optional().describe("Created to ISO8601"),
      modified_from:      z.string().optional().describe("Modified from ISO8601"),
      modified_to:        z.string().optional().describe("Modified to ISO8601"),
      followup_from:      z.string().optional().describe("Follow-up from ISO8601"),
      followup_to:        z.string().optional().describe("Follow-up to ISO8601"),
      dob_from:           z.string().optional().describe("Date of birth from YYYY-MM-DD"),
      dob_to:             z.string().optional().describe("Date of birth to YYYY-MM-DD"),
      special_date_from:  z.string().optional().describe("Special date from YYYY-MM-DD"),
      special_date_to:    z.string().optional().describe("Special date to YYYY-MM-DD"),
      sort_by:            z.string().optional().describe("Sort field e.g. modified_at"),
      sort_order:         z.string().optional().describe("asc or desc"),
    },
    async (params) => {
      log_message("get_leads", params);
      const data = await authedHlsRequest({ method: "GET", path: "/api/mcp/v1/leads/leads", query: params });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_unattended_leads",
    "Get leads that have not been attended to within specified criteria.",
    {
      organizationId:       z.string().describe("Organization ID"),
      userId:               z.string().optional().describe("User ID"),
      roleId:               z.string().optional().describe("Role ID"),
      assigned_user_ids:    z.string().optional().describe("Comma-separated assigned user IDs"),
      lead_captured_during: z.string().optional().describe("Time period filter"),
      lead_source_code:     z.string().optional().describe("Lead source codes"),
      lead_stage_ids:       z.string().optional().describe("Comma-separated stage IDs"),
      list_ids:             z.string().optional().describe("Comma-separated list IDs"),
      no_activity_days:     z.string().optional().describe("Days without activity threshold"),
      page_size:            z.string().optional().describe("Results per page"),
    },
    async (params) => {
      log_message("get_unattended_leads", params);
      const data = await authedHlsRequest({
        method: "GET",
        path:   "/index.php/api/mcp/v1/leads/unattendedLeads",
        query:  params,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_lead",
    "Create a new lead in HLS.",
    {
      organizationId: z.string().describe("Organization ID"),
      visitorId:      z.string().optional().describe("Visitor ID (if pre-existing)"),
      listId:         z.number().describe("List ID to add the lead into"),
      firstName:      z.string().optional().describe("First name"),
      lastName:       z.string().optional().describe("Last name"),
      email:          z.string().optional().describe("Email address"),
      phone:          z.string().optional().describe("Phone number"),
      notes:          z.string().optional().describe("Notes about the lead"),
      extraFields:    z.record(z.unknown()).optional().describe("Any additional fields as key-value pairs"),
    },
    async (params) => {
      log_message("create_lead", params);
      const { organizationId, visitorId, listId, firstName, lastName, email, phone, notes, extraFields } = params;
      const body = { listId, ...extraFields };
      if (firstName) body.firstName = firstName;
      if (lastName)  body.lastName  = lastName;
      if (email)     body.email     = email;
      if (phone)     body.phone     = phone;
      if (notes)     body.notes     = notes;
      const data = await authedHlsRequest({
        method: "POST",
        path:   "/api/mcp/v1/leads/leadCreate",
        query:  { organizationId, visitorId },
        body,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_lead_comment",
    "Add a comment to an existing lead.",
    {
      lead_id:        z.number().describe("Visitor / lead ID"),
      org_id:         z.number().describe("Organization ID"),
      comment:        z.string().describe("Comment text"),
      comment_userId: z.number().describe("User ID posting the comment"),
    },
    async (params) => {
      log_message("create_lead_comment", params);
      const { lead_id, org_id, comment, comment_userId } = params;
      const data = await authedHlsRequest({
        method: "POST",
        path:   "/api/mcp/v1/leads/leadCommentCreate",
        body: {
          lead_id:        String(lead_id),
          org_id,
          comment,
          comment_userId: String(comment_userId),
        },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_lead_profile",
    "Update a lead's profile information (name, email, phone, etc.).",
    {
      visitorId:      z.string().describe("Visitor / lead ID"),
      organizationId: z.string().describe("Organization ID"),
      firstName:      z.string().optional().describe("First name"),
      lastName:       z.string().optional().describe("Last name"),
      email:          z.string().optional().describe("Email address"),
      phone:          z.string().optional().describe("Phone number"),
      extraFields:    z.record(z.unknown()).optional().describe("Additional profile fields"),
    },
    async ({ visitorId, organizationId, firstName, lastName, email, phone, extraFields }) => {
      const body = { visitorId, organizationId, ...extraFields };
      if (firstName) body.firstName = firstName;
      if (lastName)  body.lastName  = lastName;
      if (email)     body.email     = email;
      if (phone)     body.phone     = phone;
      const data = await authedHlsRequest({ method: "PUT", path: "/api/mcp/v1/leads/profile", body });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_lead_qualifiers",
    "Update qualifiers (stage, potential, tags, product/customer groups) for a lead.",
    {
      visitorId:       z.string().describe("Visitor / lead ID"),
      organizationId:  z.string().describe("Organization ID"),
      stageId:         z.number().optional().describe("Lead stage ID"),
      potential:       z.string().optional().describe("High, Medium, or Low"),
      tagIds:          z.array(z.number()).optional().describe("Array of tag IDs"),
      productGroupIds: z.array(z.number()).optional().describe("Array of product group IDs"),
      customerGroupId: z.number().optional().describe("Customer group ID"),
    },
    async ({ visitorId, organizationId, ...rest }) => {
      const data = await authedHlsRequest({
        method: "PUT",
        path:   "/api/mcp/v1/leads/qualifiers",
        body:   { visitorId, organizationId, ...rest },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_lead_followup",
    "Update the follow-up date/time for a lead.",
    {
      visitorId:      z.string().describe("Visitor / lead ID"),
      organizationId: z.string().describe("Organization ID"),
      followupDate:   z.string().describe("Follow-up datetime ISO8601 or YYYY-MM-DD HH:mm:ss"),
      followupNote:   z.string().optional().describe("Note for the follow-up"),
    },
    async ({ visitorId, organizationId, followupDate, followupNote }) => {
      const data = await authedHlsRequest({
        method: "PUT",
        path:   "/api/mcp/v1/leads/followup",
        body:   { visitorId, organizationId, followupDate, followupNote },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_lead_info_plus",
    "Update extended lead information (Info Plus custom fields).",
    {
      visitorId:      z.string().describe("Visitor / lead ID"),
      organizationId: z.string().describe("Organization ID"),
      fields:         z.record(z.unknown()).describe("Key-value map of Info Plus fields to update"),
    },
    async ({ visitorId, organizationId, fields }) => {
      const data = await authedHlsRequest({
        method: "PUT",
        path:   "/api/mcp/v1/leads/infoPlus",
        body:   { visitorId, organizationId, ...fields },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // ORG & QUALIFIERS
  // ══════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_org",
    "Get organization details.",
    { organizationId: z.string().describe("Organization ID") },
    async ({ organizationId }) => {
      const data = await authedHlsRequest({
        method: "GET",
        path:   "/index.php/api/mcp/v1/org",
        query:  { organizationId },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_product_groups",
    "List all product groups for an organization.",
    { organizationId: z.string().describe("Organization ID") },
    async ({ organizationId }) => {
      const data = await authedHlsRequest({
        method: "GET",
        path:   "/api/mcp/v1/org/productGroups",
        query:  { organizationId },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_customer_groups",
    "List all customer groups for an organization.",
    { organizationId: z.string().describe("Organization ID") },
    async ({ organizationId }) => {
      const data = await authedHlsRequest({
        method: "GET",
        path:   "/api/mcp/v1/org/customerGroups",
        query:  { organizationId },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_tags",
    "List all tags for an organization.",
    { organizationId: z.string().describe("Organization ID") },
    async ({ organizationId }) => {
      const data = await authedHlsRequest({
        method: "GET",
        path:   "/api/mcp/v1/org/tags",
        query:  { organizationId },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_custom_fields",
    "List all custom fields defined for an organization.",
    { organizationId: z.string().describe("Organization ID") },
    async ({ organizationId }) => {
      const data = await authedHlsRequest({
        method: "GET",
        path:   "/api/mcp/v1/org/customFields",
        query:  { organizationId },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_lead_stages",
    "List all lead stages for an organization.",
    { organizationId: z.string().describe("Organization ID") },
    async ({ organizationId }) => {
      const data = await authedHlsRequest({
        method: "GET",
        path:   "/api/mcp/v1/org/leadStages",
        query:  { organizationId },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // BULK QUALIFIER UPDATES
  // ══════════════════════════════════════════════════════════════════════════

  server.tool(
    "bulk_update_lead_stage",
    "Bulk update lead stage for multiple leads.",
    {
      organizationId: z.string().describe("Organization ID"),
      visitorIds:     z.string().describe("Comma-separated visitor IDs"),
      stageId:        z.number().describe("Target stage ID"),
    },
    async ({ organizationId, visitorIds, stageId }) => {
      const data = await authedHlsRequest({
        method: "PUT",
        path:   "/api/mcp/v1/BulkQualifier/updateLeadStage",
        query:  { organizationId },
        body:   { visitorIds, stageId },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "bulk_update_potential",
    "Bulk update potential for multiple leads.",
    {
      organizationId: z.string().describe("Organization ID"),
      visitorIds:     z.string().describe("Comma-separated visitor IDs"),
      potential:      z.enum(["High", "Medium", "Low"]).describe("Potential value"),
    },
    async ({ organizationId, visitorIds, potential }) => {
      const data = await authedHlsRequest({
        method: "PUT",
        path:   "/api/mcp/v1/BulkQualifier/updatePotential",
        query:  { organizationId },
        body:   { visitorIds, potential },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "bulk_update_customer_group",
    "Bulk update customer group for multiple leads.",
    {
      organizationId: z.string().describe("Organization ID"),
      visitorIds:     z.string().describe("Comma-separated visitor IDs"),
      categoryId:     z.number().describe("Customer group / category ID"),
    },
    async ({ organizationId, visitorIds, categoryId }) => {
      const data = await authedHlsRequest({
        method: "PUT",
        path:   "/api/mcp/v1/BulkQualifier/updateCustomerGroup",
        query:  { organizationId },
        body:   { visitorIds, categoryId },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "bulk_update_product_groups",
    "Bulk update product groups for multiple leads.",
    {
      organizationId: z.string().describe("Organization ID"),
      visitorIds:     z.string().describe("Comma-separated visitor IDs"),
      services:       z.array(z.object({ id: z.string(), name: z.string() }))
                        .describe("Array of product group objects [{id, name}]"),
      updateMode:     z.enum(["append", "replace"]).default("append").describe("append or replace existing groups"),
    },
    async ({ organizationId, visitorIds, services, updateMode }) => {
      const data = await authedHlsRequest({
        method: "PUT",
        path:   "/api/mcp/v1/BulkQualifier/updateProductGroups",
        query:  { organizationId },
        body:   { visitorIds, services, updateMode },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "bulk_update_tags",
    "Bulk update tags for multiple leads.",
    {
      organizationId: z.string().describe("Organization ID"),
      userId:         z.string().describe("User ID performing the update"),
      visitorIds:     z.string().describe("Comma-separated visitor IDs"),
      tags:           z.array(z.object({ id: z.number(), tag: z.string() }))
                        .describe("Array of tag objects [{id, tag}]"),
      updateMode:     z.enum(["append", "replace"]).default("append").describe("append or replace existing tags"),
    },
    async ({ organizationId, userId, visitorIds, tags, updateMode }) => {
      const data = await authedHlsRequest({
        method: "PUT",
        path:   "/api/mcp/v1/BulkQualifier/updateTags",
        query:  { organizationId },
        body: {
          tags,
          updateMode,
          visitorIds,
          organizationId, // ← typo fixed: was orgnizationId
          userId,
        },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "bulk_assign_leads",
    "Bulk assign multiple leads to a user.",
    {
      organizationId: z.string().describe("Organization ID"),
      visitorIds:     z.string().describe("Comma-separated visitor IDs"),
      assignTo:       z.string().describe("User ID to assign leads to"),
      assignBy:       z.string().describe("User ID performing the assignment"),
      assignedAt:     z.string().optional().describe("Assignment timestamp YYYY-MM-DD HH:mm:ss (defaults to now)"),
      dontFollow:     z.string().optional().default("0").describe("0 = follow, 1 = don't follow"),
    },
    async ({ organizationId, visitorIds, assignTo, assignBy, assignedAt, dontFollow }) => {
      const data = await authedHlsRequest({
        method: "PUT",
        path:   "/api/mcp/v1/BulkQualifier/bulkAssign",
        query:  { organizationId },
        body: {
          visitorIds,
          organizationId,
          gAssignTo:    assignTo,
          assignBy,
          gAssigne:     assignTo,
          dontFollow:   dontFollow || "0",
          dontFollowRes: "",
          assignedAt:   assignedAt || new Date().toISOString().replace("T", " ").slice(0, 19),
        },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // TODOS
  // ══════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_todos",
    "Get todos/tasks for a lead.",
    {
      organizationId: z.string().describe("Organization ID"),
      visitorId:      z.string().describe("Visitor / lead ID"),
    },
    async ({ organizationId, visitorId }) => {
      const data = await authedHlsRequest({
        method: "GET",
        path:   "/index.php/api/mcp/v1/todo/todo/todo",
        query:  { organizationId, visitorId },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_todo",
    "Create a new todo/task for a lead.",
    {
      organizationId: z.string().describe("Organization ID"),
      visitorId:      z.string().describe("Visitor / lead ID"),
      assignedTo:     z.number().describe("User ID to assign the todo to"),
      createdBy:      z.number().describe("User ID creating the todo"),
      modifiedBy:     z.number().describe("User ID modifying the todo"),
      title:          z.string().optional().describe("Todo title"),
      dueDateTime:    z.string().describe("Due date-time YYYY-MM-DD HH:mm:ss"),
      critical:       z.number().optional().default(0).describe("1 = critical, 0 = normal"),
      donePercent:    z.number().optional().default(0).describe("Completion percentage 0–100"),
      extraFields:    z.record(z.unknown()).optional().describe("Additional fields"),
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
      const data = await authedHlsRequest({
        method: "POST",
        path:   "/index.php/api/mcp/v1/todo/todo/todo",
        body,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_todo",
    "Update an existing todo/task.",
    {
      id:             z.number().describe("Todo ID"),
      organizationId: z.string().describe("Organization ID"),
      assignedTo:     z.number().describe("User ID assigned to"),
      modifiedBy:     z.number().describe("User ID making the update"),
      dueDateTime:    z.string().optional().describe("New due date-time YYYY-MM-DD HH:mm:ss"),
      critical:       z.number().optional().describe("1 = critical, 0 = normal"),
      donePercent:    z.number().optional().describe("Completion percentage 0–100"),
      extraFields:    z.record(z.unknown()).optional().describe("Additional fields to update"),
    },
    async ({ id, organizationId, assignedTo, modifiedBy, dueDateTime, critical, donePercent, extraFields }) => {
      const body = { id, organizationId, assignedTo, assignedToPre: 0, modifiedBy, ...extraFields };
      if (dueDateTime !== undefined)  body.dueDateTime = dueDateTime;
      if (critical    !== undefined)  body.critical    = critical;
      if (donePercent !== undefined)  body.donePercent = donePercent;
      const data = await authedHlsRequest({
        method: "PUT",
        path:   "/index.php/api/mcp/v1/todo/todo/todo",
        query:  { id, organizationId, assignedTo },
        body,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // USERS
  // ══════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_users",
    "Get users in an organization.",
    {
      org_id:  z.string().describe("Organization ID"),
      user_id: z.string().optional().describe("Specific user ID to fetch"),
    },
    async ({ org_id, user_id }) => {
      const data = await authedHlsRequest({
        method: "GET",
        path:   "/api/mcp/v1/users/users",
        query:  { org_id, user_id },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_user",
    "Create a new user in the organization.",
    {
      org_id:      z.string().describe("Organization ID"),
      firstName:   z.string().describe("First name"),
      lastName:    z.string().optional().describe("Last name"),
      email:       z.string().describe("Email address"),
      phone:       z.string().optional().describe("Phone number"),
      roleId:      z.number().optional().describe("Role ID"),
      extraFields: z.record(z.unknown()).optional().describe("Additional user fields"),
    },
    async ({ org_id, firstName, lastName, email, phone, roleId, extraFields }) => {
      const data = await authedHlsRequest({
        method: "POST",
        path:   "/api/mcp/v1/users/users",
        query:  { org_id },
        body:   { firstName, lastName, email, phone, roleId, ...extraFields },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_user",
    "Update an existing user's information.",
    {
      org_id:      z.string().describe("Organization ID"),
      userId:      z.string().describe("User ID to update"),
      firstName:   z.string().optional().describe("First name"),
      lastName:    z.string().optional().describe("Last name"),
      email:       z.string().optional().describe("Email address"),
      phone:       z.string().optional().describe("Phone number"),
      extraFields: z.record(z.unknown()).optional().describe("Additional fields to update"),
    },
    async ({ org_id, userId, firstName, lastName, email, phone, extraFields }) => {
      const data = await authedHlsRequest({
        method: "PUT",
        path:   "/api/mcp/v1/users/users",
        body:   { org_id, userId, firstName, lastName, email, phone, ...extraFields },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // TEAM PERFORMANCE REPORTS
  // ══════════════════════════════════════════════════════════════════════════

  const reportSchema = {
    organizationId:  z.string().describe("Organization ID"),
    userIds:         z.array(z.string()).describe("Array of user ID strings"),
    currentStartDate:z.string().describe("Report start date YYYY-MM-DD HH:mm:ss"),
    currentEndDate:  z.string().describe("Report end date YYYY-MM-DD HH:mm:ss"),
  };

  server.tool(
    "get_sales_performance",
    "Get sales performance report for team members over a date range.",
    reportSchema,
    async ({ organizationId, userIds, currentStartDate, currentEndDate }) => {
      const data = await authedHlsRequest({
        method: "POST",
        path:   "/api/mcp/v1/teamreport/salesPerformance",
        query:  { organizationId },
        body:   { userIds, currentStartDate, currentEndDate },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_lead_management_activity",
    "Get lead management activity report for team members.",
    reportSchema,
    async ({ organizationId, userIds, currentStartDate, currentEndDate }) => {
      const data = await authedHlsRequest({
        method: "POST",
        path:   "/api/mcp/v1/teamreport/leadManagementActivity",
        query:  { organizationId },
        body:   { userIds, currentStartDate, currentEndDate },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_customer_communication",
    "Get customer communication report for team members.",
    reportSchema,
    async ({ organizationId, userIds, currentStartDate, currentEndDate }) => {
      const data = await authedHlsRequest({
        method: "POST",
        path:   "/api/mcp/v1/teamreport/customerCommunication",
        query:  { organizationId },
        body:   { userIds, currentStartDate, currentEndDate },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_activity_metrics",
    "Get activity metrics report for team members.",
    reportSchema,
    async ({ organizationId, userIds, currentStartDate, currentEndDate }) => {
      const data = await authedHlsRequest({
        method: "POST",
        path:   "/api/mcp/v1/teamreport/activityMetrics",
        query:  { organizationId },
        body:   { userIds, currentStartDate, currentEndDate },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

// ─── HTTP/HTTPS + SSE Transport ────────────────────────────────────────────
// One SSE session per connected user. Sessions are tracked by session ID.

const sessions = new Map(); // sessionId → SSEServerTransport

function getRequestBaseUrl(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = forwardedProto ? forwardedProto.split(",")[0].trim() :
                (req.connection && req.connection.encrypted ? "https" : "http");
  const host = req.headers["host"] || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function getResourceMetadataUrl(req) {
  return `${getRequestBaseUrl(req)}/.well-known/oauth-protected-resource`;
}

async function requestHandler(req, res) {
  const protocol = USE_HTTPS ? "https" : "http";
  const url = new URL(req.url, `${protocol}://localhost:${PORT}`);

  // ── CORS ──────────────────────────────────────────────────────────────────
  const allowedOrigins = [
    "https://chatgpt.com",
    "https://chat.openai.com",
    "https://claude.ai",
  ];
  const origin = req.headers["origin"];
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Resource metadata ── GET /.well-known/oauth-protected-resource ─────────
  if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      resource: `${getRequestBaseUrl(req)}/mcp`,
      authorization_servers: [`${getRequestBaseUrl(req)}`],  // ← Must be THIS Node.js server, not PHP backend
      scopes_supported: ["leads", "todos", "org", "reports"],
    }));
    return;
  }

  // ── OAuth discovery — GET /.well-known/oauth-authorization-server or openid config ─
  if (req.method === "GET" && (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration"
  )) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      issuer: `${getRequestBaseUrl(req)}`,
      authorization_endpoint: `${BASE_URL}/api/mcp/v1/oauth/authorize`,
      token_endpoint: `${BASE_URL}/api/mcp/v1/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      scopes_supported: ["leads", "todos", "org", "reports"],
    }));
    return;
  }

  // ── Redirect root authorize requests to the HLS backend auth server ─────────
  if (req.method === "GET" && url.pathname === "/authorize") {
    const target = new URL(`${BASE_URL}/api/mcp/v1/oauth/authorize`);
    url.searchParams.forEach((value, name) => target.searchParams.append(name, value));
    res.writeHead(302, { Location: target.toString() });
    res.end();
    return;
  }

  // ── Health check / manifest ── GET /mcp ───────────────────────────────────
  if (req.method === "GET" && url.pathname === "/mcp") {
    res.writeHead(200, { "Content-Type": "application/json" });
    
    const authConfig = OAUTH_ENABLED ? {
      type: "oauth2",
      oauth2: {
        authorizationUrl: `${BASE_URL}/api/mcp/v1/oauth/authorize`,
        tokenUrl: `${BASE_URL}/api/mcp/v1/oauth/token`,
        scope: "leads todos org reports",
      }
    } : { type: "none" };
    
    res.end(JSON.stringify({
      name:        "HLS CRM",
      version:     "1.0.0",
      description: "MCP server for HLS CRM — manage leads, todos, users and reports",
      auth:        authConfig,
    }));
    return;
  }

  // ── SSE endpoint ── GET /mcp/sse ──────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/mcp/sse") {
    console.error(`[SSE] New session from ${origin || "unknown"}`);

    const token = extractToken(req);
    let authContext = null;

    if (token) {
      authContext = await validateBearerToken(token);
      if (!authContext) {
        const resourceMetadata = getResourceMetadataUrl(req);
        console.error(`[SSE] Invalid Bearer token`);
        res.setHeader("WWW-Authenticate", `Bearer realm="mcp", resource_metadata="${resourceMetadata}"`);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid token" }));
        return;
      }
      console.error(`[SSE] Authenticated session for user: ${authContext.userId}`);
    } else if (!OAUTH_ENABLED && AUTH_TOKEN && USER_ID) {
      authContext = { userId: USER_ID, sessionId: AUTH_TOKEN };
      console.error(`[SSE] Fallback session using env credentials userId=${USER_ID}`);
    } else {
      const resourceMetadata = getResourceMetadataUrl(req);
      console.error(`[SSE] Missing Bearer token`);
      res.setHeader("WWW-Authenticate", `Bearer realm="mcp", resource_metadata="${resourceMetadata}"`);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing Bearer token" }));
      return;
    }

    const mcpServer = createMcpServer(authContext);
    const transport = new SSEServerTransport("/mcp/messages", res);

    sessions.set(transport.sessionId, { transport, authContext });
    console.error(`[SSE] Session started: ${transport.sessionId}`);

    res.on("close", () => {
      sessions.delete(transport.sessionId);
      console.error(`[SSE] Session closed: ${transport.sessionId}`);
    });

    await mcpServer.connect(transport);
    return;
  }

  // ── Message endpoint ── POST /mcp/messages ────────────────────────────────
  if (req.method === "POST" && url.pathname === "/mcp/messages") {
    const sessionId = url.searchParams.get("sessionId") || req.headers["mcp-session-id"];
    const session = sessions.get(sessionId);

    if (!session) {
      console.error(`[MCP] Message POST failed; sessionId=${sessionId || "none"} not found`);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    try {
      checkRateLimit(sessionId);
    } catch (err) {
      console.error(`[MCP] Rate limit exceeded for sessionId=${sessionId}`);
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rate_limit_exceeded" }));
      return;
    }

    await session.transport.handlePostMessage(req, res);
    return;
  }

  // ── 404 ───────────────────────────────────────────────────────────────────
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

const useHttpsServer = USE_HTTPS || HTTPS_PFX_PATH || (HTTPS_KEY_PATH && HTTPS_CERT_PATH);
const serverOptions = useHttpsServer ? {} : null;
if (useHttpsServer) {
  if (HTTPS_PFX_PATH) {
    serverOptions.pfx = fs.readFileSync(HTTPS_PFX_PATH);
  } else {
    serverOptions.key = fs.readFileSync(HTTPS_KEY_PATH);
    serverOptions.cert = fs.readFileSync(HTTPS_CERT_PATH);
  }
  if (HTTPS_PASSPHRASE) {
    serverOptions.passphrase = HTTPS_PASSPHRASE;
  }
}

const server = useHttpsServer
  ? https.createServer(serverOptions, requestHandler)
  : http.createServer(requestHandler);

const actualProtocol = useHttpsServer ? "https" : "http";

server.listen(PORT, () => {
  console.error(`HLS MCP Server running on port ${PORT}`);
  console.error(`SSE:      ${actualProtocol}://localhost:${PORT}/mcp/sse`);
  console.error(`Messages: ${actualProtocol}://localhost:${PORT}/mcp/messages`);
  console.error(`Health:   ${actualProtocol}://localhost:${PORT}/mcp`);
  console.error(`Auth:     Xemail=${USER_ID ? "set" : "MISSING"} Auth=${AUTH_TOKEN ? "set" : "MISSING"}`);
});

