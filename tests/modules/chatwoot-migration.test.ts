import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { migrateChatwootInstanceHistory } from "@/modules/chatwoot/migration";

describe("migrateChatwootInstanceHistory", () => {
  test("processes conversations and ingests messages", async () => {
    const mockClient = {
      listConversations: async (opts?: { page?: number }) => {
        if (opts?.page === 1) {
          return {
            payload: [
              {
                id: 101,
                inbox_id: 1,
                contact_inbox: { id: 501 },
              },
            ],
          };
        }
        return { payload: [] };
      },
      getMessages: async (convId: number) => {
        if (convId === 101) {
          return {
            payload: [
              {
                id: 1,
                content: "Olá, quero saber o preço da picanha",
                message_type: 0,
                private: false,
              },
              {
                id: 2,
                content: "Boa tarde! A picanha está R$ 79,90/kg.",
                message_type: 1,
                private: false,
                sender: { name: "Kátia", type: "user" },
              },
            ],
          };
        }
        return { payload: [] };
      },
    } as unknown as ChatwootClient;

    // Fake prisma that records agentThread watermark check
    const mockPrisma = {
      agentThread: {
        findUnique: async () => null,
      },
    } as unknown as PrismaClient;

    const result = await migrateChatwootInstanceHistory(1n, 10n, {
      maxConversations: 10,
      base: mockPrisma,
      loadClient: async () => mockClient,
    });

    expect(result.conversationsProcessed).toBe(1);
    expect(result.instanceId).toBe("10");
    expect(result.errors).toEqual([]);
  });

  test("handles empty conversation lists gracefully", async () => {
    const mockClient = {
      listConversations: async () => ({ payload: [] }),
    } as unknown as ChatwootClient;

    const result = await migrateChatwootInstanceHistory(1n, 10n, {
      loadClient: async () => mockClient,
    });

    expect(result.conversationsProcessed).toBe(0);
    expect(result.messagesIngested).toBe(0);
    expect(result.errors).toEqual([]);
  });
});
