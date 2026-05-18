import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { QuoteData } from "@/types";
import { generateCostWorkbook } from "@/lib/excel/generateCostSheet";

function buildQuoteData(): QuoteData {
  return {
    header: {
      writtenAt: "2026-05-18",
      validUntil: "2026-05-31",
    },
    items: [
      {
        id: "item-1",
        category: "SIGHTSEEING",
        region: "서울",
        date: "2026-06-01",
        description: "관광 입장료",
        quantity: 2,
        unitPrice: 10000,
        subtotal: 20000,
      },
    ],
    summary: {
      subtotal: 20000,
      groundProfit: 0,
      agencyFee: 2000,
      vat: 200,
      total: 22200,
    },
  };
}

describe("generateCostWorkbook", () => {
  it("embeds the red seal stamp image in the cost sheet footer", async () => {
    const workbook = await generateCostWorkbook(buildQuoteData(), {
      productName: "테스트 상품",
      bidCode: "TEST",
    });
    const zip = await JSZip.loadAsync(workbook);
    const sealImage = await readFile(path.join(process.cwd(), "public", "images", "seal-in.png"));
    const mediaFiles = Object.keys(zip.files).filter((name) => name.startsWith("xl/media/"));
    const mediaBuffers = await Promise.all(
      mediaFiles.map(async (name) => zip.file(name)?.async("nodebuffer"))
    );

    expect(mediaBuffers.some((buffer) => buffer ? buffer.equals(sealImage) : false)).toBe(true);
  });
});
