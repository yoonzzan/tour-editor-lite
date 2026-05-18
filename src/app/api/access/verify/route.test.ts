import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

function makeRequest(code: string): NextRequest {
  return {
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ code }),
  } as unknown as NextRequest;
}

beforeEach(() => {
  process.env.ACCESS_CODE = "test-code";
  vi.resetModules();
});

describe("/api/access/verify", () => {
  it("accepts the configured access code", async () => {
    const { POST } = await import("./route");

    const response = await POST(makeRequest("test-code"));

    expect(response.status).toBe(200);
  });
});
