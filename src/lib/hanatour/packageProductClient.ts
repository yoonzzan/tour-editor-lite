import { config } from "@/lib/config";

type UnknownRecord = Record<string, unknown>;

export class HanatourUrlError extends Error {
  public readonly status = 400;
}

export class HanatourGatewayError extends Error {
  public readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const HANATOUR_HOSTS = new Set(["hanatour.com", "www.hanatour.com", "m.hanatour.com"]);
const PRGM_ID = "CHPC0PKG0200M200";
const SITE_QUERY = "?_siteId=hanatour";
const PRODUCT_INFO_URL =
  `https://gw.hanatour.com/package/pkg/api/common/pkgcomprod/getPkgProdInfo/v1.00${SITE_QUERY}`;
const ITINERARY_INFO_URL =
  `https://gw.hanatour.com/package/pkg/api/common/pkgcomprod/getPkgProdItnrInfo/v1.00${SITE_QUERY}`;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

function requestTimeoutMs(): number {
  return Number.isFinite(config.mcp.requestTimeoutMs) && config.mcp.requestTimeoutMs > 0
    ? config.mcp.requestTimeoutMs
    : 30000;
}

function assertHanatourUrl(url: URL): void {
  if (!HANATOUR_HOSTS.has(url.hostname.toLowerCase())) {
    throw new HanatourUrlError("하나투어 상품 URL만 입력할 수 있습니다.");
  }
}

function normalizePkgCode(value: string | null): string {
  const code = (value ?? "").trim().toUpperCase();
  if (!code) {
    throw new HanatourUrlError("URL에서 상품코드(pkgCd)를 찾을 수 없습니다.");
  }
  if (!/^[A-Z0-9]{6,40}$/u.test(code)) {
    throw new HanatourUrlError("상품코드(pkgCd) 형식이 올바르지 않습니다.");
  }
  return code;
}

export function extractPkgCodeFromHanatourUrl(rawUrl: string): string {
  const input = rawUrl.trim();
  if (!input) throw new HanatourUrlError("하나투어 상품 URL을 입력해 주세요.");

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new HanatourUrlError("올바른 URL 형식이 아닙니다.");
  }

  assertHanatourUrl(url);
  return normalizePkgCode(url.searchParams.get("pkgCd"));
}

async function fetchJsonWithTimeout(url: string, body: UnknownRecord, requestGuid?: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, requestTimeoutMs());

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        prgmid: PRGM_ID,
        referer: "https://www.hanatour.com/",
        ...(requestGuid ? { "x-request-guid": requestGuid } : {}),
      },
      body: JSON.stringify(body),
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new HanatourGatewayError(
        `하나투어 상품 API 조회에 실패했습니다. (${response.status})`,
        response.status,
      );
    }

    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new HanatourGatewayError("하나투어 상품 API 응답을 해석할 수 없습니다.", 502);
    }
  } catch (error) {
    if (error instanceof HanatourGatewayError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new HanatourGatewayError("하나투어 상품 API 응답 시간이 초과되었습니다.", 504);
    }
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    throw new HanatourGatewayError(`하나투어 상품 API 조회에 실패했습니다. (${message})`, 502);
  } finally {
    clearTimeout(timeout);
  }
}

function unwrapData(response: unknown): UnknownRecord {
  if (!isRecord(response)) return {};
  const data = response.data;
  return isRecord(data) ? data : response;
}

export async function fetchHanatourProductFromUrl(
  rawUrl: string,
  requestGuid?: string,
): Promise<{ productCode: string; payload: UnknownRecord }> {
  const productCode = extractPkgCodeFromHanatourUrl(rawUrl);
  const [productInfo, itineraryInfo] = await Promise.all([
    fetchJsonWithTimeout(
      PRODUCT_INFO_URL,
      {
        pkgCd: productCode,
        inpPathCd: "DCP",
        smplYn: "N",
        coopYn: "N",
        resAcceptPtn: {},
        partnerYn: "N",
      },
      requestGuid,
    ),
    fetchJsonWithTimeout(ITINERARY_INFO_URL, { pkgCd: productCode }, requestGuid),
  ]);

  const baseProductInfo = unwrapData(productInfo);
  const scheduleInfo = unwrapData(itineraryInfo);
  const saleProdCd = asString(baseProductInfo.saleProdCd) ?? productCode;

  return {
    productCode: saleProdCd,
    payload: {
      saleProdCd,
      baseProductInfo,
      itineraryInfo: scheduleInfo,
    },
  };
}
