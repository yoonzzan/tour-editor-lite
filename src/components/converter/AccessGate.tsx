"use client";

import { type ReactNode, useEffect, useState } from "react";
import {
  clearStoredAccessCode,
  getStoredAccessCode,
  setStoredAccessCode,
} from "@/lib/converter/clientAccess";

interface Props {
  children: ReactNode;
}

export function AccessGate({ children }: Props) {
  const [code, setCode] = useState("");
  const [isAllowed, setIsAllowed] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = getStoredAccessCode();
    if (!stored) {
      setIsChecking(false);
      return;
    }

    async function verifyStoredCode() {
      try {
        const res = await fetch("/api/access/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: stored }),
        });
        if (res.ok) {
          setIsAllowed(true);
        } else {
          clearStoredAccessCode();
        }
      } finally {
        setIsChecking(false);
      }
    }

    void verifyStoredCode();
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError("접근코드를 입력해 주세요.");
      return;
    }

    setError(null);
    const res = await fetch("/api/access/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: trimmed }),
    });

    if (!res.ok) {
      setError("접근코드가 올바르지 않습니다.");
      return;
    }

    setStoredAccessCode(trimmed);
    setIsAllowed(true);
  }

  if (isChecking) {
    return (
      <main className="hub-app flex min-h-screen items-center justify-center">
        <p className="text-[12.5px] text-muted-foreground">확인 중...</p>
      </main>
    );
  }

  if (isAllowed) {
    return <>{children}</>;
  }

  return (
    <main className="hub-app flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={handleSubmit}
        className="hub-dialog w-full max-w-[360px]"
      >
        <div className="hub-dialog-head">
          <h1 className="text-[13px] font-bold leading-5">
            견적서 에디터
          </h1>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <p className="text-sm text-muted-foreground">
            공유 접근코드를 입력해 주세요.
          </p>
          <div className="hub-field">
            <label htmlFor="access-code" className="hub-field-label">
              접근코드
            </label>
            <div className="hub-field-control">
              <input
                id="access-code"
                type="password"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="hub-input"
                autoComplete="off"
              />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end">
            <button type="submit" className="hub-btn hub-btn-primary">
              열기
            </button>
          </div>
        </div>
      </form>
    </main>
  );
}
