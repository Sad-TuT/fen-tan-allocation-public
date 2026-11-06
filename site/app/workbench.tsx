"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { ArrowDownToLine, ArrowUpRight, Check, CircleAlert, CircleCheck, CircleHelp, ClipboardCheck, FileSpreadsheet, LoaderCircle, LockKeyhole, Plus, RefreshCw, Search, Settings2, Upload, X } from "lucide-react";
import { AiWorkspaceAssistant } from "./ai-panel";
import { WorkspaceDataPreview, type VisibleData } from "./workspace-data-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ALLOCATION_RULE_VERSION, type AllocationPlan } from "./lib/allocation";
import type { ProcessingJob, ProcessingJobRequest, ProcessingJobSummary } from "./lib/processing-job-types";

export type SessionUser = { id: string; name: string; email?: string; role: "admin" | "operator" | "viewer" };
type JobsResponse = { jobs: ProcessingJobSummary[]; summary: { total: number; draft: number; prepared: number; adopted: number; discarded: number } };
type JobResponse = { job: ProcessingJob; simulation?: AllocationPlan };
type View = "workspace" | "history" | "data";

const routeSubscribers = new Set<() => void>();
function subscribeToRoute(callback: () => void) {
  routeSubscribers.add(callback);
  window.addEventListener("popstate", callback);
  return () => { routeSubscribers.delete(callback); window.removeEventListener("popstate", callback); };
}
function routeSnapshot() { return `${window.location.pathname}${window.location.search}${window.location.hash}`; }
function serverRouteSnapshot() { return ""; }
function readRoute(snapshot: string): { jobId: string; view: View } {
  const url = new URL(snapshot || "/", "http://allocation.local");
  const view = url.searchParams.get("view");
  return { jobId: url.searchParams.get("job") ?? "", view: view === "history" || view === "data" ? view : "workspace" };
}
function writeRoute(jobId: string, view: View) {
  const params = new URLSearchParams(window.location.search);
  if (jobId) params.set("job", jobId); else params.delete("job");
  params.set("view", view);
  const query = params.toString();
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  routeSubscribers.forEach((callback) => callback());
}

const money = (cents: number | null | undefined) => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format((cents ?? 0) / 100);
const quantityFormat = (value: number | null | undefined) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value ?? 0);
const readableDate = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
const dateToday = () => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(new Date());

function statusInfo(status: ProcessingJob["status"]) {
  switch (status) {
    case "draft": return { label: "准备中", className: "job-state-draft" };
    case "prepared": return { label: "待人工核对", className: "job-state-prepared" };
    case "adopted": return { label: "已完成", className: "job-state-adopted" };
    case "discarded": return { label: "已作废", className: "job-state-discarded" };
  }
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = await response.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>;
  if (response.status === 401) {
    window.location.assign("/login");
    throw new Error("登录已失效，请重新登录。");
  }
  if (!response.ok || data?.error) throw Object.assign(new Error(typeof data?.error === "string" ? data.error : "操作未完成，请刷新后重试。"), { data });
  return data as T;
}

