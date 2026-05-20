import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "@/lib/config";
import { quoteResponseSchemaPrompt } from "@/lib/quote/responseSchema";

const execFileAsync = promisify(execFile);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_STDOUT_BYTES = 12 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const OCR_SCRIPT_PATH = path.join(process.cwd(), "scripts", "quote-response-ocr.py");
const OPENAI_OCR_PROMPT = [
  "이미지는 여행사 견적답변 화면 또는 스크린샷이다.",
  "이미지에 보이는 모든 한글/영문/숫자/금액/통화/날짜 텍스트를 원문 순서대로 줄 단위로 추출해라.",
  "원문 텍스트를 그대로 보존해라. 라벨, 단어, 금액, 통화, 기호, 괄호, 슬래시를 다른 표현으로 바꾸지 마라.",
  "불포함, 조건부, 별도, 옵션, 추가 비용, 현지 지불 같은 문구도 누락하거나 요약하지 말고 그대로 추출해라.",
  "금액을 분류하거나 견적 항목으로 판단하지 마라. OCR 텍스트 추출만 수행해라.",
  "해석, 요약, 계산, 보정, 누락 추정은 하지 마라.",
  "아래 API 컬럼/라벨 정의는 텍스트 보존을 위한 참고 사전이다. 이 정의로 구조화 결과를 만들지 말고, 해당 라벨이 보이면 원문 그대로 추출해라.",
  quoteResponseSchemaPrompt(),
  "표나 그리드는 사람이 읽는 순서의 행 단위로 보존해라.",
  "JSON만 반환해라. 형식: {\"lines\":[\"첫 줄\",\"둘째 줄\"]}",
].join("\n");

export interface QuoteOcrLine {
  text: string;
  confidence?: number;
}

export interface QuoteOcrResult {
  extractedText: string;
  lines: QuoteOcrLine[];
}

export class QuoteOcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteOcrError";
  }
}

interface ExecErrorLike {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

interface OpenAiResponsesRequest {
  model: string;
  input: Array<{
    role: "user";
    content: Array<
      | { type: "input_text"; text: string }
      | { type: "input_image"; image_url: string; detail: "high" }
    >;
  }>;
  temperature: number;
  max_output_tokens: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function fileExtension(file: File): string {
  const fromName = /\.(png|jpe?g|webp)$/iu.exec(file.name)?.[1]?.toLowerCase();
  if (fromName) return fromName === "jpg" ? "jpg" : fromName;
  if (file.type === "image/png") return "png";
  if (file.type === "image/jpeg") return "jpg";
  if (file.type === "image/webp") return "webp";
  return "png";
}

function validateImage(file: File): void {
  if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
    throw new QuoteOcrError("PNG, JPG, WEBP 이미지 파일만 OCR 처리할 수 있습니다.");
  }
  if (file.size <= 0) {
    throw new QuoteOcrError("OCR 처리할 이미지 파일이 비어 있습니다.");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new QuoteOcrError("이미지 파일은 8MB 이하만 OCR 처리할 수 있습니다.");
  }
}

function parseOcrPayload(stdout: string): UnknownRecord {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!isRecord(parsed)) throw new Error("invalid payload");
    return parsed;
  } catch {
    throw new QuoteOcrError("로컬 OCR 응답을 JSON으로 해석하지 못했습니다.");
  }
}

function readOcrError(payload: UnknownRecord): string {
  const error = payload.error;
  if (isRecord(error)) {
    const message = readString(error.message);
    if (message) return message;
  }
  return "OCR 처리 중 오류가 발생했습니다.";
}

function extractLinesFromPayload(payload: UnknownRecord): QuoteOcrLine[] {
  const lines = payload.lines;
  if (!Array.isArray(lines)) return [];
  return lines.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const text = readString(entry.text).trim();
    if (!text) return [];
    const confidence = readNumber(entry.confidence);
    return [confidence === undefined ? { text } : { text, confidence }];
  });
}

function linesFromText(text: string): QuoteOcrLine[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ text: line }));
}

function stripJsonFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
}

function readLineEntries(value: unknown): QuoteOcrLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      const text = entry.trim();
      return text ? [{ text }] : [];
    }
    if (!isRecord(entry)) return [];
    const text = readString(entry.text).trim();
    if (!text) return [];
    const confidence = readNumber(entry.confidence);
    return [confidence === undefined ? { text } : { text, confidence }];
  });
}

function linesFromOpenAiText(text: string): QuoteOcrLine[] {
  const cleaned = stripJsonFence(text);
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (isRecord(parsed)) {
      const parsedLines = readLineEntries(parsed.lines);
      if (parsedLines.length > 0) return parsedLines;
      const parsedText = readString(parsed.text).trim();
      if (parsedText) return linesFromText(parsedText);
    }
    if (Array.isArray(parsed)) {
      const parsedLines = readLineEntries(parsed);
      if (parsedLines.length > 0) return parsedLines;
    }
  } catch {
    return linesFromText(cleaned);
  }
  return linesFromText(cleaned);
}

