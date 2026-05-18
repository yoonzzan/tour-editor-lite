import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isValidAccessCode } from "@/lib/converter/access";

interface VerifyBody {
  code?: unknown;
}

export async function POST(req: NextRequest) {
  let body: VerifyBody;
  try {
    body = (await req.json()) as VerifyBody;
  } catch {
    return NextResponse.json({ error: "접근코드를 입력해 주세요." }, { status: 400 });
  }

  const code = typeof body.code === "string" ? body.code : "";
  if (!isValidAccessCode(code)) {
    return NextResponse.json({ error: "접근코드가 올바르지 않습니다." }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
}
