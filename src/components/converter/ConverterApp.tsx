"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { EditorShell } from "@/app/(popup)/editor/popup/EditorShell";
import { AccessGate } from "@/components/converter/AccessGate";
import { Role } from "@/types";

export function ConverterApp() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AccessGate>
        <div className="hub-app min-w-[1280px] text-foreground">
          <EditorShell role={Role.AGENT} />
        </div>
      </AccessGate>
    </QueryClientProvider>
  );
}
