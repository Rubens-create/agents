import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { contactInboxThreadId, resolveGraphThreadId } from "@/graph/checkpointer";
import { ingestMessageIntoThread } from "@/graph/ingest";
import { type ChatwootClient } from "./client";
import { loadChatwootClient } from "./instance";
import { parseChatwootMessages } from "./messages";
import { renderInboundMessage } from "./render";

export interface MigrateHistoryOptions {
  // Max conversations to process (0 or undefined = unlimited / all available)
  maxConversations?: number;
  // Status filter for conversations (default: "all")
  status?: "all" | "open" | "pending" | "resolved" | "snoozed";
  // Filter by specific inbox id
  inboxId?: number;
  base?: PrismaClient;
  // Custom client loader for testing
  loadClient?: (
    tenantId: bigint,
    instanceId: bigint,
  ) => Promise<ChatwootClient>;
}

export interface MigrateHistoryResult {
  instanceId: string;
  conversationsProcessed: number;
  messagesIngested: number;
  messagesSkipped: number;
  errors: Array<{ conversationId: number; error: string }>;
}

interface RawConversationItem {
  id?: unknown;
  inbox_id?: unknown;
  contact_inbox?: { id?: unknown; contact_id?: unknown; inbox_id?: unknown } | null;
  status?: unknown;
  meta?: {
    sender?: { id?: unknown; name?: unknown } | null;
  } | null;
}

interface ParsedConversation {
  id: number;
  inboxId: number;
  // contactInboxId may be absent from the conversations list endpoint — resolved later via
  // getConversation or falling back to per-conversation thread keying.
  contactInboxId: number | null;
}

function parseConversationsResponse(raw: unknown): ParsedConversation[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.payload)) {
      list = o.payload;
    } else if (o.data && typeof o.data === "object") {
      const dataObj = o.data as Record<string, unknown>;
      if (Array.isArray(dataObj.payload)) {
        list = dataObj.payload;
      }
    }
  }

  const out: ParsedConversation[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const c = item as RawConversationItem;
    const id = Number(c.id);
    const inboxId = Number(c.inbox_id);
    const rawCiId = Number(c.contact_inbox?.id);
    // contact_inbox is NOT included in the Chatwoot conversations list response — only in the
    // individual conversation detail. Accept conversations without it and resolve later.
    const contactInboxId =
      Number.isInteger(rawCiId) && rawCiId > 0 ? rawCiId : null;

    if (Number.isInteger(id) && id > 0) {
      out.push({
        id,
        inboxId: Number.isInteger(inboxId) ? inboxId : 0,
        contactInboxId,
      });
    }
  }
  return out;
}

