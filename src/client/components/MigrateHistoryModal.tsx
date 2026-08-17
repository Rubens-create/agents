import { AlertCircle, CheckCircle2, History, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  FormField,
  Modal,
  Select,
  useToast,
  type ModalController,
} from "@/client/components";
import { getActiveTenantId } from "@/client/lib/activeTenant";

export interface MigrationTarget {
  instanceId: string;
  accountId: number;
  inboxId?: number;
  inboxName?: string;
}

export interface MigrateHistoryModalProps {
  modal: ModalController<MigrationTarget>;
}

interface MigrationResult {
  conversationsProcessed: number;
  messagesIngested: number;
  messagesSkipped: number;
  errors: Array<{ conversationId: number; error: string }>;
}

// Progress event types matching the backend stream
type MigrationProgressEvent =
  | { type: "discovery"; totalConversations: number }
  | {
      type: "conversation_start";
      conversationId: number;
      index: number;
      total: number;
    }
  | {
      type: "conversation_done";
      conversationId: number;
      ingested: number;
      skipped: number;
    }
  | { type: "conversation_error"; conversationId: number; error: string }
  | { type: "complete"; result: MigrationResult };

interface ProgressState {
  phase: "discovering" | "processing" | "done";
  totalConversations: number;
  currentIndex: number;
  currentConversationId: number | null;
  messagesIngested: number;
  messagesSkipped: number;
  errors: number;
  logs: string[];
}

function addLog(prev: ProgressState, msg: string): ProgressState {
  return { ...prev, logs: [...prev.logs.slice(-100), msg] };
}

