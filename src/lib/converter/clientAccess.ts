"use client";

export const ACCESS_CODE_STORAGE_KEY = "tour-editor.access-code";
const ACCESS_CODE_HEADER = "x-access-code";

export function getStoredAccessCode(): string {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem(ACCESS_CODE_STORAGE_KEY) ?? "";
}

export function setStoredAccessCode(code: string): void {
  window.sessionStorage.setItem(ACCESS_CODE_STORAGE_KEY, code);
}

export function clearStoredAccessCode(): void {
  window.sessionStorage.removeItem(ACCESS_CODE_STORAGE_KEY);
}

export function withAccessCodeHeaders(headers?: HeadersInit): Headers {
  const nextHeaders = new Headers(headers);
  const code = getStoredAccessCode();
  if (code) nextHeaders.set(ACCESS_CODE_HEADER, code);
  return nextHeaders;
}
