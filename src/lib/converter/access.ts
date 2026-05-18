import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { config } from "@/lib/config";

const ACCESS_CODE_HEADER = "x-access-code";

export function isAccessCodeConfigured(): boolean {
  return config.access.code.trim().length > 0;
}

export function isValidAccessCode(value: string | null): boolean {
  const expected = config.access.code.trim();
  if (!expected) return false;
  return (value ?? "").trim() === expected;
}

export function getRequestAccessCode(req: NextRequest): string | null {
  return req.headers.get(ACCESS_CODE_HEADER);
}

export function requireConverterAccess(req: NextRequest): NextResponse | null {
  if (isValidAccessCode(getRequestAccessCode(req))) return null;
  return NextResponse.json({ error: "접근코드가 올바르지 않습니다." }, { status: 401 });
}
