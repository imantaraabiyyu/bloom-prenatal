import { describe, it, expect } from "vitest";
import { classifyChatError, buildBubbleCopyText, CHAT_ERROR_MESSAGES } from "@/lib/chatErrors";

describe("classifyChatError", () => {
  it("treats a 401 as auth and asks for login", () => {
    const r = classifyChatError({ status: 401, serverMessage: "Kamu perlu login dulu." });
    expect(r).toEqual({ kind: "auth", message: CHAT_ERROR_MESSAGES.auth, needsLogin: true });
  });

  it("prefers an explicit code over the status", () => {
    expect(classifyChatError({ status: 200, code: "busy" }).kind).toBe("busy");
  });

  it("classifies a network failure", () => {
    const r = classifyChatError({ networkFailure: true });
    expect(r.kind).toBe("network");
    expect(r.needsLogin).toBe(false);
  });

  it("maps 413 to too_large and keeps the server's message", () => {
    const r = classifyChatError({ status: 413, serverMessage: "Foto terlalu besar. Coba foto lain atau perkecil dulu." });
    expect(r.kind).toBe("too_large");
    expect(r.message).toContain("Foto terlalu besar");
  });

  it("maps 400 to invalid", () => {
    expect(classifyChatError({ status: 400, serverMessage: "Body request tidak valid." })).toMatchObject({ kind: "invalid", message: "Body request tidak valid." });
  });

  it("uses fixed wording for busy even if the server sends text", () => {
    expect(classifyChatError({ status: 429, serverMessage: "whatever" }).message).toBe(CHAT_ERROR_MESSAGES.busy);
  });

  it("falls back to generic for unknown input", () => {
    expect(classifyChatError({ status: 500 })).toEqual({ kind: "generic", message: CHAT_ERROR_MESSAGES.generic, needsLogin: false });
    expect(classifyChatError().kind).toBe("generic");
  });
});

describe("buildBubbleCopyText", () => {
  it("returns plain message text", () => {
    expect(buildBubbleCopyText({ text: "Halo Bloom" })).toBe("Halo Bloom");
  });

  it("joins analysis text and the verdict line", () => {
    expect(buildBubbleCopyText({ analysisText: "🍽️ Nasi goreng", verdictLabel: "✅ Aman dikonsumsi", verdictReason: "Boleh kok" }))
      .toBe("🍽️ Nasi goreng\n\n✅ Aman dikonsumsi — Boleh kok");
  });

  it("returns empty for streaming placeholders and error notices", () => {
    expect(buildBubbleCopyText({ text: "abc", streaming: true })).toBe("");
    expect(buildBubbleCopyText({ text: "abc", isError: true })).toBe("");
  });

  it("returns empty when there is nothing visible", () => {
    expect(buildBubbleCopyText({})).toBe("");
  });
});