export function MigrateHistoryModal({ modal }: MigrateHistoryModalProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const target = modal?.payload;

  const [limit, setLimit] = useState<string>("100");
  const [status, setStatus] = useState<string>("all");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<MigrationResult | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const resetState = () => {
    setResult(null);
    setRunning(false);
    setProgress(null);
  };

  const handleClose = () => {
    if (running) return;
    modal?.close();
    setTimeout(resetState, 300);
  };

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  };

  const startMigration = async () => {
    if (!target?.instanceId) return;
    setRunning(true);
    setResult(null);
    setProgress({
      phase: "discovering",
      totalConversations: 0,
      currentIndex: 0,
      currentConversationId: null,
      messagesIngested: 0,
      messagesSkipped: 0,
      errors: 0,
      logs: ["Conectando ao Chatwoot e buscando conversas..."],
    });

    const maxConversations = limit === "0" ? 0 : Number(limit);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      };
      const tenantId = getActiveTenantId();
      if (tenantId) {
        headers["X-Tenant-Id"] = tenantId;
      }

      const res = await fetch(
        `/api/v1/chatwoot/instances/${encodeURIComponent(target.instanceId)}/migrate-history`,
        {
          method: "POST",
          headers,
          credentials: "include",
          body: JSON.stringify({
            maxConversations,
            status,
            inboxId: target.inboxId,
          }),
          signal: controller.signal,
        },
      );

      if (!res.ok) {
        let msg = `Erro HTTP ${res.status}: falha na migração`;
        try {
          const rawText = await res.text();
          try {
            const errBody = JSON.parse(rawText) as Record<string, unknown>;
            msg =
              (errBody.error as string) ||
              (errBody.message as string) ||
              msg;
          } catch {
            if (rawText && rawText.length < 300) {
              msg = rawText;
            }
          }
        } catch {
          // Ignore read error
        }
        showToast(msg, "error");
        setProgress((p) => (p ? addLog(p, `❌ ${msg}`) : p));
        return;
      }

      const contentType = res.headers.get("content-type") || "";

      if (contentType.includes("text/event-stream") && res.body) {
        // Stream NDJSON events
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
              const event = JSON.parse(trimmed) as MigrationProgressEvent;
              handleProgressEvent(event);
              scrollToBottom();
            } catch {
              // Ignore malformed lines
            }
          }
        }

        // Process remaining buffer
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer.trim()) as MigrationProgressEvent;
            handleProgressEvent(event);
          } catch {
            // Ignore
          }
        }
      } else {
        // Fallback: synchronous JSON response
        const body = (await res.json()) as { result?: MigrationResult };
        if (body?.result) {
          setResult(body.result);
          setProgress((p) =>
            p
              ? {
                  ...addLog(p, "✅ Migração concluída!"),
                  phase: "done",
                  messagesIngested: body.result!.messagesIngested,
                  messagesSkipped: body.result!.messagesSkipped,
                  errors: body.result!.errors.length,
                }
              : p,
          );
          showToast(
            t(
              "channels.migrateSuccessDesc",
              "{{count}} mensagens foram importadas para a memória dos agentes.",
              { count: body.result.messagesIngested },
            ),
            "success",
          );
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      showToast(
        err instanceof Error ? err.message : String(err),
        "error",
      );
      setProgress((p) =>
        p
          ? addLog(p, `❌ Erro: ${err instanceof Error ? err.message : String(err)}`)
          : p,
      );
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const handleProgressEvent = (event: MigrationProgressEvent) => {
    switch (event.type) {
      case "discovery":
        setProgress((p) =>
          p
            ? {
                ...addLog(
                  p,
                  `📋 ${event.totalConversations} conversas encontradas`,
                ),
                phase: "processing",
                totalConversations: event.totalConversations,
              }
            : p,
        );
        break;

      case "conversation_start":
        setProgress((p) =>
          p
            ? {
                ...addLog(
                  p,
                  `💬 Conversa #${event.conversationId} (${event.index + 1}/${event.total})...`,
                ),
                currentIndex: event.index + 1,
                currentConversationId: event.conversationId,
              }
            : p,
        );
        break;

      case "conversation_done":
        setProgress((p) =>
          p
            ? {
                ...addLog(
                  p,
                  `   ✓ #${event.conversationId}: ${event.ingested} ingeridas, ${event.skipped} já existiam`,
                ),
                messagesIngested: p.messagesIngested + event.ingested,
                messagesSkipped: p.messagesSkipped + event.skipped,
              }
            : p,
        );
        break;

      case "conversation_error":
        setProgress((p) =>
          p
            ? {
                ...addLog(
                  p,
                  `   ⚠ #${event.conversationId}: ${event.error}`,
                ),
                errors: p.errors + 1,
              }
            : p,
        );
        break;

      case "complete":
        setResult(event.result);
        setProgress((p) =>
          p
            ? {
                ...addLog(p, "✅ Migração concluída!"),
                phase: "done",
              }
            : p,
        );
        showToast(
          t(
            "channels.migrateSuccessDesc",
            "{{count}} mensagens foram importadas para a memória dos agentes.",
            { count: event.result.messagesIngested },
          ),
          "success",
        );
        break;
    }
  };

  const titleText = target?.inboxName
    ? t("channels.migrateInboxTitle", "Migrar Conversas: {{name}}", {
        name: target.inboxName,
      })
    : t("channels.migrateTitle", "Migrar Conversas do Chatwoot");

  const progressPercent =
    progress && progress.totalConversations > 0
      ? Math.round(
          (progress.currentIndex / progress.totalConversations) * 100,
        )
      : 0;

  return (
    <Modal
      modal={modal}
      title={
        <div className="flex items-center gap-2">
          <History className="h-5 w-5 text-accent" aria-hidden="true" />
          <span>{titleText}</span>
        </div>
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={handleClose} disabled={running}>
            {result
              ? t("common.close", "Fechar")
              : t("common.cancel", "Cancelar")}
          </Button>
          {!result && !running && (
            <Button
              onClick={startMigration}
              loading={running}
              variant="primary"
            >
              <History className="h-4 w-4" aria-hidden="true" />
              {t("channels.startMigrate", "Iniciar Migração")}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {target && !progress && (
          <p className="text-sm text-text-muted">
            {target.inboxName
              ? t(
                  "channels.migrateInboxDesc",
                  "Importe as conversas anteriores do canal {{name}} (#{{inboxId}}) para a memória de longo prazo (LangGraph). O agente saberá o histórico de cada cliente.",
                  {
                    name: target.inboxName,
                    inboxId: target.inboxId,
                  },
                )
              : t(
                  "channels.migrateDesc",
                  "Importe conversas anteriores da conta #{{accountId}} para a memória de longo prazo (LangGraph). Os agentes já saberão o histórico quando os clientes mandarem novas mensagens.",
                  { accountId: target.accountId },
                )}
          </p>
        )}

        {result ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg-tertiary p-4">
            <div className="flex items-center gap-2">
              <CheckCircle2
                className="h-5 w-5 text-success"
                aria-hidden="true"
              />
              <h4 className="font-medium text-sm text-text-primary">
                {t("channels.migrateSummary", "Resumo da Migração")}
              </h4>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md bg-bg-secondary p-2">
                <span className="block font-bold text-lg text-text-primary">
                  {result.conversationsProcessed}
                </span>
                <span className="text-text-muted text-xs">
                  {t("channels.convsProcessed", "Conversas")}
                </span>
              </div>
              <div className="rounded-md bg-bg-secondary p-2">
                <span className="block font-bold text-accent text-lg">
                  {result.messagesIngested}
                </span>
                <span className="text-text-muted text-xs">
                  {t("channels.msgsIngested", "Ingeridas")}
                </span>
              </div>
              <div className="rounded-md bg-bg-secondary p-2">
                <span className="block font-bold text-lg text-text-muted">
                  {result.messagesSkipped}
                </span>
                <span className="text-text-muted text-xs">
                  {t("channels.msgsSkipped", "Já existiam")}
                </span>
              </div>
            </div>

            {result.errors.length > 0 && (
              <p className="text-error text-xs">
                {t(
                  "channels.migrateErrorsOccurred",
                  "{{count}} conversas tiveram erros e foram ignoradas.",
                  { count: result.errors.length },
                )}
              </p>
            )}
          </div>
        ) : progress ? (
          <div className="flex flex-col gap-3">
            {/* Progress bar */}
            {progress.phase === "processing" && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-xs text-text-muted">
                  <span>
                    {progress.currentIndex} / {progress.totalConversations}{" "}
                    conversas
                  </span>
                  <span>{progressPercent}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-bg-tertiary">
                  <div
                    className="h-full rounded-full bg-accent transition-all duration-300 ease-out"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>
            )}

            {/* Live counters */}
            {progress.phase === "processing" && (
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-md bg-bg-tertiary p-1.5">
                  <span className="block font-bold text-accent text-sm">
                    {progress.messagesIngested}
                  </span>
                  <span className="text-text-muted text-xs">ingeridas</span>
                </div>
                <div className="rounded-md bg-bg-tertiary p-1.5">
                  <span className="block font-bold text-sm text-text-muted">
                    {progress.messagesSkipped}
                  </span>
                  <span className="text-text-muted text-xs">já existiam</span>
                </div>
                {progress.errors > 0 && (
                  <div className="rounded-md bg-bg-tertiary p-1.5">
                    <span className="block font-bold text-error text-sm">
                      {progress.errors}
                    </span>
                    <span className="text-text-muted text-xs">erros</span>
                  </div>
                )}
              </div>
            )}

            {/* Log area */}
            <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-bg-secondary p-3 font-mono text-xs text-text-muted">
              {progress.logs.map((log, i) => (
                <div
                  key={i}
                  className={
                    log.startsWith("❌") || log.startsWith("   ⚠")
                      ? "text-error"
                      : log.startsWith("✅")
                        ? "text-success"
                        : ""
                  }
                >
                  {log}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>

            {/* Spinner during discovery */}
            {progress.phase === "discovering" && (
              <div className="flex items-center justify-center gap-2 py-2 text-accent text-sm">
                <Loader2
                  className="h-5 w-5 animate-spin"
                  aria-hidden="true"
                />
                <span>Buscando conversas no Chatwoot...</span>
              </div>
            )}
          </div>
        ) : (
          <>
            <FormField
              label={t("channels.migrateLimit", "Quantidade de Conversas")}
              description={t(
                "channels.migrateLimitHint",
                "Conversas mais recentes são processadas primeiro.",
              )}
            >
              <Select
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                disabled={running}
              >
                <option value="50">Últimas 50 conversas</option>
                <option value="100">
                  Últimas 100 conversas (Recomendado)
                </option>
                <option value="300">Últimas 300 conversas</option>
                <option value="0">Todas as conversas disponíveis</option>
              </Select>
            </FormField>

            <FormField
              label={t("channels.migrateStatus", "Status das Conversas")}
              description={t(
                "channels.migrateStatusHint",
                "Filtre por conversas ativas ou resolvidas.",
              )}
            >
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                disabled={running}
              >
                <option value="all">Todas as conversas</option>
                <option value="open">Apenas Abertas (Open)</option>
                <option value="resolved">Apenas Resolvidas (Resolved)</option>
                <option value="pending">Apenas Pendentes (Pending)</option>
              </Select>
            </FormField>
          </>
        )}
      </div>
    </Modal>
  );
}
