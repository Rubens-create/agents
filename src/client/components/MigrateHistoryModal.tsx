import { History, Loader2 } from "lucide-react";
import { useState } from "react";
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
import { api } from "@/client/lib/api";

type DeploymentData = Awaited<
  ReturnType<typeof api.api.v1.chatwoot.deployment.get>
>["data"];
type Account = NonNullable<DeploymentData>["accounts"][number];

export interface MigrateHistoryModalProps {
  modal: ModalController<Account>;
}

interface MigrationResult {
  conversationsProcessed: number;
  messagesIngested: number;
  messagesSkipped: number;
  errors: Array<{ conversationId: number; error: string }>;
}

export function MigrateHistoryModal({ modal }: MigrateHistoryModalProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const account = modal?.payload;

  const [limit, setLimit] = useState<string>("100");
  const [status, setStatus] = useState<string>("all");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<MigrationResult | null>(null);

  const resetState = () => {
    setResult(null);
    setRunning(false);
  };

  const handleClose = () => {
    if (running) return;
    modal?.close();
    setTimeout(resetState, 300);
  };

  const startMigration = async () => {
    if (!account?.id) return;
    setRunning(true);
    setResult(null);

    const maxConversations = limit === "0" ? 0 : Number(limit);
    let migrationResult: MigrationResult | null = null;
    let errorMessage: string | null = null;

    try {
      // 1. Try Eden Treaty typed call if available
      try {
        const clientRef = api as unknown as {
          api?: {
            v1?: {
              chatwoot?: {
                instances?: (params: { id: string }) => {
                  "migrate-history"?: {
                    post: (payload: {
                      maxConversations: number;
                      status: string;
                    }) => Promise<{
                      data?: { result?: MigrationResult };
                      error?: unknown;
                    }>;
                  };
                };
              };
            };
          };
        };

        const targetInstance = clientRef.api?.v1?.chatwoot?.instances?.({
          id: String(account.id),
        });

        if (typeof targetInstance?.["migrate-history"]?.post === "function") {
          const res = await targetInstance["migrate-history"].post({
            maxConversations,
            status,
          });
          if (res?.data?.result) {
            migrationResult = res.data.result;
          } else if (res?.error) {
            const errObj = res.error as Record<string, unknown>;
            errorMessage =
              typeof errObj?.message === "string"
                ? errObj.message
                : String(res.error);
          }
        } else {
          throw new Error("Eden method unavailable");
        }
      } catch {
        // 2. Direct fetch fallback with active tenant header and credentials
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        const tenantId = getActiveTenantId();
        if (tenantId) {
          headers["X-Tenant-Id"] = tenantId;
        }

        const res = await fetch(
          `/api/v1/chatwoot/instances/${account.id}/migrate-history`,
          {
            method: "POST",
            headers,
            credentials: "include",
            body: JSON.stringify({
              maxConversations,
              status,
            }),
          },
        );

        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as Record<
            string,
            unknown
          >;
          errorMessage =
            (errBody.error as string) ||
            (errBody.message as string) ||
            `Erro HTTP ${res.status}`;
        } else {
          const body = (await res.json()) as { result?: MigrationResult };
          if (body?.result) {
            migrationResult = body.result;
          }
        }
      }

      if (errorMessage) {
        toast({
          variant: "error",
          title: t("channels.migrateError", "Falha na migração de histórico"),
          description: errorMessage,
        });
      } else if (migrationResult) {
        setResult(migrationResult);
        toast({
          variant: "success",
          title: t("channels.migrateSuccess", "Migração concluída!"),
          description: t(
            "channels.migrateSuccessDesc",
            "{{count}} mensagens foram importadas para a memória dos agentes.",
            { count: migrationResult.messagesIngested },
          ),
        });
      }
    } catch (err) {
      toast({
        variant: "error",
        title: t("channels.migrateError", "Erro ao migrar histórico"),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      modal={modal}
      title={
        <div className="flex items-center gap-2">
          <History className="h-5 w-5 text-accent" aria-hidden="true" />
          <span>
            {t("channels.migrateTitle", "Migrar Conversas do Chatwoot")}
          </span>
        </div>
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={handleClose} disabled={running}>
            {result
              ? t("common.close", "Fechar")
              : t("common.cancel", "Cancelar")}
          </Button>
          {!result && (
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
        {account && (
          <p className="text-sm text-text-muted">
            {t(
              "channels.migrateDesc",
              "Importe conversas anteriores da conta #{{accountId}} para a memória de longo prazo (LangGraph). Os agentes já saberão o histórico quando os clientes mandarem novas mensagens.",
              { accountId: account.accountId },
            )}
          </p>
        )}

        {result ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg-tertiary p-4">
            <h4 className="font-medium text-sm text-text-primary">
              {t("channels.migrateSummary", "Resumo da Migração")}
            </h4>
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

            {running && (
              <div className="flex items-center justify-center gap-2 py-4 text-accent text-sm">
                <Loader2
                  className="h-5 w-5 animate-spin"
                  aria-hidden="true"
                />
                <span>
                  {t(
                    "channels.migratingHistoryProgress",
                    "Baixando mensagens do Chatwoot e alimentando a memória...",
                  )}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
