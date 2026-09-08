import { describe, it, expect, vi, afterEach } from "vitest";
import { todayISOInTimeZone } from "@/lib/nutrition";

// This function pre-dates the push-reminder feature (a leftover from the
// removed WhatsApp integration, see supabase/schema.sql's cleanup block) and
// had no test coverage. It's added here because app/api/cron/reminders/route.js
// now depends on it being correct at day boundaries to decide *when* "today"
// rolls over in WIB for a serverless host running on UTC — not a drive-by
// test of unrelated code.
describe("todayISOInTimeZone", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rolls over to the next WIB day before UTC midnight", () => {
    // 23:30 UTC on 2026-09-08 is 06:30 WIB on 2026-09-09 (UTC+7, no DST) --
    // the exact boundary case a naive UTC-date read would get wrong.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T23:30:00Z"));
    expect(todayISOInTimeZone("Asia/Jakarta")).toBe("2026-09-09");
  });

  it("stays on the same WIB day well before the boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T05:00:00Z")); // 12:00 WIB, same day
    expect(todayISOInTimeZone("Asia/Jakarta")).toBe("2026-09-08");
  });
});
