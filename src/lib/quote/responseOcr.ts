import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "@/lib/config";

const execFileAsync = promisify(execFile);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_STDOUT_BYTES = 12 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const OCR_SCRIPT_PATH = path.join(process.cwd(), "scripts", "quote-response-ocr.py");

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

export async function performQuoteResponseOcr(file: File): Promise<QuoteOcrResult> {
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
