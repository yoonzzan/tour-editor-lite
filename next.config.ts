import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve("."),
  outputFileTracingIncludes: {
    "/api/itinerary/parse": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"],
  },
  serverExternalPackages: ["pdf-parse", "@napi-rs/canvas"],
  // 팝업 에디터 전용 — 별도 origin 허용은 ALLOWED_PARENT_ORIGINS env 로 관리
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "X-Content-Type-Options", value: "nosniff" }],
      },
    ];
  },
};

export default nextConfig;