function actionRequest<T>(body: ProcessingJobRequest) {
  return apiRequest<T>("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function StepRail({ current }: { current: 1 | 2 | 3 | 4 }) {
  const steps = ["上传本批余额", "录入与试算", "预览候选文件", "确认本批完成"];
  return <ol className="job-steps" aria-label={`本批进度，第 ${current} 步，共 4 步`}>
    {steps.map((step, index) => {
      const number = index + 1;
      const done = number < current;
      const active = number === current;
      return <li key={step} className={`job-step ${done ? "is-done" : ""} ${active ? "is-active" : ""}`} aria-current={active ? "step" : undefined}>
        <span className="job-step-mark">{done ? <Check size={14} /> : number}</span>
        <span>{step}</span>
      </li>;
    })}
  </ol>;
}

function JobStatus({ status }: { status: ProcessingJob["status"] }) {
  const item = statusInfo(status);
  const Icon = status === "adopted" ? CircleCheck : status === "discarded" ? X : status === "prepared" ? ClipboardCheck : CircleHelp;
  return <Badge variant="outline" className={`job-status ${item.className}`}><Icon size={14} />{item.label}</Badge>;
}

function usesCurrentRules(job: ProcessingJob): boolean {
  return !job.plan || job.plan.ruleVersion === ALLOCATION_RULE_VERSION;
}

function SourceAllocationChart({ plan, onSourceClick }: { plan: AllocationPlan; onSourceClick?: (sourceId: string) => void }) {
  return <section className="job-source-chart" aria-labelledby="allocation-chart-title">
    <div className="job-chart-heading"><div><h3 id="allocation-chart-title">本批资金分配</h3><p>来源原始余额 → 本批使用 → 本批剩余；选择来源可查看原始记录。</p></div><span className="job-chart-key"><i />本批使用 <i className="key-remaining" />本批剩余</span></div>
    <div className="job-chart-list">
      {plan.sourceSummaries.map((source) => {
        const total = Math.max(0, source.usedCents + source.remainingCents);
        const percent = total === 0 ? 0 : Math.max(0, Math.min(100, source.usedCents / total * 100));
        return <button type="button" className="job-source-chart-row" key={source.sourceId} onClick={() => onSourceClick?.(source.sourceId)}>
          <span className="job-source-name"><b>{source.priority}</b><strong title={source.name}>{source.name}</strong></span>
          <span className="job-source-track" role="img" aria-label={`${source.name}：本批使用 ${money(source.usedCents)}，本批后余款 ${money(source.remainingCents)}`}>
            <span className="job-source-used" style={{ width: `${percent}%` }} />
          </span>
          <span className="job-source-values"><strong>{money(source.usedCents)}</strong><span>余 {money(source.remainingCents)}</span></span>
        </button>;
      })}
    </div>
    <div className="job-source-ledger"><span>本批分摊</span><strong className="numeric">{money(plan.totalCents)}</strong><span>共 {quantityFormat(plan.quantity)} 件</span><span>原余额 {money(plan.availableCents)}</span></div>
  </section>;
}

function AllocationRows({ plan }: { plan: AllocationPlan }) {
  const [page, setPage] = useState(0);
  const pageSize = 50;
  const pageCount = Math.max(1, Math.ceil(plan.groups.length / pageSize));
  const visible = plan.groups.slice(page * pageSize, (page + 1) * pageSize);
  return <section className="job-allocation-rows" aria-labelledby="allocation-rows-title">
    <div className="job-section-heading"><div><h3 id="allocation-rows-title">分摊分组</h3><p>按已确认规则精确计算，金额以分为单位保存。</p></div><span>{plan.groups.length.toLocaleString("zh-CN")} 组</span></div>
    <div className="job-table-scroll" role="region" tabIndex={0} aria-label="分摊分组表格，可横向滚动"><Table className="job-allocation-table"><TableHeader><TableRow><TableHead>申领人</TableHead><TableHead>申领部门</TableHead><TableHead>使用中心</TableHead><TableHead>成本中心</TableHead><TableHead>费用承担法律主体</TableHead><TableHead>申领用途</TableHead><TableHead className="text-right">数量</TableHead><TableHead className="text-right">使用金额</TableHead><TableHead className="text-right">组内余款</TableHead></TableRow></TableHeader>
      <TableBody>{visible.map((group) => <TableRow key={group.key}><TableCell className="font-medium">{group.applicant}</TableCell><TableCell>{group.department || <span className="muted">空白</span>}</TableCell><TableCell>{group.useCenter || <span className="muted">空白</span>}</TableCell><TableCell>{group.costCenter}</TableCell><TableCell>{group.legalEntity}</TableCell><TableCell>{group.purpose}</TableCell><TableCell className="text-right numeric">{quantityFormat(group.quantity)}</TableCell><TableCell className="text-right numeric">{money(group.usedCents)}</TableCell><TableCell className="text-right numeric">{money(group.remainderCents)}</TableCell></TableRow>)}</TableBody>
    </Table></div>
    {plan.groups.length > pageSize && <div className="job-group-pages"><span>显示第 {page * pageSize + 1}–{Math.min((page + 1) * pageSize, plan.groups.length)} 组，共 {plan.groups.length.toLocaleString("zh-CN")} 组</span><div><Button type="button" variant="outline" size="sm" disabled={page <= 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>上一页</Button><Button type="button" variant="outline" size="sm" disabled={page + 1 >= pageCount} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}>下一页</Button></div></div>}
  </section>;
}

function FileImport({
  job, disabled, onUploaded,
}: { job: ProcessingJob; disabled: boolean; onUploaded: (job: ProcessingJob) => void }) {
  const [priorityOverride, setPriorityOverride] = useState("");
  const [busyFile, setBusyFile] = useState("");
  const [error, setError] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteAck, setPasteAck] = useState(false);
  const priority = priorityOverride || String(Math.max(0, ...job.sources.map((source) => source.priority)) + 1);

  async function upload(role: "source" | "tax" | "tax-overrides" | "template", file: File | undefined) {
    if (!file) return;
    setError("");
    const isOverrides = role === "tax-overrides";
    if (!(isOverrides ? file.name.toLowerCase().endsWith(".json") : file.name.toLowerCase().endsWith(".xlsx")) || file.size > (isOverrides ? 1024 * 1024 : 10 * 1024 * 1024)) {
      setError(isOverrides ? "请选择不超过 1 MB 的 .json 文件。" : "请选择不超过 10 MB 的 .xlsx 文件。");
      return;
    }
    const label = role === "source" ? "本批资金" : role === "tax" ? "税务资料" : role === "tax-overrides" ? "税务修正" : "开票模板";
    const form = new FormData();
    form.set("action", "upload"); form.set("id", job.id); form.set("revision", String(job.revision)); form.set("role", role); form.set("file", file);
    if (role === "source") form.set("priority", priority);
    setBusyFile(role);
    try {
      const result = await apiRequest<JobResponse>("/api/jobs", { method: "POST", body: form });
      if (role === "source") setPriorityOverride("");
      onUploaded(result.job);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `${label}上传失败。`);
    } finally { setBusyFile(""); }
  }

  async function importPastedSource() {
    setError("");
    if (!pasteAck) { setError("请确认粘贴内容仅包括已核实未使用的剩余资金明细。"); return; }
    if (!pasteText.trim()) { setError("请粘贴包含表头与明细的Excel数据。"); return; }
    if (new TextEncoder().encode(pasteText).byteLength > 1024 * 1024) { setError("粘贴内容不能超过 1 MB，请减少明细行数。"); return; }
    setBusyFile("paste");
    try {
      const result = await actionRequest<JobResponse>({ action: "paste-source", id: job.id, revision: job.revision, text: pasteText, priority: Number(priority), ackAvailableOnly: true });
      setPriorityOverride(""); onUploaded(result.job); setPasteText(""); setPasteAck(false); setPasteOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "未能读取粘贴的表格内容。");
    } finally { setBusyFile(""); }
  }

  const inputFile = (role: "source" | "tax" | "tax-overrides" | "template", label: string, current: string | null) => <label className={`job-upload-control ${current ? "has-file" : ""}`}>
    <span className="job-upload-icon">{busyFile === role ? <LoaderCircle size={17} className="animate-spin" /> : current ? <Check size={17} /> : <Upload size={17} />}</span>
    <span className="job-upload-text"><strong>{current || label}</strong><small>{current ? "已上传，可选择新文件替换" : role === "tax-overrides" ? "上传 .json，最大 1 MB" : "上传 Excel 文件，最大 10 MB"}</small></span>
    <span className="job-upload-action">{busyFile === role ? "正在读取" : current ? "替换" : "选择文件"}</span>
    <input aria-label={current ? `替换${label}` : label} type="file" accept={role === "tax-overrides" ? ".json,application/json" : ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"} disabled={disabled || !!busyFile} onChange={(event) => { void upload(role, event.target.files?.[0]); event.currentTarget.value = ""; }} />
  </label>;

  return <div className="job-import">
    <div className="job-import-heading"><div><h2>本批余额与资料</h2><p>每个新批次都必须重新上传余额表。这里是本批唯一的资金来源。</p></div>{job.sourceCount > 0 && <Badge variant="outline" className="job-count-badge">{job.sourceCount} 份资金来源</Badge>}</div>
    <div className="job-upload-list">
      <div className="job-upload-with-priority">{inputFile("source", `添加第 ${priority} 顺位余额表`, null)}<Button className="job-source-paste-option" type="button" variant="outline" size="sm" disabled={disabled || !!busyFile} onClick={() => setPasteOpen(true)}>粘贴Excel明细</Button><label className="job-source-priority"><span>来源顺序</span><Input aria-label="资金来源顺序" type="number" min="1" max="100" value={priority} onChange={(event) => setPriorityOverride(event.target.value)} disabled={disabled || !!busyFile} /></label></div>
      {job.sources.map((source) => <div className="job-current-source" key={source.id}><span className="source-index">{source.priority}</span><span className="job-current-source-copy"><strong title={source.name}>{source.name}</strong><small>{source.rowCount.toLocaleString("zh-CN")} 行 · 本批可用 {money(source.availableCents)}</small></span><span className="job-current-source-balance">{money(source.availableCents)}</span></div>)}
      {inputFile("tax", "税务主体表（可选）", job.taxFile?.name ?? null)}
      {inputFile("tax-overrides", "税务修正 JSON（可选）", job.taxOverrideFile?.name ?? null)}
      {inputFile("template", "开票模板（必需）", job.templateFile?.name ?? null)}
    </div>
    {error && <p className="job-inline-error" role="alert"><CircleAlert size={16} />{error}</p>}
    <div className="job-upload-note"><LockKeyhole size={15} /><p>本批余额只属于这一批。下一批请重新上传本批生成的剩余表。</p></div>
    <Dialog open={pasteOpen} onOpenChange={(open) => { setPasteOpen(open); if (!open) { setPasteAck(false); setError(""); } }}><DialogContent className="job-paste-dialog"><DialogHeader><DialogTitle>粘贴本批剩余资金明细</DialogTitle><DialogDescription>从Excel复制含表头的单元格区域，再粘贴到下方。文本上限 1 MB。</DialogDescription></DialogHeader>
      <pre className="job-paste-example" aria-label="支持的Excel表头示例">申领人　申领部门　使用中心　成本中心　成本　费用承担法律主体　申领用途</pre>
      <label className="job-paste-input"><span>Excel单元格数据</span><textarea value={pasteText} maxLength={1024 * 1024} rows={9} disabled={!!busyFile} onChange={(event) => setPasteText(event.target.value)} placeholder="在此按 Ctrl+V 粘贴表头与明细" /> <small>复制Excel单元格后，用 Ctrl+V 粘贴；保持各列对应的分隔。</small></label>
      <div className="job-paste-loss"><CircleAlert size={16} /><p>文本粘贴不包含单元格颜色、条件格式、隐藏状态或历史使用标记。红字状态可能丢失。</p></div>
      <label className="job-paste-ack"><input type="checkbox" checked={pasteAck} onChange={(event) => setPasteAck(event.target.checked)} /><span>我确认粘贴的是已核实未使用的剩余资金明细，不包含历史红字金额、标题或合计行。</span></label>
      <DialogFooter><Button type="button" variant="outline" disabled={!!busyFile} onClick={() => setPasteOpen(false)}>返回检查</Button><Button type="button" disabled={!pasteAck || !pasteText.trim() || !!busyFile} onClick={() => void importPastedSource()}>{busyFile === "paste" ? <LoaderCircle size={15} className="animate-spin" /> : <Upload size={15} />}{busyFile === "paste" ? "正在读取…" : "作为本批资金导入"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}

function EmptyWork({ onCreate, existing, onResume, disabled }: { onCreate: () => void; existing?: ProcessingJobSummary; onResume: () => void; disabled: boolean }) {
  return <div className="job-welcome">
    <div className="job-welcome-main"><span className="job-welcome-mark"><FileSpreadsheet size={21} /></span><h2>上传本批余额开始</h2><p>每个新批次都重新上传余额表；上传后填写商品信息并精确试算。</p><Button onClick={onCreate} disabled={disabled}><Plus size={17} />开始新批次</Button></div>
    {existing && <div className="job-resume"><div><span>最近打开</span><strong>{existing.product || "未命名批次"}</strong><small>更新于 {readableDate(existing.updatedAt)}</small></div><JobStatus status={existing.status} /><Button variant="outline" onClick={onResume}>继续处理<ArrowUpRight size={15} /></Button></div>}
      <div className="job-welcome-steps"><span>上传本批余额</span><i aria-hidden="true" /><span>填写本批商品</span><i aria-hidden="true" /><span>生成结果文件</span><i aria-hidden="true" /><span>确认本批完成</span></div>
  </div>;
}

function JobTable({ jobs, selectedId, onOpen }: { jobs: ProcessingJobSummary[]; selectedId: string; onOpen: (id: string) => void }) {
  if (!jobs.length) return <div className="job-history-empty"><FileSpreadsheet size={22} /><strong>还没有批次</strong><p>新建一次处理后，上传的余额、候选文件和完成状态会保存在这里。</p></div>;
  return <div className="job-table-scroll"><Table className="job-history-table"><TableHeader><TableRow><TableHead>批次</TableHead><TableHead>输入来源</TableHead><TableHead className="text-right">目标金额</TableHead><TableHead className="text-right">数量</TableHead><TableHead>状态</TableHead><TableHead>最后更新</TableHead><TableHead /></TableRow></TableHeader><TableBody>{jobs.map((job) => <TableRow key={job.id} data-selected={selectedId === job.id}>
    <TableCell><button type="button" className="job-history-open" onClick={() => onOpen(job.id)}><strong>{job.product || "未填写商品"}</strong><small>{job.id.slice(0, 8)}</small></button></TableCell>
    <TableCell>{job.sourceCount} 份 · {job.fileCount} 个文件</TableCell><TableCell className="text-right numeric">{job.totalCents === null ? "—" : money(job.totalCents)}</TableCell><TableCell className="text-right numeric">{job.quantity === null ? "—" : quantityFormat(job.quantity)}</TableCell><TableCell><JobStatus status={job.status} /></TableCell><TableCell className="muted">{readableDate(job.updatedAt)}</TableCell><TableCell className="text-right"><Button type="button" variant="ghost" size="sm" onClick={() => onOpen(job.id)}>{selectedId === job.id ? "已打开" : "打开批次"}</Button></TableCell>
  </TableRow>)}</TableBody></Table></div>;
}

function HistoryView({ jobs, selectedId, query, onQuery, onOpen }: { jobs: ProcessingJobSummary[]; selectedId: string; query: string; onQuery: (value: string) => void; onOpen: (id: string) => void }) {
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase("zh-CN"));
  const filtered = useMemo(() => jobs.filter((job) => `${job.product ?? ""} ${job.id}`.toLocaleLowerCase("zh-CN").includes(deferredQuery)), [jobs, deferredQuery]);
  return <section className="job-content-view" aria-labelledby="job-history-heading">
    <div className="job-page-heading"><div><span className="job-page-kicker">批次记录</span><h1 id="job-history-heading">处理历史</h1><p>按批查找上传的余额、候选文件和完成状态。</p></div>
      <label className="job-search"><Search size={16} /><span className="sr-only">搜索批次</span><Input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索商品名称或批次号" /></label>
    </div>
    <JobTable jobs={filtered} selectedId={selectedId} onOpen={onOpen} />
    <p className="job-readonly-note">历史记录用于查阅批次关系。作废记录会保留，便于追踪余额来源。</p>
  </section>;
}

