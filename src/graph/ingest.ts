import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { getCheckpointer } from "./checkpointer";

// Continuous ingestion: fold a conversation message into the agent's graph memory thread WITHOUT
// running a model, so the agent has full context even for messages no turn handled — a customer
// message it stayed silent on (out of hours, a human handling, test/disabled aside), or a HUMAN
// agent's reply sent while it was silent. The seam is graph.updateState, which appends to the
// thread's MessagesAnnotation channel via the same reducer the real turn uses.
//
// At-most-once: the delivery ledger dedups re-deliveries, message_created gating ignores edits, and a
// monotonic per-thread watermark (AgentThread.lastSyncedMessageId, CAS under a per-thread advisory
// lock) is defense-in-depth against a re-delivery that slips a new delivery UUID. The lock also
// serializes concurrent ingestions on one thread so two appends can't clobber each other's checkpoint.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Folded into the first human turn of a NEW conversation when the contact-inbox thread already carries
// memory from a prior one. The agent node strips SystemMessages from history (graph.ts), so a
// system-role divider would be invisible — it rides inside the human turn instead. Shared by the
// reactive turn (runtime.ts) and customer-message ingestion.
export const CONVERSATION_DIVIDER =
  "(Contexto do sistema: início de uma nova conversa com este mesmo contato. As mensagens anteriores são de atendimentos passados; não presuma que o assunto continua, trate isto como um novo atendimento.)";

// A minimal graph whose ONLY purpose is graph.updateState — appending to a thread's MessagesAnnotation
// channel without a model. The channel schema is identical to the real agent graph (both
// MessagesAnnotation), so the same checkpointer thread interoperates: the appended message is visible
// to the next real turn. asNode="noop" makes the update self-contained, so it does not depend on the
// node that wrote the prior checkpoint (which belongs to the real graph's topology).
function buildIngestGraph(checkpointer: BaseCheckpointSaver) {
  return new StateGraph(MessagesAnnotation)
    .addNode("noop", () => ({}))
    .addEdge(START, "noop")
    .addEdge("noop", END)
    .compile({ checkpointer });
}

export type IngestRole = "customer" | "human_agent";

export interface IngestMessageParams {
  tenantId: bigint;
  instanceId: bigint;
  // Chatwoot display_id — only used for the per-thread "new conversation" divider marker.
  conversationId: number;
  // The native ContactInbox id: the AgentThread key (== the graph thread's discriminator).
  contactInboxId: number;
  // The graph memory thread to append to (tenant:instance:ci:<contactInboxId>).
  graphThreadId: string;
  // Chatwoot message id — the monotonic watermark guarding against re-append.
  messageId: number;
  role: IngestRole;
  // The message body: a rendered customer message (renderInboundMessage) or a human agent's raw text.
  text: string;
  // The human agent's display name, for the <atendente> marker (role "human_agent" only).
  agentName?: string | null;
  base?: PrismaClient;
  checkpointer?: BaseCheckpointSaver;
}

