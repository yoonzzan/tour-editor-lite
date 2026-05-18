import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

function makeRequest(): NextRequest {
  return {
    headers: new Headers({ "x-access-code": "wrong-code" }),
    nextUrl: new URL("http://localhost/api/export?type=itinerary"),
    json: async () => ({}),
  } as unknown as NextRequest;
}

beforeEach(() => {
  process.env.ACCESS_CODE = "test-code";
  vi.resetModules();
});

describe("/api/export", () => {
  it("rejects invalid converter access codes", async () => {
    const { POST } = await import("./route");

    const response = await POST(makeRequest());

    expect(response.status).toBe(401);
  });
});
