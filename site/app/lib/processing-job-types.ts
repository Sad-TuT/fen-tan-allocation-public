import type { AllocationPlan } from "./allocation";

export type ProcessingJobStatus = "draft" | "prepared" | "adopted" | "discarded";
export type ProcessingFileRole = "source" | "tax" | "tax-overrides" | "template" | "invoice" | "source-marked" | "source-remaining" | "audit";

export type ProcessingFile = {
  id: string;
  role: ProcessingFileRole;
  fileName: string;
  size: number;
  sha256: string;
  createdAt: string;
  sourceId?: string;
  priority?: number;
  sheetNames?: string[];
};

export type ProcessingSourceSummary = {
  id: string;
  name: string;
  priority: number;
  originalCents: number;
  availableCents: number;
  usedCents: number;
  rowCount: number;
  fileName: string;
  sha256: string;
};

export type ProcessingJobSummary = {
  id: string;
  status: ProcessingJobStatus;
  revision: number;
  product: string | null;
  totalCents: number | null;
  quantity: number | null;
  createdAt: string;
  updatedAt: string;
  parentJobId: string | null;
  sourceCount: number;
  fileCount: number;
};

export type ProcessingJob = ProcessingJobSummary & {
  priceCents: number | null;
  sources: ProcessingSourceSummary[];
  taxCount: number;
  taxFile: { name: string; sha256: string } | null;
  taxOverrideCount: number;
  taxOverrideFile: { name: string; sha256: string } | null;
  templateFile: { name: string; sha256: string } | null;
  files: ProcessingFile[];
  plan: AllocationPlan | null;
  planStale: boolean;
  taxPending: number;
  adoptedAt: string | null;
  adoptedBy: string | null;
  discardedAt: string | null;
  discardReason: string | null;
  warnings: string[];
};

export type ProcessingJobRequest =
  | { action: "create" }
  | { action: "paste-source"; id: string; revision: number; text: string; fileName?: string; sourceNumber: number; ackAvailableOnly: true }
  | { action: "simulate" | "prepare"; id: string; revision: number; product: string; price: string; quantity: number; assignments?: unknown }
  | { action: "adopt"; id: string; revision: number; ack: "I_REVIEWED_FILES"; fileHashes: Record<string, string> }
  | { action: "discard"; id: string; revision: number; reason: string }

export type ProcessingJobPreview = {
  file: ProcessingFile;
  sheets: string[];
  sheet: {
    name: string;
    totalRows: number;
    offset: number;
    limit: number;
    columns: { index: number; label: string }[];
    rows: { sourceRow: number; values: unknown[] }[];
  };
};
