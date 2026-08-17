import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { contactInboxThreadId, resolveGraphThreadId } from "@/graph/checkpointer";
import {
  type IngestBatchMessageItem,
  ingestMessagesBatchIntoThread,
} from "@/graph/ingest";
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

// Fetch message pages for a conversation by paginating backwards with `before`.
// Deduplicates IDs immediately and stops as soon as a duplicate page is returned or messages end.
async function fetchAllMessages(
  client: ChatwootClient,
  conversationId: number,
): Promise<unknown[]> {
  const allMessages: unknown[] = [];
  const seenIds = new Set<number>();
  let before: number | undefined;
  const MAX_PAGES = 50; // safety cap

  for (let i = 0; i < MAX_PAGES; i++) {
    const raw = await client.getMessages(
      conversationId,
      before != null ? { before } : undefined,
    );
    const page: unknown[] = Array.isArray(raw)
      ? raw
      : raw &&
          typeof raw === "object" &&
          Array.isArray((raw as Record<string, unknown>).payload)
        ? (raw as { payload: unknown[] }).payload
        : [];

    if (page.length === 0) break;

    let newMessagesInPage = 0;
    let minId = Infinity;

    for (const item of page) {
      if (item && typeof item === "object") {
        const id = Number((item as { id?: unknown }).id);
        if (Number.isInteger(id) && id > 0) {
          if (!seenIds.has(id)) {
            seenIds.add(id);
            allMessages.push(item);
            newMessagesInPage++;
          }
          if (id < minId) {
            minId = id;
          }
        }
      }
    }

    // Stop if no new messages were added (server does not support `before` and repeated the same page),
    // or if minId did not strictly decrease, or if the page has fewer than 20 items (last page reached).
    if (
      newMessagesInPage === 0 ||
      minId === Infinity ||
      minId === before ||
      page.length < 20
    ) {
      break;
    }
    before = minId;
  }

  return allMessages;
}

