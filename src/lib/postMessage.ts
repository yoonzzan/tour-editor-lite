// src/lib/postMessage.ts — 팝업 → 부모 창 postMessage 유틸
// 부모 창(하나투어 허브)으로 메시지를 전달한다.

export type EditorPostMessage =
  { type: "EDITOR_CLOSED" };

/**
 * window.opener 로 메시지를 전달한다.
 * opener 가 없으면(독립 탭 실행 등) 조용히 무시한다.
 */
export function notifyParent(message: EditorPostMessage): void {
  if (typeof window !== "undefined" && window.opener) {
    // 허용 origin 고정 전까지 부모 창 통합 호환성을 유지한다.
    window.opener.postMessage(message, "*");
  }
}
