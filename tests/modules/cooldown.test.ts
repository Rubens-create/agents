import { describe, expect, test } from "bun:test";
import {
  COOLDOWN_MAX_MINUTES,
  COOLDOWN_MIN_MINUTES,
  HUMAN_COOLDOWN_DEFAULTS,
  isWithinHumanCooldown,
  readHumanCooldownConfig,
} from "@/modules/cooldown/settings";

describe("readHumanCooldownConfig", () => {
  test("returns defaults when settings is empty or undefined", () => {
    expect(readHumanCooldownConfig(undefined)).toEqual(HUMAN_COOLDOWN_DEFAULTS);
    expect(readHumanCooldownConfig({})).toEqual(HUMAN_COOLDOWN_DEFAULTS);
    expect(readHumanCooldownConfig({ humanCooldown: null })).toEqual(
      HUMAN_COOLDOWN_DEFAULTS,
    );
  });

  test("parses enabled and cooldownMinutes", () => {
    const res = readHumanCooldownConfig({
      humanCooldown: { enabled: true, cooldownMinutes: 30 },
    });
    expect(res).toEqual({ enabled: true, cooldownMinutes: 30 });
  });

  test("accepts alias 'cooldown' and 'minutes'", () => {
    const res = readHumanCooldownConfig({
      cooldown: { enabled: true, minutes: 20 },
    });
    expect(res).toEqual({ enabled: true, cooldownMinutes: 20 });
  });

  test("clamps cooldownMinutes within boundaries", () => {
    const belowMin = readHumanCooldownConfig({
      humanCooldown: { enabled: true, cooldownMinutes: 0 },
    });
    expect(belowMin.cooldownMinutes).toBe(HUMAN_COOLDOWN_DEFAULTS.cooldownMinutes);

    const aboveMax = readHumanCooldownConfig({
      humanCooldown: { enabled: true, cooldownMinutes: 5000 },
    });
    expect(aboveMax.cooldownMinutes).toBe(COOLDOWN_MAX_MINUTES);
  });
});

describe("isWithinHumanCooldown", () => {
  test("returns false when not enabled", () => {
    const now = new Date("2026-08-18T10:00:00Z");
    const lastReply = new Date("2026-08-18T09:55:00Z");
    expect(
      isWithinHumanCooldown(lastReply, { enabled: false, cooldownMinutes: 15 }, now),
    ).toBe(false);
  });

  test("returns false when lastHumanReplyAt is null or invalid", () => {
    const now = new Date("2026-08-18T10:00:00Z");
    expect(
      isWithinHumanCooldown(null, { enabled: true, cooldownMinutes: 15 }, now),
    ).toBe(false);
    expect(
      isWithinHumanCooldown("invalid", { enabled: true, cooldownMinutes: 15 }, now),
    ).toBe(false);
  });

  test("returns true when within the cooldown window", () => {
    const now = new Date("2026-08-18T10:10:00Z");
    const lastReply = new Date("2026-08-18T10:00:00Z"); // 10 min ago
    expect(
      isWithinHumanCooldown(lastReply, { enabled: true, cooldownMinutes: 15 }, now),
    ).toBe(true);
  });

  test("returns false when outside the cooldown window", () => {
    const now = new Date("2026-08-18T10:20:00Z");
    const lastReply = new Date("2026-08-18T10:00:00Z"); // 20 min ago
    expect(
      isWithinHumanCooldown(lastReply, { enabled: true, cooldownMinutes: 15 }, now),
    ).toBe(false);
  });
});
