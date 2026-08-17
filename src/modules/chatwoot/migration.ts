import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { contactInboxThreadId } from "@/graph/checkpointer";
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
  contactInboxId: number;
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
    const contactInboxId = Number(c.contact_inbox?.id);

    if (
      Number.isInteger(id) &&
      id > 0 &&
      Number.isInteger(contactInboxId) &&
      contactInboxId > 0
    ) {
      out.push({
        id,
        inboxId: Number.isInteger(inboxId) ? inboxId : 0,
        contactInboxId,
      });
    }
  }
  return out;
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
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      conv.contactInboxId,
    );

    try {
      const rawMessages = await client.getMessages(conv.id);
      const parsedRows = parseChatwootMessages(rawMessages);

      // Raw array to inspect sender metadata if present
      const rawList: unknown[] = Array.isArray(rawMessages)
        ? rawMessages
        : rawMessages &&
            typeof rawMessages === "object" &&
            Array.isArray((rawMessages as Record<string, unknown>).payload)
          ? (rawMessages as { payload: unknown[] }).payload
          : [];

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
            contactInboxId: conv.contactInboxId,
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
            contactInboxId: conv.contactInboxId,
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