// Build batch message items from raw Chatwoot messages for atomic ingestion
function prepareBatchItems(
  rawList: unknown[],
  parsedRows: ReturnType<typeof parseChatwootMessages>,
): IngestBatchMessageItem[] {
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

  // Sort messages by id ascending
  const sorted = [...parsedRows].sort((a, b) => a.id - b.id);
  const items: IngestBatchMessageItem[] = [];

  for (const msg of sorted) {
    if (
      msg.private ||
      msg.messageType === "activity" ||
      msg.messageType === "other"
    ) {
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

      if (renderedText.trim()) {
        items.push({
          messageId: msg.id,
          role: "customer",
          text: renderedText,
        });
      }
    } else if (
      msg.messageType === "outgoing" ||
      msg.messageType === "template"
    ) {
      const text = msg.content.trim();
      if (text) {
        items.push({
          messageId: msg.id,
          role: "human_agent",
          text,
          agentName: senderName || "Atendente",
        });
      }
    }
  }

  return items;
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
        break;
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
      const batchItems = prepareBatchItems(rawList, parsedRows);

      const { ingested, skipped } = await ingestMessagesBatchIntoThread({
        tenantId,
        instanceId,
        conversationId: conv.id,
        contactInboxId: contactInboxId ?? conv.id,
        graphThreadId,
        messages: batchItems,
        base,
      });

      result.messagesIngested += ingested;
      result.messagesSkipped += skipped;
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

// Progress state tracked for background migration jobs
export interface MigrationTaskState {
  instanceId: string;
  running: boolean;
  phase: "idle" | "discovering" | "processing" | "done" | "error";
  totalConversations: number;
  currentIndex: number;
  currentConversationId: number | null;
  messagesIngested: number;
  messagesSkipped: number;
  errorsCount: number;
  logs: string[];
  result: MigrateHistoryResult | null;
  error?: string | null;
  startedAt?: string;
  finishedAt?: string;
}

const activeMigrationTasks = new Map<string, MigrationTaskState>();

function taskKey(tenantId: bigint, instanceId: bigint): string {
  return `${tenantId}:${instanceId}`;
}

export function getMigrationTaskStatus(
  tenantId: bigint,
  instanceId: bigint,
): MigrationTaskState {
  const key = taskKey(tenantId, instanceId);
  const existing = activeMigrationTasks.get(key);
  if (existing) return existing;

  return {
    instanceId: String(instanceId),
    running: false,
    phase: "idle",
    totalConversations: 0,
    currentIndex: 0,
    currentConversationId: null,
    messagesIngested: 0,
    messagesSkipped: 0,
    errorsCount: 0,
    logs: [],
    result: null,
  };
}

export function startChatwootMigrationTask(
  tenantId: bigint,
  instanceId: bigint,
  options: MigrateHistoryOptions = {},
): MigrationTaskState {
  const key = taskKey(tenantId, instanceId);
  const current = activeMigrationTasks.get(key);
  if (current?.running) {
    return current;
  }

  const state: MigrationTaskState = {
    instanceId: String(instanceId),
    running: true,
    phase: "discovering",
    totalConversations: 0,
    currentIndex: 0,
    currentConversationId: null,
    messagesIngested: 0,
    messagesSkipped: 0,
    errorsCount: 0,
    logs: ["Conectando ao Chatwoot e buscando conversas..."],
    result: null,
    startedAt: new Date().toISOString(),
  };
  activeMigrationTasks.set(key, state);

  // Run in background asynchronously with high performance batching
  (async () => {
    const base = options.base ?? basePrisma;
    const loader = options.loadClient ?? loadChatwootClient;
    let client: ChatwootClient;
    try {
      client = await loader(tenantId, instanceId);
    } catch (loadErr) {
      const errMsg =
        loadErr instanceof Error ? loadErr.message : String(loadErr);
      logger.error(
        "Failed to load Chatwoot client for instance %s: %s",
        String(instanceId),
        errMsg,
      );
      state.running = false;
      state.phase = "error";
      state.error = errMsg;
      state.logs.push(`❌ Erro ao conectar ao Chatwoot: ${errMsg}`);
      state.finishedAt = new Date().toISOString();
      return;
    }

    const statusFilter = options.status ?? "all";
    const maxConvs = options.maxConversations ?? 0;

    const result: MigrateHistoryResult = {
      instanceId: String(instanceId),
      conversationsProcessed: 0,
      messagesIngested: 0,
      messagesSkipped: 0,
      errors: [],
    };

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

    state.totalConversations = conversationsToProcess.length;
    state.phase = "processing";
    state.logs.push(`📋 ${conversationsToProcess.length} conversas encontradas`);

    // 2. Process each conversation in high-speed batches
    for (const conv of conversationsToProcess) {
      result.conversationsProcessed++;
      state.currentIndex = result.conversationsProcessed;
      state.currentConversationId = conv.id;
      state.logs.push(
        `💬 Conversa #${conv.id} (${result.conversationsProcessed}/${conversationsToProcess.length})...`,
      );

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
        const batchItems = prepareBatchItems(rawList, parsedRows);

        const { ingested, skipped } = await ingestMessagesBatchIntoThread({
          tenantId,
          instanceId,
          conversationId: conv.id,
          contactInboxId: contactInboxId ?? conv.id,
          graphThreadId,
          messages: batchItems,
          base,
        });

        result.messagesIngested += ingested;
        result.messagesSkipped += skipped;

        state.messagesIngested = result.messagesIngested;
        state.messagesSkipped = result.messagesSkipped;
        state.logs.push(
          `   ✓ #${conv.id}: ${ingested} ingeridas, ${skipped} já existiam`,
        );
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
        state.errorsCount = result.errors.length;
        state.logs.push(`   ⚠ #${conv.id}: ${errMsg}`);
      }

      // Trim logs if they grow too large
      if (state.logs.length > 200) {
        state.logs = state.logs.slice(-150);
      }
    }

    state.running = false;
    state.phase = "done";
    state.result = result;
    state.finishedAt = new Date().toISOString();
    state.logs.push("✅ Migração concluída!");
  })().catch((err) => {
    logger.error("Unhandled error in migration task: %s", err instanceof Error ? err.stack : String(err));
    state.running = false;
    state.phase = "error";
    state.error = err instanceof Error ? err.message : String(err);
    state.logs.push(`❌ Erro inesperado: ${state.error}`);
    state.finishedAt = new Date().toISOString();
  });

  return state;
}
