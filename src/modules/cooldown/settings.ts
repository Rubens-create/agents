// Per-agent human cooldown / silence window configuration, read from `agent.settings.humanCooldown`
// (or `agent.settings.cooldown`). When enabled, the agent remains silent for `cooldownMinutes` after
// any message sent by a human agent (User).

export interface HumanCooldownConfig {
  enabled: boolean;
  cooldownMinutes: number;
}

export const HUMAN_COOLDOWN_DEFAULTS: HumanCooldownConfig = {
  enabled: false,
  cooldownMinutes: 15,
};

export const COOLDOWN_MIN_MINUTES = 1;
export const COOLDOWN_MAX_MINUTES = 1440; // 24 hours

// Fast in-memory cache for human reply timestamps keyed by threadId (tenantId:instanceId:convId).
const lastHumanReplyByThread = new Map<string, number>();

export function recordHumanReplyTimestamp(
  threadId: string,
  timestampMs: number = Date.now(),
): void {
  lastHumanReplyByThread.set(threadId, timestampMs);
}

export function getRecordedHumanReplyTimestamp(
  threadId: string,
): number | null {
  return lastHumanReplyByThread.get(threadId) ?? null;
}

export function isThreadWithinHumanCooldown(
  threadId: string,
  cfg: HumanCooldownConfig,
  now: Date = new Date(),
): boolean {
  if (!cfg.enabled) return false;
  const recorded = getRecordedHumanReplyTimestamp(threadId);
  if (!recorded) return false;
  const diffMs = now.getTime() - recorded;
  const cooldownMs = cfg.cooldownMinutes * 60 * 1000;
  return diffMs >= 0 && diffMs < cooldownMs;
}

export function readHumanCooldownConfig(settings: unknown): HumanCooldownConfig {
  const c =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).humanCooldown ??
        (settings as Record<string, unknown>).cooldown
      : undefined;
  if (!c || typeof c !== "object") return { ...HUMAN_COOLDOWN_DEFAULTS };
  const bag = c as Record<string, unknown>;
  const enabled =
    typeof bag.enabled === "boolean"
      ? bag.enabled
      : HUMAN_COOLDOWN_DEFAULTS.enabled;
  const rawMinutes = Number(
    bag.cooldownMinutes ?? bag.minutes ?? HUMAN_COOLDOWN_DEFAULTS.cooldownMinutes,
  );
  const cooldownMinutes =
    Number.isFinite(rawMinutes) && rawMinutes >= COOLDOWN_MIN_MINUTES
      ? Math.min(Math.round(rawMinutes), COOLDOWN_MAX_MINUTES)
      : HUMAN_COOLDOWN_DEFAULTS.cooldownMinutes;
  return { enabled, cooldownMinutes };
}

export function isWithinHumanCooldown(
  lastHumanReplyAt: Date | string | number | null | undefined,
  cfg: HumanCooldownConfig,
  now: Date = new Date(),
): boolean {
  if (!cfg.enabled || !lastHumanReplyAt) return false;
  const lastTime =
    typeof lastHumanReplyAt === "number"
      ? lastHumanReplyAt
      : lastHumanReplyAt instanceof Date
        ? lastHumanReplyAt.getTime()
        : new Date(lastHumanReplyAt).getTime();
  if (!Number.isFinite(lastTime) || lastTime <= 0) return false;
  const diffMs = now.getTime() - lastTime;
  const cooldownMs = cfg.cooldownMinutes * 60 * 1000;
  return diffMs >= 0 && diffMs < cooldownMs;
}
