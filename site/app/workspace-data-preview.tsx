"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowLeft, ArrowRight, FileSpreadsheet, LoaderCircle, Search, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ProcessingFile, ProcessingJobPreview } from "./lib/processing-job-types";

type VisibleData = { label: string; headers: string[]; rows: { sourceRow: number; values: (string | number | null)[] }[] };

function display(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && "formula" in value) {
    const calculated = "cached" in value ? value.cached : undefined;
    return calculated === null || calculated === undefined ? "公式未缓存" : display(calculated);
  }
  return JSON.stringify(value) ?? String(value);
}

function visibleCell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "object" && "formula" in value) {
    const cached = "cached" in value ? value.cached : undefined;
    return cached === null || cached === undefined ? "公式未缓存" : visibleCell(cached);
  }
  return display(value);
}

function displayTitle(value: unknown) {
  if (typeof value === "object" && value !== null && "formula" in value) {
    const formula = typeof value.formula === "string" ? value.formula : "";
    const cached = "cached" in value ? value.cached : undefined;
    return cached === null || cached === undefined ? `公式 ${formula} · 未缓存` : `公式 ${formula} · 缓存值 ${display(cached)}`;
  }
  return display(value);
}

export function WorkspaceDataPreview({
  jobId,
  files,
  selectedFileId,
  onSelectedFile,
  onAskAboutData,
  onContextChange,
  active = true,
}: {
  jobId: string;
  files: ProcessingFile[];
  selectedFileId?: string;
  onSelectedFile?: (fileId: string) => void;
  onAskAboutData?: (data: VisibleData) => void;
  onContextChange?: () => void;
  active?: boolean;
}) {
  const [uncontrolledFileId, setUncontrolledFileId] = useState("");
  const externalFileId = selectedFileId && files.some((file) => file.id === selectedFileId) ? selectedFileId : undefined;
  const localFileId = files.some((file) => file.id === uncontrolledFileId) ? uncontrolledFileId : undefined;
  const fileId = externalFileId ?? localFileId ?? files[0]?.id ?? "";
  const selectionKey = `${jobId}:${fileId}`;
  const [sheetState, setSheetState] = useState<{ key: string; value: string }>({ key: "", value: "" });
  const [offsetState, setOffsetState] = useState<{ key: string; value: number }>({ key: "", value: 0 });
  const sheetName = sheetState.key === selectionKey ? sheetState.value : "";
  const offset = offsetState.key === selectionKey ? offsetState.value : 0;
  function changeOffset(value: number | ((current: number) => number)) {
    const next = typeof value === "function" ? value(offset) : value;
    setOffsetState({ key: selectionKey, value: next });
  }
  const [search, setSearch] = useState("");
  const searchText = search.trim();
  const [debouncedSearch, setDebouncedSearch] = useState(searchText);
  const [resultState, setResultState] = useState<{ key: string; preview?: ProcessingJobPreview; error?: string } | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const limit = 50;
  const requestKey = JSON.stringify([jobId, fileId, sheetName, offset, debouncedSearch, retryNonce]);
  const hasCurrentResult = resultState?.key === requestKey;
  const preview = hasCurrentResult ? resultState.preview ?? null : null;
  const error = hasCurrentResult ? resultState.error ?? "" : "";
  const loading = active && Boolean(fileId) && !hasCurrentResult;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchText);
      setOffsetState({ key: selectionKey, value: 0 });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchText, selectionKey]);

  useEffect(() => {
    if (!active || !fileId) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ id: jobId, file: fileId, offset: String(offset), limit: String(limit) });
    if (sheetName) query.set("sheet", sheetName);
    if (debouncedSearch) query.set("search", debouncedSearch);
    async function readPreview() {
      try {
        let response: Response | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          response = await fetch(`/api/jobs?${query.toString()}`, { cache: "no-store", signal: controller.signal });
          if (response.status !== 429 || attempt > 0) break;
          const retryAfterSeconds = Number(response.headers.get("retry-after"));
          const waitMs = Number.isFinite(retryAfterSeconds) ? Math.min(30_000, Math.max(0, retryAfterSeconds * 1_000)) : 1_000;
          await new Promise<void>((resolve) => {
            if (controller.signal.aborted) { resolve(); return; }
            const timeout = window.setTimeout(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, waitMs);
            const abort = () => { window.clearTimeout(timeout); controller.signal.removeEventListener("abort", abort); resolve(); };
            controller.signal.addEventListener("abort", abort, { once: true });
          });
          if (controller.signal.aborted) return;
        }
        if (!response) throw new Error("读取文件内容失败。");
        const data = await response.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>;
        if (response.status === 401) { window.location.href = "/login"; throw new Error("登录已失效，请重新登录。"); }
        if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : response.status === 429 ? "文件查看繁忙，请稍后重试。" : "读取文件内容失败。");
        if (!controller.signal.aborted) setResultState({ key: requestKey, preview: data as ProcessingJobPreview });
      } catch (failure) {
        if (failure instanceof DOMException && failure.name === "AbortError") return;
        if (!controller.signal.aborted) setResultState({ key: requestKey, error: failure instanceof Error ? failure.message : "读取文件内容失败。" });
      }
    }
    void readPreview();
    return () => controller.abort();
  }, [active, jobId, fileId, sheetName, offset, debouncedSearch, requestKey]);

  const currentFile = useMemo(() => files.find((file) => file.id === fileId), [files, fileId]);
  const page = preview?.sheet;
  const visibleData = useMemo(() => {
    if (!page || !preview) return undefined;
    return {
      label: `${preview.file.fileName} · ${page.name}`,
      headers: page.columns.map((column) => column.label),
      rows: page.rows.map((row) => ({ sourceRow: row.sourceRow, values: (Array.isArray(row.values) ? row.values : []).map(visibleCell) })),
    } satisfies VisibleData;
  }, [page, preview]);

  if (!files.length) {
    return <div className="job-preview-empty"><FileSpreadsheet size={22} /><div><strong>还没有可浏览的文件</strong><p>上传资金来源、开票模板或生成本批结果后，可以在这里查看表格内容。</p></div></div>;
  }

  return <section className="job-preview" aria-label="表格预览">
    <div className="job-preview-toolbar">
      <label className="job-file-choice">
        <span className="sr-only">选择要查看的文件</span>
        <Select value={fileId} onValueChange={(next) => { if (onSelectedFile) onSelectedFile(next); else setUncontrolledFileId(next); onContextChange?.(); }}>
          <SelectTrigger aria-label="选择文件"><SelectValue placeholder="选择文件" /></SelectTrigger>
          <SelectContent>
            {files.map((file) => <SelectItem key={file.id} value={file.id}>{file.fileName}</SelectItem>)}
          </SelectContent>
        </Select>
      </label>
      {preview && preview.sheets.length > 1 && <label className="job-sheet-choice">
        <span className="sr-only">选择工作表</span>
        <Select value={preview.sheet.name} onValueChange={(next) => { setSheetState({ key: selectionKey, value: next }); changeOffset(0); onContextChange?.(); }}>
          <SelectTrigger aria-label="选择工作表"><SelectValue /></SelectTrigger>
          <SelectContent>{preview.sheets.map((sheet) => <SelectItem key={sheet} value={sheet}>{sheet}</SelectItem>)}</SelectContent>
        </Select>
      </label>}
      <div className="job-preview-spacer" />
      <label className="job-preview-search">
        <Search size={15} aria-hidden="true" />
        <span className="sr-only">在当前文件中搜索行</span>
        <Input type="search" value={search} onChange={(event) => { setSearch(event.target.value); onContextChange?.(); }} placeholder="搜索可见列…" maxLength={120} />
      </label>
      {currentFile && <Button variant="outline" size="sm" asChild>
        <a href={`/api/jobs?id=${encodeURIComponent(jobId)}&download=${encodeURIComponent(currentFile.id)}`}><ArrowDownToLine size={14} />下载</a>
      </Button>}
    </div>

    <div className="job-preview-meta">
      <span><FileSpreadsheet size={15} />{preview?.file.fileName ?? currentFile?.fileName}</span>
      {preview && <><Badge variant="outline">{preview.sheet.name}</Badge><span>第 {page!.totalRows ? page!.offset + 1 : 0}–{Math.min(page!.offset + page!.rows.length, page!.totalRows)} 行，共 {page!.totalRows.toLocaleString("zh-CN")} 行</span></>}
      {loading && <span className="job-preview-loading"><LoaderCircle size={14} className="animate-spin" />读取中</span>}
    </div>

    {error && <div className="job-preview-error" role="alert"><span>{error}</span><Button type="button" variant="outline" size="sm" onClick={() => setRetryNonce((current) => current + 1)}>重试读取</Button></div>}
    <div className="job-preview-table-outer" role="region" tabIndex={0} aria-label={preview ? `${preview.sheet.name}工作表，第 ${preview.sheet.totalRows} 行` : "工作表数据预览"} aria-busy={loading}>
      {preview && page && <table className="job-data-table">
        <thead><tr><th scope="col" className="job-row-index-head">行</th>{page.columns.map((column) => <th scope="col" key={`${column.index}-${column.label}`}>{column.label || `第 ${column.index + 1} 列`}</th>)}</tr></thead>
        <tbody>{page.rows.map((row) => <tr key={row.sourceRow}>
          <th scope="row" className="job-row-index">{row.sourceRow}</th>
          {(Array.isArray(row.values) ? row.values : []).map((value, index) => <td key={`${row.sourceRow}-${index}`} title={displayTitle(value)}>{display(value) || <span className="job-cell-empty">—</span>}</td>)}
        </tr>)}</tbody>
      </table>}
      {!loading && preview && !page?.rows.length && <div className="job-preview-no-rows">{debouncedSearch ? "没有符合搜索词的行。" : "这个工作表没有可显示的明细。"}</div>}
      {!preview && loading && <div className="job-preview-skeleton"><span /><span /><span /><span /></div>}
    </div>

    <div className="job-preview-footer">
      <span>显示服务端返回的当前页数据，不会执行或重算 Excel 公式。</span>
      <div className="job-preview-actions">
        {onAskAboutData && visibleData && <Button variant="ghost" size="sm" onClick={() => onAskAboutData(visibleData)}><Sparkles size={14} />选择这页给 AI</Button>}
        <Button variant="outline" size="sm" disabled={!page || loading || offset <= 0} onClick={() => { changeOffset((current) => Math.max(0, current - limit)); onContextChange?.(); }}><ArrowLeft size={14} />上一页</Button>
        <Button variant="outline" size="sm" disabled={!page || loading || offset + page.rows.length >= page.totalRows} onClick={() => { changeOffset((current) => current + limit); onContextChange?.(); }}>下一页<ArrowRight size={14} /></Button>
      </div>
    </div>
  </section>;
}

export type { VisibleData };
