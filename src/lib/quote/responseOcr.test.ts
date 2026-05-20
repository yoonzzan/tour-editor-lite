import { beforeEach, describe, expect, it, vi } from "vitest";

function makeImageFile(): File {
  return new File(["fake image"], "quote.png", { type: "image/png" });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("performQuoteResponseOcr", () => {
  it("uses OpenAI Responses API by default and returns extracted lines", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.test/v1");
    vi.stubEnv("OPENAI_MODEL", "gpt-4.1-mini");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      output_text: JSON.stringify({
        lines: ["항공료 830,000", "TAX 125,000"],
      }),
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { performQuoteResponseOcr } = await import("./responseOcr");
    const result = await performQuoteResponseOcr(makeImageFile());

    expect(result.extractedText).toBe("항공료 830,000\nTAX 125,000");
    expect(result.lines).toEqual([
      { text: "항공료 830,000" },
      { text: "TAX 125,000" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error("fetch was not called");
    const [url, init] = firstCall;
    expect(url).toBe("https://api.openai.test/v1/responses");
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const body = JSON.parse(bodyText) as {
      model?: string;
      input?: Array<{ content?: Array<{ type?: string; image_url?: string }> }>;
    };
    expect(body.model).toBe("gpt-4.1-mini");
    const prompt = body.input?.[0]?.content?.find((part) => part.type === "input_text") as
      | { text?: string }
      | undefined;
    expect(prompt?.text).toContain("원문 텍스트를 그대로 보존");
    expect(prompt?.text).toContain("조건부");
    expect(prompt?.text).toContain("불포함");
    expect(prompt?.text).toContain("ansrKndCd=구분코드");
    expect(prompt?.text).toContain("AIR.항공료->persPerFare");
    expect(prompt?.text).toContain("FEE.보험료->totlAmt");
    expect(body.input?.[0]?.content?.some((part) => (
      part.type === "input_image" && part.image_url?.startsWith("data:image/png;base64,")
    ))).toBe(true);
  });

  it("requires OPENAI_API_KEY for OpenAI OCR", async () => {
    const { performQuoteResponseOcr } = await import("./responseOcr");

    await expect(performQuoteResponseOcr(makeImageFile())).rejects.toThrow(
      "이미지 OCR을 사용하려면 서버에 OPENAI_API_KEY가 필요합니다.",
    );
  });
});