function DataView({ jobs, job, onSelectJob }: { jobs: ProcessingJobSummary[]; job: ProcessingJob | null; onSelectJob: (jobId: string) => void }) {
  const files = job?.files ?? [];
  return <section className="job-content-view" aria-labelledby="job-data-heading">
    <div className="job-page-heading"><div><span className="job-page-kicker">文件浏览</span><h1 id="job-data-heading">表格数据</h1><p>按批次选择文件，直接查看可搜索的 Excel 明细和生成结果。</p></div>
      {jobs.length > 0 && <label className="job-history-select"><span className="sr-only">选择批次</span><select aria-label="选择批次" value={job?.id ?? ""} onChange={(event) => onSelectJob(event.target.value)}>{jobs.map((item) => <option key={item.id} value={item.id}>{item.product || "未命名批次"} · {item.id.slice(0, 8)}</option>)}</select></label>}
    </div>
    {!job ? <div className="job-history-empty"><FileSpreadsheet size={22} /><strong>没有可浏览的批次</strong><p>上传表格后，它会出现在这里。可以分页查看行数据，不会执行工作簿公式。</p></div> : files.length > 0 ? <WorkspaceDataPreview key={job.id} jobId={job.id} files={files} /> : <div className="job-history-empty"><FileSpreadsheet size={22} /><strong>本批还没有文件</strong><p>上传原始资料后，可查看工作表名称、列名与行号。</p></div>}
    {job && files.length > 0 && <p className="job-readonly-note">来源文件保持原样。生成文件供本批核对，不会自动改变另一份余额表。</p>}
  </section>;
}