function extractOpenAiResponseText(payload: UnknownRecord): string {
  const directText = readString(payload.output_text).trim();
  if (directText) return directText;

  const output = payload.output;
  if (!Array.isArray(output)) return "";

  const chunks: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      const type = readString(part.type);
      if (type !== "output_text" && type !== "text") continue;
      const text = readString(part.text).trim();
      if (text) chunks.push(text);
    }
  }
  return chunks.join("\n").trim();
}

function readOpenAiError(payload: UnknownRecord): string {
  const error = payload.error;
  if (isRecord(error)) {
    const message = readString(error.message);
    if (message) return message;
  }
  return "OpenAI OCR 호출 중 오류가 발생했습니다.";
}

async function readJsonPayload(response: Response): Promise<UnknownRecord> {
  const parsed = (await response.json().catch(() => ({}))) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function stdoutFromError(error: unknown): string {
  if (!isRecord(error)) return "";
  const maybeError = error as ExecErrorLike;
  const stdout = maybeError.stdout;
  return Buffer.isBuffer(stdout) ? stdout.toString("utf8") : typeof stdout === "string" ? stdout : "";
}

function stderrFromError(error: unknown): string {
  if (!isRecord(error)) return "";
  const maybeError = error as ExecErrorLike;
  const stderr = maybeError.stderr;
  return Buffer.isBuffer(stderr) ? stderr.toString("utf8") : typeof stderr === "string" ? stderr : "";
}

async function performOpenAiQuoteResponseOcr(file: File): Promise<QuoteOcrResult> {
  validateImage(file);
  if (!config.ai.apiKey) {
    throw new QuoteOcrError("이미지 OCR을 사용하려면 서버에 OPENAI_API_KEY가 필요합니다.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ai.parseTimeoutMs);
  const imageBuffer = Buffer.from(await file.arrayBuffer());
  const imageUrl = `data:${file.type};base64,${imageBuffer.toString("base64")}`;
  const body: OpenAiResponsesRequest = {
    model: config.ai.model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: OPENAI_OCR_PROMPT },
          { type: "input_image", image_url: imageUrl, detail: "high" },
        ],
      },
    ],
    temperature: 0,
    max_output_tokens: 4096,
  };

  try {
    const response = await fetch(`${config.ai.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.ai.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await readJsonPayload(response);
    if (!response.ok) {
      throw new QuoteOcrError(`OpenAI OCR 호출 실패 (${response.status}): ${readOpenAiError(payload)}`);
    }

    const responseText = extractOpenAiResponseText(payload);
    const lines = linesFromOpenAiText(responseText);
    const extractedText = lines.map((line) => line.text).join("\n").trim();
    if (!extractedText) {
      throw new QuoteOcrError("이미지에서 견적답변 텍스트를 추출하지 못했습니다.");
    }
    return { extractedText, lines };
  } catch (error) {
    if (error instanceof QuoteOcrError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new QuoteOcrError(`OpenAI OCR 시간이 ${config.ai.parseTimeoutMs}ms를 초과했습니다.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function performLocalQuoteResponseOcr(file: File): Promise<QuoteOcrResult> {
  validateImage(file);

  const tempDir = path.join(tmpdir(), "tour-editor-quote-ocr");
  const tempPath = path.join(tempDir, `${randomUUID()}.${fileExtension(file)}`);

  try {
    await mkdir(tempDir, { recursive: true });
    await writeFile(tempPath, Buffer.from(await file.arrayBuffer()));

    const { stdout } = await execFileAsync(
      config.quoteOcr.pythonBin,
      [OCR_SCRIPT_PATH, tempPath],
      {
        timeout: config.quoteOcr.timeoutMs,
        maxBuffer: MAX_STDOUT_BYTES,
      },
    );
    const payload = parseOcrPayload(stdout);
    if (payload.ok !== true) throw new QuoteOcrError(readOcrError(payload));
    const extractedText = readString(payload.text).trim();
    const lines = extractLinesFromPayload(payload);
    return {
      extractedText,
      lines: lines.length > 0 ? lines : linesFromText(extractedText),
    };
  } catch (error) {
    if (error instanceof QuoteOcrError) throw error;
    const stdout = stdoutFromError(error);
    if (stdout) {
      const payload = parseOcrPayload(stdout);
      throw new QuoteOcrError(readOcrError(payload));
    }
    const stderr = stderrFromError(error).trim();
    throw new QuoteOcrError(stderr || "로컬 PaddleOCR 실행에 실패했습니다.");
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function performQuoteResponseOcr(file: File): Promise<QuoteOcrResult> {
  if (config.quoteOcr.provider === "local") {
    return performLocalQuoteResponseOcr(file);
  }
  return performOpenAiQuoteResponseOcr(file);
}