// Strip quotes/newlines from a human agent's display name so it can't break the <atendente nome="…">
// marker. The name is our own staff (low risk), but keep the marker well-formed.
function sanitizeName(name: string): string {
  return name
    .replace(/["\n\r]+/g, " ")
    .trim()
    .slice(0, 80);
}

export async function ingestMessageIntoThread(
  params: IngestMessageParams,
): Promise<"ingested" | "skipped"> {
  const base = params.base ?? basePrisma;
  const {
    tenantId,
    instanceId,
    conversationId,
    contactInboxId,
    graphThreadId,
    messageId,
    role,
  } = params;
  if (!params.text.trim()) return "skipped";
  const checkpointer = params.checkpointer ?? (await getCheckpointer());
  const graph = buildIngestGraph(checkpointer);

  return runScopedOn(base, sysCtx(tenantId), (db) =>
    withEntityLock(db, `ingest:${graphThreadId}`, async () => {
      const key = {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      };
      const row = await db.agentThread.findUnique({
        where: key,
        select: { lastSyncedMessageId: true, lastConversationId: true },
      });
      // Monotonic watermark: never re-append a message already folded into the thread.
      if (
        row?.lastSyncedMessageId != null &&
        messageId <= row.lastSyncedMessageId
      ) {
        return "skipped";
      }

      // A customer message that starts a NEW conversation on this thread gets the fresh-attendance
      // divider (same as the reactive turn). Human-agent replies never carry it.
      const prevConv = row?.lastConversationId ?? null;
      const newConversation =
        role === "customer" && prevConv != null && prevConv !== conversationId;

      const body =
        role === "human_agent"
          ? `<atendente${params.agentName ? ` nome="${sanitizeName(params.agentName)}"` : ""}>\n${params.text}\n</atendente>`
          : newConversation
            ? `${CONVERSATION_DIVIDER}\n\n${params.text}`
            : params.text;
      // Customer → HumanMessage; human agent → AIMessage (the business side of the dialogue, so the
      // model reads it as an already-given reply), disambiguated by the <atendente> marker so it never
      // mistakes a colleague's words for its OWN prior output.
      const msg =
        role === "human_agent" ? new AIMessage(body) : new HumanMessage(body);

      await graph.updateState(
        { configurable: { thread_id: graphThreadId } },
        { messages: [msg] },
        "noop",
      );

      // Advance the watermark; customer messages also advance the divider marker (turns do the same).
      await db.agentThread.upsert({
        where: key,
        create: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
          threadId: graphThreadId,
          lastSyncedMessageId: messageId,
          ...(role === "customer"
            ? { lastConversationId: conversationId }
            : {}),
        },
        update: {
          lastSyncedMessageId: messageId,
          ...(role === "customer"
            ? { lastConversationId: conversationId }
            : {}),
        },
      });
      return "ingested";
    }),
  );
}

export interface IngestBatchMessageItem {
  messageId: number;
  role: IngestRole;
  text: string;
  agentName?: string | null;
}

export interface IngestBatchParams {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  contactInboxId: number;
  graphThreadId: string;
  messages: IngestBatchMessageItem[];
  base?: PrismaClient;
  checkpointer?: BaseCheckpointSaver;
}

export async function ingestMessagesBatchIntoThread(
  params: IngestBatchParams,
): Promise<{ ingested: number; skipped: number }> {
  const base = params.base ?? basePrisma;
  const {
    tenantId,
    instanceId,
    conversationId,
    contactInboxId,
    graphThreadId,
    messages,
  } = params;

  const validMessages = messages
    .filter((m) => m.text.trim())
    .sort((a, b) => a.messageId - b.messageId);

  if (validMessages.length === 0) {
    return { ingested: 0, skipped: messages.length };
  }

  const checkpointer = params.checkpointer ?? (await getCheckpointer());
  const graph = buildIngestGraph(checkpointer);

  return runScopedOn(base, sysCtx(tenantId), (db) =>
    withEntityLock(db, `ingest:${graphThreadId}`, async () => {
      const key = {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      };
      const row = await db.agentThread.findUnique({
        where: key,
        select: { lastSyncedMessageId: true, lastConversationId: true },
      });

      const watermark = row?.lastSyncedMessageId ?? -1;
      const toIngest = validMessages.filter((m) => m.messageId > watermark);
      const skipped = messages.length - toIngest.length;

      if (toIngest.length === 0) {
        return { ingested: 0, skipped };
      }

      const prevConv = row?.lastConversationId ?? null;
      let isNewConvMarkerNeeded =
        prevConv != null && prevConv !== conversationId;

      const lcMessages = toIngest.map((m) => {
        if (m.role === "human_agent") {
          const body = `<atendente${m.agentName ? ` nome="${sanitizeName(m.agentName)}"` : ""}>\n${m.text}\n</atendente>`;
          return new AIMessage(body);
        } else {
          let body = m.text;
          if (isNewConvMarkerNeeded) {
            body = `${CONVERSATION_DIVIDER}\n\n${m.text}`;
            isNewConvMarkerNeeded = false; // only attach to first customer message in new conversation
          }
          return new HumanMessage(body);
        }
      });

      await graph.updateState(
        { configurable: { thread_id: graphThreadId } },
        { messages: lcMessages },
        "noop",
      );

      const maxMessageId = toIngest[toIngest.length - 1].messageId;
      const hasCustomerMessage = toIngest.some((m) => m.role === "customer");

      await db.agentThread.upsert({
        where: key,
        create: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
          threadId: graphThreadId,
          lastSyncedMessageId: maxMessageId,
          ...(hasCustomerMessage ? { lastConversationId: conversationId } : {}),
        },
        update: {
          lastSyncedMessageId: maxMessageId,
          ...(hasCustomerMessage ? { lastConversationId: conversationId } : {}),
        },
      });

      return { ingested: toIngest.length, skipped };
    }),
  );
}