export default function Dashboard({ user, onOpenAccount }: { user: SessionUser; onOpenAccount: () => void }) {
  const locationSnapshot = useSyncExternalStore(subscribeToRoute, routeSnapshot, serverRouteSnapshot);
  const { jobId: selectedId, view } = useMemo(() => readRoute(locationSnapshot), [locationSnapshot]);
  const [jobs, setJobs] = useState<ProcessingJobSummary[]>([]);
  const [summary, setSummary] = useState<JobsResponse["summary"]>({ total: 0, draft: 0, prepared: 0, adopted: 0, discarded: 0 });
  const [job, setJob] = useState<ProcessingJob | null>(null);
  const [jobsReady, setJobsReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const canWrite = user.role !== "viewer";

  const refreshJobs = useCallback(async () => {
    const result = await apiRequest<JobsResponse>("/api/jobs");
    setJobs(result.jobs);
    setSummary(result.summary);
    return result.jobs;
  }, []);
  const openJob = useCallback(async (id: string, targetView: View = "workspace") => {
    const result = await apiRequest<JobResponse>(`/api/jobs?id=${encodeURIComponent(id)}`);
    setJob(result.job); writeRoute(result.job.id, targetView); setLoadError("");
    return result.job;
  }, []);

  const pageLoading = !jobsReady || (!!selectedId && job?.id !== selectedId);

  useEffect(() => {
    let active = true;
    fetch("/api/jobs", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>;
        if (response.status === 401) { window.location.assign("/login"); throw new Error("登录已失效，请重新登录。"); }
        if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "读取批次失败。");
        return data as JobsResponse;
      })
      .then((result) => { if (active) { setJobs(result.jobs); setSummary(result.summary); } })
      .catch((failure: unknown) => { if (active) setLoadError(failure instanceof Error ? failure.message : "读取批次列表失败。"); })
      .finally(() => { if (active) setJobsReady(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    const controller = new AbortController();
    fetch(`/api/jobs?id=${encodeURIComponent(selectedId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>;
        if (response.status === 401) { window.location.assign("/login"); throw new Error("登录已失效，请重新登录。"); }
        if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "无法读取当前批次。");
        return data as JobResponse;
      })
      .then((result) => { if (active) { setJob(result.job); setLoadError(""); } })
      .catch((failure: unknown) => { if (active && !(failure instanceof DOMException && failure.name === "AbortError")) setLoadError(failure instanceof Error ? failure.message : "无法读取当前批次。"); });
    return () => { active = false; controller.abort(); };
  }, [selectedId]);

  async function createJob() {
    if (!canWrite || creating) return;
    setCreating(true); setLoadError("");
    try {
      const result = await actionRequest<JobResponse>({ action: "create" });
      setJob(result.job); writeRoute(result.job.id, "workspace");
      await refreshJobs();
    } catch (error) { setLoadError(error instanceof Error ? error.message : "无法新建批次，请重试。"); }
    finally { setCreating(false); }
  }

  function selectJob(id: string, targetView: View = "workspace") {
    setLoadError("");
    if (!id) { setJob(null); writeRoute("", targetView); return; }
    if (job?.id === id) writeRoute(id, targetView);
    else void openJob(id, targetView).catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "无法读取所选批次。"));
  }

  function updateJob(next: ProcessingJob) {
    setJob(next);
    void refreshJobs().catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "批次已保存，但列表刷新失败。"));
  }

  const latestResumable = useMemo(() => jobs.find((item) => item.status === "draft" || item.status === "prepared"), [jobs]);
  const activeViewName = view === "workspace" ? "本批工作区" : view === "history" ? "批次记录" : "表格数据";

  return <div className="job-app-shell">
    <a className="job-skip-link" href="#job-main">跳到当前工作区</a>
    <header className="job-app-header"><div className="job-app-header-inner">
      <button type="button" className="job-brand" aria-label="返回本批工作区" onClick={() => writeRoute(selectedId, "workspace")}><span className="job-brand-icon"><FileSpreadsheet size={19} /></span><span><strong>分摊</strong><small>Allocation workspace</small></span></button>
      <nav className="job-main-nav" aria-label="主导航">{([ ["workspace", "本批工作区"], ["history", "批次记录"], ["data", "表格数据"] ] as [View, string][]).map(([id, label]) => <button type="button" key={id} className={view === id ? "is-current" : ""} aria-current={view === id ? "page" : undefined} onClick={() => writeRoute(selectedId, id)}>{label}{id === "history" && summary.total > 0 && <span>{summary.total}</span>}</button>)}</nav>
      <div className="job-user-menu"><span className="job-user-avatar" aria-hidden="true">{user.name.slice(0, 1)}</span><span><strong>{user.name}</strong><small>{user.role === "admin" ? "管理员" : user.role === "operator" ? "操作员" : "只读"}</small></span><button type="button" className="job-account-shortcut" aria-label="账户设置" title="账户设置" onClick={onOpenAccount}><Settings2 size={16} /></button></div>
    </div></header>

    <main id="job-main" className="job-main-content" tabIndex={-1}>
      <div className="job-topline"><span>{activeViewName}</span><time>{dateToday()}</time></div>
      {loadError && <div className="job-page-error" role="alert"><CircleAlert size={17} /><span>{loadError}</span><Button type="button" size="sm" variant="outline" onClick={() => { void refreshJobs().catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "读取批次失败。")); }}>重新读取</Button></div>}
      {pageLoading && !job && view === "workspace" && <div className="job-loading"><LoaderCircle className="animate-spin" size={19} />正在读取批次</div>}
      {job && <div className="job-workspace-preserve" hidden={view !== "workspace"}><BatchWorkspace
        key={job.id}
        job={job}
        userId={user.id}
        active={view === "workspace"}
        canWrite={canWrite}
        onJobUpdate={updateJob}
        onNewBatch={() => { setJob(null); writeRoute("", "workspace"); }}
        onChooseJob={() => writeRoute(job.id, "history")}
      /></div>}
      {!job && view === "workspace" && !pageLoading && <EmptyWork onCreate={() => void createJob()} existing={latestResumable} onResume={() => latestResumable && void selectJob(latestResumable.id)} disabled={!canWrite || creating || pageLoading} />}
      {view === "history" && <HistoryView jobs={jobs} selectedId={selectedId} query={query} onQuery={setQuery} onOpen={(id) => selectJob(id)} />}
      {view === "data" && <DataView jobs={jobs} job={job?.id === selectedId ? job : null} onSelectJob={(id) => selectJob(id, "data")} />}
      <footer className="job-app-footer"><span>分摊 · Allocation</span><span>每批重新上传余额 · 候选结果可核 · 完成由你确认</span></footer>
    </main>
  </div>;
}

function BatchWorkspace({ job, userId, active, canWrite, onJobUpdate, onNewBatch, onChooseJob }: { job: ProcessingJob; userId: string; active: boolean; canWrite: boolean; onJobUpdate: (job: ProcessingJob) => void; onNewBatch: () => void; onChooseJob: () => void }) {
  const [product, setProduct] = useState(job.product ?? "");
  const [price, setPrice] = useState(job.priceCents === null ? "" : (job.priceCents / 100).toFixed(2));
  const [quantity, setQuantity] = useState(job.quantity === null ? "" : String(job.quantity));
  const [simulation, setSimulation] = useState<AllocationPlan | null>(job.plan);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [adoptConfirmed, setAdoptConfirmed] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardReason, setDiscardReason] = useState("本批人工核对后决定不再继续");
  const [visibleData, setVisibleData] = useState<VisibleData | undefined>();
  const [selectedFile, setSelectedFile] = useState("");
  const mutable = canWrite && job.status === "draft";
  const currentRuleVersion = usesCurrentRules(job);
  const files = job.files;
  const sourceFiles = files.filter((file) => file.role === "source");
  const resultFiles = files.filter((file) => file.role === "invoice" || file.role === "source-marked" || file.role === "source-remaining" || file.role === "audit");
  const finishedPlan = simulation ?? job.plan;
  const step: 1 | 2 | 3 | 4 = job.status === "adopted" || job.status === "discarded" ? 4 : job.status === "prepared" ? 3 : job.sourceCount > 0 ? 2 : 1;
  const taskTotalCents = useMemo(() => {
    if (!/^\d+(\.\d{1,2})?$/.test(price) || !/^\d+$/.test(quantity)) return 0;
    const [dollars, fraction = ""] = price.split(".");
    const cents = (BigInt(dollars) * BigInt(100) + BigInt(fraction.padEnd(2, "0"))) * BigInt(quantity);
    return cents > BigInt(0) && cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : 0;
  }, [price, quantity]);
  const canSimulate = mutable && product.trim().length > 0 && taskTotalCents > 0 && job.sources.length > 0 && !busy;

  async function operation<T extends JobResponse>(action: string, body: ProcessingJobRequest | FormData): Promise<T> {
    setBusy(action); setError("");
    try {
      const result = body instanceof FormData
        ? await apiRequest<T>("/api/jobs", { method: "POST", body })
        : await actionRequest<T>(body as ProcessingJobRequest);
      onJobUpdate(result.job);
      return result;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "操作未完成，请重试。");
      throw failure;
    } finally { setBusy(""); }
  }

  async function runSimulation(event: FormEvent) {
    event.preventDefault();
    if (!canSimulate) return;
    try {
      const result = await operation<JobResponse & { simulation?: AllocationPlan }>("simulate", { action: "simulate", id: job.id, revision: job.revision, product: product.trim(), price, quantity: Number(quantity) });
      setSimulation(result.simulation ?? result.job.plan);
    } catch {
      setSimulation(null);
    }
  }

  async function prepare() {
    if (!job.templateFile) { setError("请先上传开票模板，再生成候选文件。"); return; }
    if (!simulation || !canWrite || job.status !== "draft") return;
    if (!usesCurrentRules({ ...job, plan: simulation })) { setError("分摊规则已更新，请按当前规则重新试算后再生成文件。"); setSimulation(null); return; }
    try {
      const result = await operation<JobResponse & { simulation?: AllocationPlan }>("prepare", { action: "prepare", id: job.id, revision: job.revision, product: product.trim(), price, quantity: Number(quantity) });
      setSimulation(result.job.plan ?? result.simulation ?? simulation);
    } catch { /* error is shown at the top of the work area */ }
  }

  async function adopt() {
    if (!adoptConfirmed || !canWrite || job.status !== "prepared") return;
    try {
      const fileHashes = Object.fromEntries(resultFiles.map((file) => [file.id, file.sha256]));
      await operation("adopt", { action: "adopt", id: job.id, revision: job.revision, ack: "I_REVIEWED_FILES", fileHashes });
      setAdoptConfirmed(false);
    } catch { /* error is shown in the work area */ }
  }

  async function discard() {
    if (!discardReason.trim() || !canWrite || job.status === "adopted" || job.status === "discarded") return;
    try {
      await operation("discard", { action: "discard", id: job.id, revision: job.revision, reason: discardReason.trim() });
      setDiscardOpen(false);
    } catch { /* keep the confirmation open for correction */ }
  }

  async function refresh() {
    if (busy) return;
    setBusy("refresh"); setError("");
    try { const result = await apiRequest<JobResponse>(`/api/jobs?id=${encodeURIComponent(job.id)}`); onJobUpdate(result.job); setSimulation(result.job.plan); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "刷新失败，请重试。"); }
    finally { setBusy(""); }
  }

  const sourceIndex = useMemo(() => new Map(sourceFiles.map((file) => [file.sourceId, file.id])), [sourceFiles]);
  const browseSource = (sourceId: string) => {
    const fileId = sourceIndex.get(sourceId);
    if (fileId) { setSelectedFile(fileId); document.getElementById("job-source-files")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" }); }
  };

  return <section className="job-batch" aria-labelledby="job-batch-title">
      <div className="job-batch-heading"><div><div className="job-batch-title-row"><span className="job-page-kicker">新批次 · 本次上传余额</span><JobStatus status={job.status} /><span className="job-revision">版本 {job.revision}</span></div><h1 id="job-batch-title">{job.product || "填写本批商品"}</h1><p>批次 {job.id.slice(0, 8)} · 更新于 {readableDate(job.updatedAt)}</p></div><div className="job-batch-quick-actions"><Button type="button" variant="outline" size="sm" disabled={!!busy} onClick={() => void refresh()}><RefreshCw size={14} className={busy === "refresh" ? "animate-spin" : ""} />刷新</Button><Button type="button" variant="ghost" size="sm" disabled={!!busy} onClick={onNewBatch}><Plus size={15} />新批次</Button></div></div>

    <StepRail current={step} />
    {error && <div className="job-page-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}
    {job.warnings.map((warning, index) => <div className="job-page-warning" key={`${warning}-${index}`}><CircleAlert size={17} /><span>{warning}</span></div>)}
    {!currentRuleVersion && job.plan && <div className="job-page-warning" role="status"><CircleAlert size={17} /><span>这批候选由旧分组规则生成，只能查阅。请从原始资金文件新建一批，用当前规则重新试算后再确认完成。</span></div>}

    <div className="job-layout">
      <div className="job-primary-column">
        <FileImport job={job} disabled={!mutable || !!busy} onUploaded={(next) => { setSimulation(null); onJobUpdate(next); }} />

        <section className="job-parameters" aria-labelledby="job-parameters-heading">
          <div className="job-section-heading"><div><h2 id="job-parameters-heading">本批商品</h2><p>AI 可以整理一句话里的参数；金额仍由分摊引擎精确计算。</p></div>{finishedPlan && <Badge variant="outline" className="job-param-plan-badge"><CircleCheck size={13} />已有试算</Badge>}</div>
          <form onSubmit={runSimulation} className="job-product-form">
            <div className="job-input-field"><Label htmlFor={`job-product-${job.id}`}>本批商品名称</Label><Input id={`job-product-${job.id}`} value={product} onChange={(event) => { setProduct(event.target.value); setSimulation(null); }} maxLength={80} placeholder="请输入本批商品" disabled={!mutable || !!busy} /></div>
            <div className="job-input-field"><Label htmlFor={`job-price-${job.id}`}>本批单价（元）</Label><Input id={`job-price-${job.id}`} inputMode="decimal" value={price} onChange={(event) => { setPrice(event.target.value); setSimulation(null); }} maxLength={16} placeholder="0.00" disabled={!mutable || !!busy} /></div>
            <div className="job-input-field"><Label htmlFor={`job-quantity-${job.id}`}>本批数量</Label><Input id={`job-quantity-${job.id}`} inputMode="numeric" value={quantity} onChange={(event) => { setQuantity(event.target.value.replace(/\D/g, "")); setSimulation(null); }} maxLength={9} placeholder="0" disabled={!mutable || !!busy} /></div>
            <div className="job-product-actions"><span>{taskTotalCents > 0 ? `目标总额 ${money(taskTotalCents)}` : "请输入商品、单价和数量"}</span><Button type="submit" disabled={!canSimulate}>{busy === "simulate" ? <LoaderCircle size={16} className="animate-spin" /> : <Check size={16} />}{busy === "simulate" ? "正在精确试算…" : finishedPlan ? "重新试算" : "精确试算"}</Button></div>
          </form>
          {finishedPlan && <div className="job-plan-result" id="job-plan-result">
            <div className="job-plan-summary"><span>试算结果</span><strong className="numeric">{money(finishedPlan.totalCents)}</strong><span>{quantityFormat(finishedPlan.quantity)} 件 · {finishedPlan.groups.length} 个费用分组</span><span className="job-plan-note"><LockKeyhole size={13} />试算不扣减已用资金</span></div>
            <SourceAllocationChart plan={finishedPlan} onSourceClick={browseSource} />
            <AllocationRows plan={finishedPlan} />
            {mutable && <div className="job-prepare-bar"><div><strong>生成候选文件</strong><span>{job.templateFile ? "文件写入本批记录，需人工核对后确认完成。" : "上传开票模板后即可生成候选文件。"}</span></div><Button type="button" onClick={() => void prepare()} disabled={!simulation || !job.templateFile || !!busy}>{busy === "prepare" ? <LoaderCircle size={16} className="animate-spin" /> : <FileSpreadsheet size={16} />}{busy === "prepare" ? "正在生成…" : "生成候选文件"}</Button></div>}
          </div>}
        </section>

        {files.length > 0 && <section className="job-source-browser" id="job-source-files" aria-labelledby="job-source-files-heading">
          <div className="job-section-heading"><div><h2 id="job-source-files-heading">本批文件数据</h2><p>原始资料与结果都可以逐行查看；支持搜索和分页。</p></div><span>{files.length} 个文件</span></div>
          <WorkspaceDataPreview key={job.id} jobId={job.id} files={files} active={active} selectedFileId={selectedFile || files.find((file) => file.role === "source")?.id} onSelectedFile={(fileId) => { setSelectedFile(fileId); setVisibleData(undefined); }} onAskAboutData={(data) => setVisibleData(data)} onContextChange={() => setVisibleData(undefined)} />
        </section>}
      </div>

      <aside className="job-ai-column" aria-label="AI 助手">
        <AiWorkspaceAssistant
          jobId={job.id}
          jobStatus={job.status}
          userId={userId}
          contextLabel={job.product || `批次 ${job.id.slice(0, 8)}`}
          disabled={job.status === "discarded"}
          canApplyDraft={job.status === "draft" && canWrite}
          onApplyDraft={(draft) => { setProduct(draft.product); setPrice(draft.price); setQuantity(String(draft.quantity)); setSimulation(null); document.getElementById(`job-parameters-heading`)?.scrollIntoView({ behavior: "smooth", block: "center" }); }}
          visibleData={visibleData}
        />
      </aside>
    </div>

    {(job.status === "prepared" || job.status === "adopted") && <section className="job-candidate" aria-labelledby="job-candidate-heading">
      <div className="job-section-heading"><div><h2 id="job-candidate-heading">候选结果</h2><p>{job.status === "adopted" ? "本批已完成核对并归档。下一批需要重新上传余额表。" : "先浏览并核对本批所有文件，再确认本批是否完成。"}</p></div><JobStatus status={job.status} /></div>
      <div className="job-candidate-files">{resultFiles.map((file) => <a key={file.id} className="job-candidate-file" href={`/api/jobs?id=${encodeURIComponent(job.id)}&download=${encodeURIComponent(file.id)}`}><span className="job-candidate-file-icon"><FileSpreadsheet size={17} /></span><span><strong>{file.fileName}</strong><small>{file.role === "invoice" ? "开票单" : file.role === "source-marked" ? `来源标红表${file.priority ? ` · 优先级 ${file.priority}` : ""}` : file.role === "source-remaining" ? `本批后剩余表${file.priority ? ` · 优先级 ${file.priority}` : ""}` : "分摊核对记录"} · {(file.size / 1024).toFixed(1)} KB</small></span><ArrowDownToLine size={16} /></a>)}</div>
      {job.taxPending > 0 && <p className="job-tax-warning"><CircleAlert size={16} />{job.taxPending} 项开票资料待核实。请查看开票单后再确认本批是否完成。</p>}
      {job.status === "prepared" && canWrite && currentRuleVersion && <div className="job-adopt-panel">
        <label className="job-adopt-confirm"><input type="checkbox" checked={adoptConfirmed} onChange={(event) => setAdoptConfirmed(event.target.checked)} /><span>我已核对上方全部结果文件，确认本批处理完成。</span></label>
        <div className="job-adopt-actions"><p><LockKeyhole size={14} />确认后只归档本批，不会保存或自动带入下一批余额。</p><Button type="button" disabled={!adoptConfirmed || !!busy} onClick={() => void adopt()}>{busy === "adopt" ? <LoaderCircle size={16} className="animate-spin" /> : <Check size={16} />}{busy === "adopt" ? "正在记录…" : "确认本批完成"}</Button></div>
      </div>}
      {job.status === "adopted" && <div className="job-adopted-footer"><span><CircleCheck size={16} />已由 {job.adoptedBy || "操作人"} 于 {job.adoptedAt ? readableDate(job.adoptedAt) : "—"} 确认完成</span><Button type="button" variant="outline" onClick={() => void onChooseJob()}><ArrowUpRight size={15} />查看历史记录</Button><Button type="button" onClick={onNewBatch}><Plus size={15} />新批次（需重新上传余额）</Button></div>}
    </section>}

    {job.status === "draft" && canWrite && job.sourceCount > 0 && <div className="job-discard-line"><button type="button" onClick={() => setDiscardOpen(true)} disabled={!!busy}>作废本批</button><span>只改变此批状态，不会更改上传文件。</span></div>}
    {job.status === "discarded" && <div className="job-discarded-note"><X size={16} /><span>本批已作废。{job.discardReason ? `原因：${job.discardReason}` : "原始文件仍可查阅。"}</span></div>}

    <Dialog open={discardOpen} onOpenChange={setDiscardOpen}><DialogContent className="job-discard-dialog"><DialogHeader><DialogTitle>作废本批处理？</DialogTitle><DialogDescription>本批候选结果不会作为下一批余额。原始输入和处理记录会保留。</DialogDescription></DialogHeader><div className="job-input-field"><Label htmlFor={`discard-reason-${job.id}`}>作废原因</Label><Input id={`discard-reason-${job.id}`} value={discardReason} onChange={(event) => setDiscardReason(event.target.value)} maxLength={300} /></div><DialogFooter><Button type="button" variant="outline" onClick={() => setDiscardOpen(false)}>继续编辑本批</Button><Button type="button" variant="destructive" disabled={!discardReason.trim() || !!busy} onClick={() => void discard()}>{busy === "discard" ? <LoaderCircle size={16} className="animate-spin" /> : <X size={16} />}确认作废</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}

export { JobTable, JobStatus, money, readableDate };
