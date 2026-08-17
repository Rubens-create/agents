import { CheckCircle2, History, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

interface MigrationTaskState {
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
  result: MigrationResult | null;
  error?: string | null;
}

export function MigrateHistoryModal({ modal }: MigrateHistoryModalProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const target = modal?.payload;

  const [limit, setLimit] = useState<string>("100");
  const [status, setStatus] = useState<string>("all");
  const [running, setRunning] = useState(false);
  const [taskState, setTaskState] = useState<MigrationTaskState | null>(null);
  const [result, setResult] = useState<MigrationResult | null>(null);

  const logEndRef = useRef<HTMLDivElement>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const resetState = () => {
    stopPolling();
    setResult(null);
    setRunning(false);
    setTaskState(null);
  };

  const handleClose = () => {
    if (running) return;
    stopPolling();
    modal?.close();
    setTimeout(resetState, 300);
  };

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  };

  const checkStatus = async (): Promise<MigrationTaskState | null> => {
    if (!target?.instanceId) return null;
    try {
      const headers: Record<string, string> = {};
      const tenantId = getActiveTenantId();
      if (tenantId) headers["X-Tenant-Id"] = tenantId;

      const res = await fetch(
        `/api/v1/chatwoot/instances/${encodeURIComponent(target.instanceId)}/migrate-history/status`,
        { headers, credentials: "include" },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { status?: MigrationTaskState };
      return data.status ?? null;
    } catch {
      return null;
    }
  };

  const startPolling = () => {
    stopPolling();
    pollTimerRef.current = setInterval(async () => {
      const current = await checkStatus();
      if (!current) return;

      setTaskState(current);
      scrollToBottom();

      if (current.phase === "done" && current.result) {
        stopPolling();
        setRunning(false);
        setResult(current.result);
        showToast(
          t(
            "channels.migrateSuccessDesc",
            "{{count}} mensagens foram importadas para a memória dos agentes.",
            { count: current.result.messagesIngested },
          ),
          "success",
        );
      } else if (current.phase === "error") {
        stopPolling();
        setRunning(false);
        showToast(
          current.error || t("channels.migrateError", "Erro ao migrar histórico"),
          "error",
        );
      }
    }, 1000);
  };

  // Check if a task is already running when the modal opens
  useEffect(() => {
    if (!target?.instanceId) return;
    let isMounted = true;

    checkStatus().then((current) => {
      if (!isMounted || !current) return;
      if (current.running) {
        setTaskState(current);
        setRunning(true);
        startPolling();
      } else if (current.phase === "done" && current.result) {
        setTaskState(current);
        setResult(current.result);
      }
    });

    return () => {
      isMounted = false;
      stopPolling();
    };
  }, [target?.instanceId]);

  const startMigration = async () => {
    if (!target?.instanceId) return;
    setRunning(true);
    setResult(null);
    setTaskState({
      instanceId: target.instanceId,
      running: true,
      phase: "discovering",
      totalConversations: 0,
      currentIndex: 0,
      currentConversationId: null,
      messagesIngested: 0,
      messagesSkipped: 0,
      errorsCount: 0,
      logs: ["Iniciando processo de migração no servidor..."],
      result: null,
    });

    const maxConversations = limit === "0" ? 0 : Number(limit);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      const tenantId = getActiveTenantId();
      if (tenantId) headers["X-Tenant-Id"] = tenantId;

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
        },
      );

      if (!res.ok) {
        let msg = `Erro HTTP ${res.status}: falha ao iniciar migração`;
        try {
          const rawText = await res.text();
          try {
            const errBody = JSON.parse(rawText) as Record<string, unknown>;
            msg = (errBody.error as string) || (errBody.message as string) || msg;
          } catch {
            if (rawText && rawText.length < 300) msg = rawText;
          }
        } catch {
          // ignore
        }
        showToast(msg, "error");
        setRunning(false);
        setTaskState((prev) =>
          prev ? { ...prev, running: false, phase: "error", logs: [...prev.logs, `❌ ${msg}`] } : null,
        );
        return;
      }

      const data = (await res.json()) as { status?: MigrationTaskState };
      if (data.status) {
        setTaskState(data.status);
      }

      // Begin polling for live updates every second
      startPolling();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(msg, "error");
      setRunning(false);
      setTaskState((prev) =>
        prev ? { ...prev, running: false, phase: "error", logs: [...prev.logs, `❌ Erro: ${msg}`] } : null,
      );
    }
  };

  const titleText = target?.inboxName
    ? t("channels.migrateInboxTitle", "Migrar Conversas: {{name}}", {
        name: target.inboxName,
      })
    : t("channels.migrateTitle", "Migrar Conversas do Chatwoot");

  const progressPercent =
    taskState && taskState.totalConversations > 0
      ? Math.min(
          100,
          Math.round((taskState.currentIndex / taskState.totalConversations) * 100),
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
        {target && !taskState && (
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
        ) : taskState ? (
          <div className="flex flex-col gap-3">
            {/* Progress bar */}
            {taskState.phase === "processing" && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-xs text-text-muted">
                  <span>
                    {taskState.currentIndex} / {taskState.totalConversations}{" "}
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
            {taskState.phase === "processing" && (
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-md bg-bg-tertiary p-1.5">
                  <span className="block font-bold text-accent text-sm">
                    {taskState.messagesIngested}
                  </span>
                  <span className="text-text-muted text-xs">ingeridas</span>
                </div>
                <div className="rounded-md bg-bg-tertiary p-1.5">
                  <span className="block font-bold text-sm text-text-muted">
                    {taskState.messagesSkipped}
                  </span>
                  <span className="text-text-muted text-xs">já existiam</span>
                </div>
                {taskState.errorsCount > 0 && (
                  <div className="rounded-md bg-bg-tertiary p-1.5">
                    <span className="block font-bold text-error text-sm">
                      {taskState.errorsCount}
                    </span>
                    <span className="text-text-muted text-xs">erros</span>
                  </div>
                )}
              </div>
            )}

            {/* Log area */}
            <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-bg-secondary p-3 font-mono text-xs text-text-muted">
              {taskState.logs.map((log, i) => (
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
            {taskState.phase === "discovering" && (
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