// Extract contact_inbox.id from a single-conversation detail response.
function extractContactInboxId(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const ci = obj.contact_inbox as { id?: unknown } | null | undefined;
  const id = Number(ci?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Fetch ALL message pages for a conversation by paginating backwards with `before`.
async function fetchAllMessages(
  client: ChatwootClient,
  conversationId: number,
): Promise<unknown[]> {
  const allMessages: unknown[] = [];
  let before: number | undefined;
  const MAX_PAGES = 200; // safety cap

  for (let i = 0; i < MAX_PAGES; i++) {
    const raw = await client.getMessages(conversationId, before != null ? { before } : undefined);
    const page: unknown[] = Array.isArray(raw)
      ? raw
      : raw &&
          typeof raw === "object" &&
          Array.isArray((raw as Record<string, unknown>).payload)
        ? (raw as { payload: unknown[] }).payload
        : [];

    if (page.length === 0) break;

    allMessages.push(...page);

    // Find the smallest message id in this page to use as the `before` cursor
    let minId = Infinity;
    for (const item of page) {
      if (item && typeof item === "object") {
        const id = Number((item as { id?: unknown }).id);
        if (Number.isInteger(id) && id < minId) {
          minId = id;
        }
      }
    }
    if (minId === Infinity || page.length < 20) break; // last page
    before = minId;
  }

  return allMessages;
}

export async function migrateChatwootInstanceHistory(
  tenantId: bigint,
  instanceId: bigint,
  options: MigrateHistoryOptions = {},
): Promise<MigrateHistoryResult> {
  const base = options.base ?? basePrisma;
  const loader = options.loadClient ?? loadChatwootClient;
  const client = await loader(tenantId, instanceId);

  const statusFilter = options.status ?? "all";
  const maxConvs = options.maxConversations ?? 0;

  const result: MigrateHistoryResult = {
    instanceId: String(instanceId),
    conversationsProcessed: 0,
    messagesIngested: 0,
    messagesSkipped: 0,
    errors: [],
  };

  logger.info(
    "Starting Chatwoot history migration (tenant=%s, instance=%s, maxConversations=%d, status=%s)",
    String(tenantId),
    String(instanceId),
    maxConvs,
    statusFilter,
  );

  let page = 1;
  const conversationsToProcess: ParsedConversation[] = [];

  // 1. Fetch conversations with pagination
  while (true) {
    try {
      const rawRes = await client.listConversations({
        page,
        status: statusFilter === "all" ? undefined : statusFilter,
        inboxId: options.inboxId,
      });

      const pageConvs = parseConversationsResponse(rawRes);
      if (pageConvs.length === 0) {
        break; // No more conversations
      }

      for (const conv of pageConvs) {
        conversationsToProcess.push(conv);
        if (maxConvs > 0 && conversationsToProcess.length >= maxConvs) {
          break;
        }
      }

      if (maxConvs > 0 && conversationsToProcess.length >= maxConvs) {
        break;
      }

      page++;
      // Safety limit to avoid infinite pagination loops
      if (page > 500) break;
    } catch (err) {
      logger.error(
        "Failed fetching conversations page %d on Chatwoot instance %s: %s",
        page,
        String(instanceId),
        err instanceof Error ? err.message : String(err),
      );
      break;
    }
  }

  logger.info(
    "Discovered %d conversations for history migration on instance %s",
    conversationsToProcess.length,
    String(instanceId),
  );

  // 2. Process each conversation
  for (const conv of conversationsToProcess) {
    result.conversationsProcessed++;

    // Resolve contactInboxId: if the list response didn't include it, fetch the
    // individual conversation detail (which DOES include contact_inbox).
    let contactInboxId = conv.contactInboxId;
    if (contactInboxId == null) {
      try {
        const detail = await client.getConversation(conv.id);
        contactInboxId = extractContactInboxId(detail);
      } catch {
        // Non-fatal: fall back to per-conversation thread keying
        logger.debug(
          "Could not fetch conversation %d detail for contact_inbox; falling back to per-conversation thread",
          conv.id,
        );
      }
    }

    const graphThreadId = resolveGraphThreadId(
      tenantId,
      instanceId,
      conv.id,
      contactInboxId,
    );

    try {
      // Fetch ALL message pages (not just the most recent ~20)
      const rawList = await fetchAllMessages(client, conv.id);
      const parsedRows = parseChatwootMessages(rawList);

      const rawMap = new Map<number, Record<string, unknown>>();
      for (const item of rawList) {
        if (item && typeof item === "object") {
          const o = item as { id?: unknown };
          const id = Number(o.id);
          if (Number.isInteger(id)) {
            rawMap.set(id, item as Record<string, unknown>);
          }
        }
      }

      // Build quote resolver for in-reply-to rendering
      const idToText = new Map<number, string>();
      for (const m of parsedRows) {
        const text = m.transcribedText || m.content;
        if (text) idToText.set(m.id, text);
      }
      const resolveQuoted = (quotedId: number) => idToText.get(quotedId) ?? null;

      // Sort messages by id ascending so the watermark advances monotonically
      parsedRows.sort((a, b) => a.id - b.id);

      for (const msg of parsedRows) {
        // Skip activity or private internal notes
        if (msg.private || msg.messageType === "activity" || msg.messageType === "other") {
          continue;
        }

        const rawItem = rawMap.get(msg.id);
        const senderObj = rawItem?.sender as
          | { name?: unknown; type?: unknown }
          | undefined;
        const senderName =
          typeof senderObj?.name === "string" && senderObj.name.trim()
            ? senderObj.name.trim()
            : null;

        if (msg.messageType === "incoming") {
          const renderedText = renderInboundMessage(
            {
              text: msg.content,
              transcribedText: msg.transcribedText,
              imageDescription: msg.imageDescription,
              extractedText: msg.extractedText,
              attachmentTypes: msg.attachmentTypes,
              attachmentName: msg.attachmentName,
              location: msg.location,
              inReplyTo: msg.inReplyTo,
              isReaction: msg.isReaction,
            },
            { resolveQuoted },
          );

          if (!renderedText.trim()) continue;

          const ingestStatus = await ingestMessageIntoThread({
            tenantId,
            instanceId,
            conversationId: conv.id,
            contactInboxId: contactInboxId ?? conv.id,
            graphThreadId,
            messageId: msg.id,
            role: "customer",
            text: renderedText,
            base,
          });

          if (ingestStatus === "ingested") {
            result.messagesIngested++;
          } else {
            result.messagesSkipped++;
          }
        } else if (
          msg.messageType === "outgoing" ||
          msg.messageType === "template"
        ) {
          const text = msg.content.trim();
          if (!text) continue;

          const ingestStatus = await ingestMessageIntoThread({
            tenantId,
            instanceId,
            conversationId: conv.id,
            contactInboxId: contactInboxId ?? conv.id,
            graphThreadId,
            messageId: msg.id,
            role: "human_agent",
            text,
            agentName: senderName || "Atendente",
            base,
          });

          if (ingestStatus === "ingested") {
            result.messagesIngested++;
          } else {
            result.messagesSkipped++;
          }
        }
      }
    } catch (convErr) {
      const errMsg =
        convErr instanceof Error ? convErr.message : String(convErr);
      logger.warn(
        "Error migrating conversation %d on instance %s: %s",
        conv.id,
        String(instanceId),
        errMsg,
      );
      result.errors.push({ conversationId: conv.id, error: errMsg });
    }
  }

  logger.info(
    "Finished Chatwoot history migration for instance %s: %d convs processed, %d messages ingested, %d skipped, %d errors",
    String(instanceId),
    result.conversationsProcessed,
    result.messagesIngested,
    result.messagesSkipped,
    result.errors.length,
  );

  return result;
}

// Progress event types for streaming migration
export type MigrationProgressEvent =
  | { type: "discovery"; totalConversations: number }
  | { type: "conversation_start"; conversationId: number; index: number; total: number }
  | { type: "conversation_done"; conversationId: number; ingested: number; skipped: number }
  | { type: "conversation_error"; conversationId: number; error: string }
  | { type: "complete"; result: MigrateHistoryResult };

// Streaming version of migrateChatwootInstanceHistory that yields progress events as each
// conversation is processed, so the client can show live progress instead of waiting for the
// entire operation to finish.
export async function* migrateChatwootInstanceHistoryStream(
  tenantId: bigint,
  instanceId: bigint,
  options: MigrateHistoryOptions = {},
): AsyncGenerator<MigrationProgressEvent> {
  const base = options.base ?? basePrisma;
  const loader = options.loadClient ?? loadChatwootClient;
  const client = await loader(tenantId, instanceId);

  const statusFilter = options.status ?? "all";
  const maxConvs = options.maxConversations ?? 0;

  const result: MigrateHistoryResult = {
    instanceId: String(instanceId),
    conversationsProcessed: 0,
    messagesIngested: 0,
    messagesSkipped: 0,
    errors: [],
  };

  logger.info(
    "Starting Chatwoot history migration [stream] (tenant=%s, instance=%s, maxConversations=%d, status=%s)",
    String(tenantId),
    String(instanceId),
    maxConvs,
    statusFilter,
  );

  let page = 1;
  const conversationsToProcess: ParsedConversation[] = [];

  // 1. Fetch conversations with pagination
  while (true) {
    try {
      const rawRes = await client.listConversations({
        page,
        status: statusFilter === "all" ? undefined : statusFilter,
        inboxId: options.inboxId,
      });

      const pageConvs = parseConversationsResponse(rawRes);
      if (pageConvs.length === 0) break;

      for (const conv of pageConvs) {
        conversationsToProcess.push(conv);
        if (maxConvs > 0 && conversationsToProcess.length >= maxConvs) break;
      }

      if (maxConvs > 0 && conversationsToProcess.length >= maxConvs) break;

      page++;
      if (page > 500) break;
    } catch (err) {
      logger.error(
        "Failed fetching conversations page %d on Chatwoot instance %s: %s",
        page,
        String(instanceId),
        err instanceof Error ? err.message : String(err),
      );
      break;
    }
  }

  logger.info(
    "Discovered %d conversations for history migration [stream] on instance %s",
    conversationsToProcess.length,
    String(instanceId),
  );

  yield { type: "discovery", totalConversations: conversationsToProcess.length };

  // 2. Process each conversation
  for (const conv of conversationsToProcess) {
    result.conversationsProcessed++;
    let convIngested = 0;
    let convSkipped = 0;

    yield {
      type: "conversation_start",
      conversationId: conv.id,
      index: result.conversationsProcessed - 1,
      total: conversationsToProcess.length,
    };

    // Resolve contactInboxId
    let contactInboxId = conv.contactInboxId;
    if (contactInboxId == null) {
      try {
        const detail = await client.getConversation(conv.id);
        contactInboxId = extractContactInboxId(detail);
      } catch {
        logger.debug(
          "Could not fetch conversation %d detail for contact_inbox; falling back to per-conversation thread",
          conv.id,
        );
      }
    }

    const graphThreadId = resolveGraphThreadId(
      tenantId,
      instanceId,
      conv.id,
      contactInboxId,
    );

    try {
      const rawList = await fetchAllMessages(client, conv.id);
      const parsedRows = parseChatwootMessages(rawList);

      const rawMap = new Map<number, Record<string, unknown>>();
      for (const item of rawList) {
        if (item && typeof item === "object") {
          const o = item as { id?: unknown };
          const id = Number(o.id);
          if (Number.isInteger(id)) {
            rawMap.set(id, item as Record<string, unknown>);
          }
        }
      }

      const idToText = new Map<number, string>();
      for (const m of parsedRows) {
        const text = m.transcribedText || m.content;
        if (text) idToText.set(m.id, text);
      }
      const resolveQuoted = (quotedId: number) => idToText.get(quotedId) ?? null;

      parsedRows.sort((a, b) => a.id - b.id);

      for (const msg of parsedRows) {
        if (msg.private || msg.messageType === "activity" || msg.messageType === "other") {
          continue;
        }

        const rawItem = rawMap.get(msg.id);
        const senderObj = rawItem?.sender as
          | { name?: unknown; type?: unknown }
          | undefined;
        const senderName =
          typeof senderObj?.name === "string" && senderObj.name.trim()
            ? senderObj.name.trim()
            : null;

        if (msg.messageType === "incoming") {
          const renderedText = renderInboundMessage(
            {
              text: msg.content,
              transcribedText: msg.transcribedText,
              imageDescription: msg.imageDescription,
              extractedText: msg.extractedText,
              attachmentTypes: msg.attachmentTypes,
              attachmentName: msg.attachmentName,
              location: msg.location,
              inReplyTo: msg.inReplyTo,
              isReaction: msg.isReaction,
            },
            { resolveQuoted },
          );

          if (!renderedText.trim()) continue;

          const ingestStatus = await ingestMessageIntoThread({
            tenantId,
            instanceId,
            conversationId: conv.id,
            contactInboxId: contactInboxId ?? conv.id,
            graphThreadId,
            messageId: msg.id,
            role: "customer",
            text: renderedText,
            base,
          });

          if (ingestStatus === "ingested") {
            result.messagesIngested++;
            convIngested++;
          } else {
            result.messagesSkipped++;
            convSkipped++;
          }
        } else if (
          msg.messageType === "outgoing" ||
          msg.messageType === "template"
        ) {
          const text = msg.content.trim();
          if (!text) continue;

          const ingestStatus = await ingestMessageIntoThread({
            tenantId,
            instanceId,
            conversationId: conv.id,
            contactInboxId: contactInboxId ?? conv.id,
            graphThreadId,
            messageId: msg.id,
            role: "human_agent",
            text,
            agentName: senderName || "Atendente",
            base,
          });

          if (ingestStatus === "ingested") {
            result.messagesIngested++;
            convIngested++;
          } else {
            result.messagesSkipped++;
            convSkipped++;
          }
        }
      }

      yield {
        type: "conversation_done",
        conversationId: conv.id,
        ingested: convIngested,
        skipped: convSkipped,
      };
    } catch (convErr) {
      const errMsg =
        convErr instanceof Error ? convErr.message : String(convErr);
      logger.warn(
        "Error migrating conversation %d on instance %s: %s",
        conv.id,
        String(instanceId),
        errMsg,
      );
      result.errors.push({ conversationId: conv.id, error: errMsg });
      yield { type: "conversation_error", conversationId: conv.id, error: errMsg };
    }
  }

  logger.info(
    "Finished Chatwoot history migration [stream] for instance %s: %d convs processed, %d messages ingested, %d skipped, %d errors",
    String(instanceId),
    result.conversationsProcessed,
    result.messagesIngested,
    result.messagesSkipped,
    result.errors.length,
  );

  yield { type: "complete", result };
}
