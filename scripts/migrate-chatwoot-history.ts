#!/usr/bin/env bun

import basePrisma from "@/api/lib/prisma";
import { asSuperAdmin } from "@/lib/tenancy";
import { migrateChatwootInstanceHistory } from "@/modules/chatwoot/migration";

async function main() {
  const args = process.argv.slice(2);
  let instanceIdFilter: bigint | null = null;
  let maxConversations = 0; // 0 = unlimited

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--instance" && args[i + 1]) {
      instanceIdFilter = BigInt(args[i + 1]);
      i++;
    } else if (arg === "--limit" && args[i + 1]) {
      maxConversations = Number(args[i + 1]);
      i++;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Uso: bun scripts/migrate-chatwoot-history.ts [opções]

Opções:
  --instance <id>     ID numérico da ChatwootInstance para migrar (opcional, padrão: todas as ativas)
  --limit <n>         Limite máximo de conversas por instância (opcional, padrão: 0 = ilimitado)
  --help, -h          Exibe esta ajuda
      `);
      process.exit(0);
    }
  }

  console.log("==================================================");
  console.log("🚀 Iniciando Migração de Histórico do Chatwoot");
  console.log("==================================================");

  // Read instances as SUPER_ADMIN across all tenants
  const instances = await asSuperAdmin(basePrisma, async (db) => {
    if (instanceIdFilter) {
      return db.chatwootInstance.findMany({
        where: { id: instanceIdFilter, disconnectedAt: null },
        include: { deployment: true, tenant: true },
      });
    }
    return db.chatwootInstance.findMany({
      where: { disconnectedAt: null },
      include: { deployment: true, tenant: true },
    });
  });

  if (instances.length === 0) {
    console.log("⚠️ Nenhuma instância ativa do Chatwoot encontrada no banco.");
    process.exit(0);
  }

  console.log(`📦 Encontrada(s) ${instances.length} instância(s) ativa(s) para migrar.\n`);

  for (const inst of instances) {
    console.log(`--------------------------------------------------`);
    console.log(`📍 Processando Instância ID: ${inst.id}`);
    console.log(`   Tenant ID: ${inst.tenantId} (${inst.tenant.slug ?? "sem slug"})`);
    console.log(`   Account ID: ${inst.accountId}`);
    console.log(`   URL Base: ${inst.deployment.baseUrl}`);
    console.log(`--------------------------------------------------`);

    try {
      const result = await migrateChatwootInstanceHistory(
        inst.tenantId,
        inst.id,
        {
          maxConversations,
          base: basePrisma,
        },
      );

      console.log(`✅ Concluído para a instância ${inst.id}:`);
      console.log(`   - Conversas processadas: ${result.conversationsProcessed}`);
      console.log(`   - Mensagens ingeridas: ${result.messagesIngested}`);
      console.log(`   - Mensagens ignoradas (já sincronizadas): ${result.messagesSkipped}`);
      if (result.errors.length > 0) {
        console.log(`   - Erros encontrados: ${result.errors.length}`);
        for (const err of result.errors.slice(0, 5)) {
          console.log(`     * Conversa ${err.conversationId}: ${err.error}`);
        }
      }
      console.log("");
    } catch (err) {
      console.error(
        `❌ Falha ao migrar instância ${inst.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  console.log("==================================================");
  console.log("✨ Migração finalizada com sucesso!");
  console.log("==================================================");
  process.exit(0);
}

main().catch((err) => {
  console.error("Erro fatal na migração:", err);
  process.exit(1);
});
