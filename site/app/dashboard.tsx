"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronRight, CircleAlert, CircleCheck, ClipboardCheck, Coins, Copy, FileClock, FileSpreadsheet, FolderOpen, Landmark, LayoutDashboard, LoaderCircle, LogOut, Menu, Plus, ReceiptText, RefreshCw, Search, ShieldCheck, Sparkles, Upload, WalletCards, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { AllocationPlan, AllocationGroup, DepartmentAssignment } from "./lib/allocation";
import AccountPanel from "./account-panel";
import { AiDraftAssistant, AiPrecheck, AiAsk } from "./ai-panel";

type View = "overview" | "new" | "ai" | "sources" | "tax" | "history" | "rules" | "account";
type User = { name: string; email: string; id: string; role: "admin" | "operator" | "viewer" };
type Source = { id: string; name: string; priority: number; originalCents: number; availableCents: number; usedCents: number; rowCount: number; fileName: string; history: { batchId: string; product: string; usedCents: number }[] };
type BatchSummary = { id: string; product: string; createdAt: string; versionAtCreation: number; status: string; totalCents: number; quantity: number; passedReviews: number; isStale?: boolean };
type Workspace = { version: number; user: User; sources: Source[]; taxCount: number; taxFile: { name: string; sha256: string } | null; productHistory: { batchId: string; product: string }[]; batches: BatchSummary[] };
type Review = { reviewerId: string; reviewerRunId: string; status: string; summary?: string; issues: string[]; unverified: string[]; reviewDigest: string };
type InvoiceRow = AllocationGroup & { targetRow: number; tax: { mode: string; text: string; reason: string } };
type Batch = { id: string; product: string; status: string; createdAt: string; versionAtCreation: number; reviews?: Review[]; data: { plan: AllocationPlan; invoiceRows: InvoiceRow[]; manifest: { name: string; role: string; sha256: string }[]; taxPending: number; folderName: string; reviewDigest: string } };
type Simulation = { version: number; plan: AllocationPlan; priceCents: number; product: string; assignments: DepartmentAssignment[] };
type Ambiguity = { sourceId: string; rowId: string; originalFile: string; originalRow: number; amountCents: number; applicant: string; costCenter: string; legalEntity: string; purpose: string; department: string; useCenter: string; candidates: {department: string; useCenter: string}[] };
type Flash = { kind: "error" | "success"; title: string; message?: string } | null;

const NAV: { id: View; title: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", title: "工作台", icon: LayoutDashboard },
  { id: "new", title: "新建分摊", icon: Plus },
  { id: "ai", title: "账簿问答", icon: Sparkles },
  { id: "sources", title: "金额来源", icon: WalletCards },
  { id: "tax", title: "税务资料", icon: Landmark },
  { id: "history", title: "历史批次", icon: FolderOpen },
];
const DESCRIPTIONS: Record<View, string> = {
  overview: "查看共享余额与批次进度，接续每一笔分摊。",
  new: "填写商品信息，先精确试算，再生成待核验文件。",
  ai: "基于当前来源余额与最近批次回答账目疑问。",
  sources: "保留每份来源的身份、优先级与累计使用记录。",
  tax: "统一管理开票资料，按法律主体名称和代码精确匹配。",
  history: "查询分摊结果、核验记录与余额承接关系。",
  rules: "沿用已确认的业务规则，让每个批次有据可查。",
  account: "管理个人密码和账号权限。",
};
const money = (cents: number) => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
const number = (n: number) => new Intl.NumberFormat("zh-CN").format(n);
const date = (value: string) => Number.isNaN(new Date(value).getTime()) ? "—" : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
const completed = (status: string) => status === "completed" || status === "completed_with_tax_pending";
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请核实资料后重试。";
class RequestError extends Error {
  constructor(message: string, public data: any) { super(message); }
}

async function request(body: Record<string, unknown> | FormData) {
  const multipart = body instanceof FormData;
  const response = await fetch("/api/workspace", { method: "POST", headers: multipart ? undefined : { "content-type": "application/json" }, body: multipart ? body : JSON.stringify(body) });
  if (response.status === 401) { window.location.assign("/login"); throw new Error("登录已失效，请重新登录。"); }
  let data: any;
  try { data = await response.json(); } catch { throw new Error("无法读取服务器结果，请刷新页面并检查登录状态。"); }
  if (!response.ok || data?.error) throw new RequestError(data?.error || "操作未完成。", data);
  return data;
}

function Status({ status, stale = false }: { status: string; stale?: boolean }) {
  if (stale) return <Badge className="status-badge status-muted">待重新试算</Badge>;
  if (status === "completed_with_tax_pending") return <Badge className="status-badge status-amber">已入账 · 税务待补</Badge>;
  if (status === "completed") return <Badge className="status-badge status-green"><CircleCheck size={12} />已完成</Badge>;
  return <Badge className="status-badge status-blue"><FileClock size={12} />待双agent核验</Badge>;
}
function Empty({ icon: Icon = FolderOpen, title, description, action }: { icon?: typeof FolderOpen; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={25} strokeWidth={1.5} /></div><h3>{title}</h3><p>{description}</p>{action}</div>;
}
function GroupTable({ plan }: { plan: AllocationPlan }) {
  return <Table className="detail-table"><TableHeader><TableRow>{["申领人", "申领部门", "使用中心", "成本中心", "费用承担法律主体", "申领用途"].map((name) => <TableHead key={name}>{name}</TableHead>)}<TableHead className="text-right">数量</TableHead><TableHead className="text-right">使用金额</TableHead><TableHead className="text-right">组内余款</TableHead></TableRow></TableHeader><TableBody>{plan.groups.map((group) => <TableRow key={group.key}><TableCell className="font-medium">{group.applicant}</TableCell><TableCell className="wrap-cell">{group.department || <span className="muted">空白</span>}</TableCell><TableCell className="wrap-cell">{group.useCenter}</TableCell><TableCell className="wrap-cell">{group.costCenter}</TableCell><TableCell className="wrap-cell legal-cell">{group.legalEntity}</TableCell><TableCell className="wrap-cell">{group.purpose}</TableCell><TableCell className="text-right numeric">{number(group.quantity)}</TableCell><TableCell className="text-right numeric font-medium">{money(group.usedCents)}</TableCell><TableCell className="text-right numeric">{money(group.remainderCents)}</TableCell></TableRow>)}</TableBody></Table>;
}
function SourcePlanTable({ plan }: { plan: AllocationPlan }) {
  return <Table><TableHeader><TableRow><TableHead>金额来源</TableHead>{["原总额", "此前已用", "本批使用", "本批后余额", "累计已用", "核对差额"].map((name) => <TableHead className="text-right" key={name}>{name}</TableHead>)}</TableRow></TableHeader><TableBody>{plan.sourceSummaries.map((source) => <TableRow key={source.sourceId}><TableCell className="font-medium">{source.name}</TableCell>{[source.originalCents, source.previousUsedCents, source.usedCents, source.remainingCents, source.cumulativeUsedCents].map((value, index) => <TableCell key={index} className={`text-right numeric ${index === 2 ? "accent-text" : ""}`}>{money(value)}</TableCell>)}<TableCell className={`text-right numeric ${source.differenceCents === 0 ? "green-text" : "error-text"}`}>{money(source.differenceCents)}</TableCell></TableRow>)}</TableBody></Table>;
}

export default function Dashboard({ user }: { user: User }) {
  const [view, setView] = useState<View>("overview");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [busy, setBusy] = useState("");
  const [flash, setFlash] = useState<Flash>(null);
  const [today, setToday] = useState("");
  const [query, setQuery] = useState("");
  const [product, setProduct] = useState("");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [template, setTemplate] = useState<File | null>(null);
  const [templateKey, setTemplateKey] = useState(0);
  const [simulation, setSimulation] = useState<Simulation | null>(null);
  const [ambiguities, setAmbiguities] = useState<Ambiguity[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [confirmedAssignments, setConfirmedAssignments] = useState<DepartmentAssignment[]>([]);
  const [assignmentVersion, setAssignmentVersion] = useState<number | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceFileKey, setSourceFileKey] = useState(0);
  const [sourcePriority, setSourcePriority] = useState("1");
  const [sourceHistory, setSourceHistory] = useState("");
  const [sourceConfirmed, setSourceConfirmed] = useState(false);
  const [taxFile, setTaxFile] = useState<File | null>(null);
  const [taxFileKey, setTaxFileKey] = useState(0);
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [selectedSource, setSelectedSource] = useState<Source | null>(null);
  const [reviewPrompt, setReviewPrompt] = useState("");

  const refresh = useCallback(async () => {
    const response = await fetch("/api/workspace", { cache: "no-store" });
    if (response.status === 401) { window.location.assign("/login"); throw new Error("登录已失效，请重新登录。"); }
    let data: any;
    try { data = await response.json(); } catch { throw new Error("账簿暂时无法读取，请刷新并检查登录状态。"); }
    if (!response.ok || data?.error) throw new Error(data?.error || "账簿读取失败。");
    setWorkspace(data as Workspace); return data as Workspace;
  }, []);
  useEffect(() => {
    refresh().catch((error) => setFlash({ kind: "error", title: "未能读取共享账簿", message: errorText(error) }));
    setToday(new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric" }).format(new Date()));
  }, [refresh]);
  useEffect(() => {
    if (!workspace) return;
    setSourcePriority(String(Math.max(0, ...workspace.sources.map((source) => source.priority)) + 1));
    setSourceHistory(workspace.productHistory.map((entry) => entry.product).join("／"));
  }, [workspace]);
  useEffect(() => {
    if (workspace && assignmentVersion !== null && workspace.version !== assignmentVersion) {
      setSimulation(null); setAmbiguities([]); setChoices({}); setConfirmedAssignments([]); setAssignmentVersion(null);
    }
  }, [workspace, assignmentVersion]);

  const sources = workspace?.sources || [];
  const batches = workspace?.batches || [];
  const available = sources.reduce((sum, source) => sum + source.availableCents, 0);
  const used = sources.reduce((sum, source) => sum + source.usedCents, 0);
  const pendingCount = batches.filter((batch) => !completed(batch.status) && !batch.isStale).length;
  const filteredBatches = batches.filter((batch) => `${batch.product} ${batch.id}`.toLowerCase().includes(query.toLowerCase()));
  const currentTitle = view === "account" ? (user.role === "admin" ? "账号管理" : "修改密码") : view === "rules" ? "分摊规则" : NAV.find((item) => item.id === view)?.title || "工作台";
  const estimatedTotal = useMemo(() => {
    if (!/^\d+(\.\d{1,2})?$/.test(price) || !/^\d+$/.test(quantity)) return null;
    const [yuan, cents = ""] = price.split(".");
    const total = (BigInt(yuan) * BigInt(100) + BigInt(cents.padEnd(2, "0"))) * BigInt(quantity);
    return total > BigInt(0) && total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
  }, [price, quantity]);
  const sourceDifference = selectedSource ? selectedSource.originalCents - selectedSource.availableCents - selectedSource.usedCents : 0;
  const canWrite = user.role !== "viewer";
  const canTrial = canWrite && !!product.trim() && !!estimatedTotal && sources.length > 0 && !busy;
  const reports = selectedBatch?.reviews || [];
  const selectedStale = selectedBatch?.status === "awaiting_review" && selectedBatch.versionAtCreation !== workspace?.version;
  const selectedOldRule = selectedBatch?.status === "awaiting_review" && selectedBatch.data.plan.ruleVersion !== "department-compat-v2";
  const passed = reports.filter((report) => report.status === "passed" && !report.issues?.length && !report.unverified?.length && report.reviewDigest === selectedBatch?.data.reviewDigest);
  const canCommit = canWrite && selectedBatch?.status === "awaiting_review" && !selectedStale && !selectedOldRule && reports.length === 2 && passed.length === 2 && passed[0].reviewerId !== passed[1].reviewerId && passed[0].reviewerRunId !== passed[1].reviewerRunId;

  function go(next: View) { setView(next); setMobileMenuOpen(false); }
  async function perform(label: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setFlash(null);
    try { await action(); } catch (error) { setFlash({ kind: "error", title: "需要核实后再继续", message: errorText(error) }); }
    finally { setBusy(""); }
  }
  function checkFile(file: File | null) {
    if (!file || !file.name.toLowerCase().endsWith(".xlsx") || file.size > 10 * 1024 * 1024) throw new Error("请选择不超过10MB的.xlsx文件。");
    return file;
  }
  async function showBatch(id: string) {
    await perform("batch", async () => {
      const batch = await request({ action: "batch", id });
      if (!batch) throw new Error("批次不存在。");
      setSelectedBatch(batch); setReviewPrompt(""); setBatchOpen(true); await refresh();
    });
  }
  const assignmentKey = (sourceId: string, rowId: string) => JSON.stringify([sourceId, rowId]);
  function clearTrial() { setSimulation(null); setAmbiguities([]); setChoices({}); setConfirmedAssignments([]); setAssignmentVersion(null); }
  async function runTrial(version: number, nextAssignments: DepartmentAssignment[]) {
    try {
      const result = await request({ action: "simulate", product: product.trim(), price, quantity: Number(quantity), version, assignments: nextAssignments });
      setSimulation({ ...result, assignments: nextAssignments }); setAmbiguities([]); setChoices({}); setConfirmedAssignments(nextAssignments); setAssignmentVersion(version); await refresh();
      setFlash({ kind: "success", title: "精确试算完成", message: `已找到${result.plan.groups.length}个可行分组。试算尚未扣减余额。` });
    } catch (error) {
      if (!(error instanceof RequestError) || error.data?.code !== "AMBIGUOUS_ASSIGNMENT" || !Array.isArray(error.data.ambiguities) || !error.data.ambiguities.length) throw error;
      setSimulation(null); setConfirmedAssignments(nextAssignments); setAssignmentVersion(version); setChoices({}); setAmbiguities(error.data.ambiguities);
      setFlash({ kind: "error", title: "需要确认部门归属", message: "请逐项选择兼容的部门组合后继续试算；这些选择不会立即扣减余额。" });
    }
  }
  async function trial(event: FormEvent) {
    event.preventDefault();
    await perform("simulate", async () => {
      if (!canWrite) throw new Error("当前账号仅可查看，不能进行试算。");
      if (!workspace) throw new Error("请先读取当前余额版本。");
      clearTrial(); await runTrial(workspace.version, []);
    });
  }
  async function resolveAmbiguities() {
    await perform("simulate", async () => {
      if (assignmentVersion === null || assignmentVersion !== workspace?.version) { clearTrial(); throw new Error("余额版本已变化，请重新试算并确认归属。"); }
      const combined = new Map(confirmedAssignments.map(a => [assignmentKey(a.sourceId, a.rowId), a]));
      for (const item of ambiguities) {
        const choice = choices[assignmentKey(item.sourceId, item.rowId)];
        if (choice === undefined || choice === "") throw new Error("请逐项选择归属后继续。");
        const index = Number(choice); const candidate = item.candidates[index];
        if (!Number.isSafeInteger(index) || !candidate) throw new Error("部门归属选择无效，请重新试算。");
        combined.set(assignmentKey(item.sourceId, item.rowId), {sourceId:item.sourceId, rowId:item.rowId, department:candidate.department, useCenter:candidate.useCenter});
      }
      await runTrial(assignmentVersion, [...combined.values()]);
    });
  }
  async function prepare() {
    await perform("prepare", async () => {
      if (!canWrite) throw new Error("当前账号仅可查看，不能生成分摊文件。");
      if (!simulation) throw new Error("请先完成本批试算。");
      const body = new FormData(); body.set("action", "prepare"); body.set("version", String(simulation.version)); body.set("file", checkFile(template));
      body.set("product", simulation.product); body.set("price", price); body.set("quantity", quantity); body.set("assignments", JSON.stringify(simulation.assignments));
      const result = await request(body);
      setSelectedBatch(result); setReviewPrompt(""); setBatchOpen(true); setSimulation(null); setTemplate(null); setTemplateKey((key) => key + 1); await refresh();
      setFlash({ kind: "success", title: "待核验文件已生成", message: "请交给Codex启动两个独立agent核验。正式入账前，当前余额保持不变。" });
    });
  }
  async function uploadSource(event: FormEvent) {
    event.preventDefault();
    await perform("source", async () => {
      if (!canWrite) throw new Error("当前账号仅可查看，不能导入金额。");
      if (!workspace || !sourceConfirmed) throw new Error("请确认来源与历史商品清单后再导入。");
      const body = new FormData(); body.set("action", "source"); body.set("version", String(workspace.version)); body.set("file", checkFile(sourceFile)); body.set("priority", sourcePriority); body.set("history", sourceHistory);
      await request(body); await refresh(); setSourceFile(null); setSourceFileKey((key) => key + 1); setSourceConfirmed(false); clearTrial();
      setFlash({ kind: "success", title: "金额来源已导入", message: "共享账簿已更新，可以填写商品信息并开始试算。" });
    });
  }
  async function uploadTax(event: FormEvent) {
    event.preventDefault();
    await perform("tax", async () => {
      if (!canWrite) throw new Error("当前账号仅可查看，不能上传税务资料。");
      if (!workspace) throw new Error("请先读取共享账簿。");
      const body = new FormData(); body.set("action", "tax"); body.set("version", String(workspace.version)); body.set("file", checkFile(taxFile));
      await request(body); await refresh(); setTaxFile(null); setTaxFileKey((key) => key + 1); clearTrial();
      setFlash({ kind: "success", title: "税务资料已更新", message: "后续批次将使用这份资料。已有待入账批次请重新生成并核验。" });
    });
  }
  async function commit() {
    if (!selectedBatch || !canCommit) return;
    await perform("commit", async () => {
      await request({ action: "commit", id: selectedBatch.id });
      setSelectedBatch(await request({ action: "batch", id: selectedBatch.id })); await refresh();
      setFlash({ kind: "success", title: "正式入账完成", message: "各来源实际用额已登记，剩余金额已接续为下一批余额。" });
    });
  }
  async function copyReviewPrompt() {
    if (!selectedBatch) return;
    const text = `请对网站 ${window.location.origin} 的批次 ${selectedBatch.id} 通过受控复核通道取得核验资料。启动两个独立子agent，并行读取原始输入、完整组成员及全部最终Excel，分别核对申领人和其余必填信息、部门空值兼容与人工确认的行归属、金额、数量、合并组余款、来源使用与余额、行拆分和顶部累计对账，核对税务及输出文件。两名agent各自产生报告，通过受控通道提交；不得预设通过或用同一脚本重复运行代替独立核验。出现问题先问我。两份核验完成后告知我，由我在网站确认正式入账，不要自动扣减余额。`;
    setReviewPrompt(text);
    try { await navigator.clipboard.writeText(text); setFlash({ kind: "success", title: "核验指令已复制", message: "返回Codex粘贴发送，即可启动两个独立agent。" }); }
    catch { setFlash({ kind: "error", title: "浏览器未允许自动复制", message: "可在批次详情下方选中核验指令，手动复制到Codex。" }); }
  }
  async function logout() { try { const response = await fetch("/api/app-auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); if (!response.ok) throw new Error("退出失败，请重试。"); window.location.assign("/login"); } catch (error) { setFlash({ kind: "error", title: "退出失败", message: errorText(error) }); } }
  function batchTable(items: BatchSummary[], compact = false) {
    return items.length ? <Table className="batch-table"><TableHeader><TableRow><TableHead>商品 / 批次</TableHead><TableHead className="text-right">分摊金额</TableHead>{!compact && <TableHead className="text-right">数量</TableHead>}<TableHead>状态</TableHead><TableHead>创建时间</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{items.map((batch) => <TableRow key={batch.id}><TableCell><div className="batch-product"><span className="table-product-icon"><ReceiptText size={17} /></span><span><strong>{batch.product}</strong><small>{batch.id.slice(0, 8)}</small></span></div></TableCell><TableCell className="text-right numeric font-medium">{money(batch.totalCents)}</TableCell>{!compact && <TableCell className="text-right numeric">{number(batch.quantity)}</TableCell>}<TableCell><Status status={batch.status} stale={batch.isStale} /></TableCell><TableCell className="muted text-xs">{date(batch.createdAt)}</TableCell><TableCell className="text-right"><Button variant="ghost" size="sm" disabled={!!busy} onClick={() => showBatch(batch.id)}>查看<ChevronRight size={14} /></Button></TableCell></TableRow>)}</TableBody></Table> : <Empty icon={FileClock} title={query ? "没有找到匹配的批次" : "还没有分摊批次"} description={query ? "尝试商品名称或批次编号。" : "完成来源导入后，创建第一笔分摊。"} action={!query && <Button variant="outline" size="sm" onClick={() => go(sources.length ? "new" : "sources")}>{sources.length ? "新建分摊" : "导入金额来源"}<ArrowRight size={14} /></Button>} />;
  }

  return <div className="app-shell">
    <header className="workspace-header">
      <div className="workspace-header-inner">
        <Button variant="ghost" className="brand" onClick={() => go("overview")} aria-label="分摊工作台"><strong>分摊</strong><span>Allocation</span></Button>
        <nav className="desktop-nav" aria-label="主导航">{[...NAV, { id: "rules" as View, title: "分摊规则", icon: BookOpen }].map(({ id, title }) => <Button key={id} variant="ghost" className={`nav-link ${view === id ? "active" : ""}`} onClick={() => go(id)} aria-current={view === id ? "page" : undefined}><span>{title}</span>{id === "history" && pendingCount > 0 && <span className="nav-count">{pendingCount}</span>}</Button>)}</nav>
        <div className="desktop-account"><span className="avatar">{Array.from(workspace?.user.name || user.name || "用")[0]}</span><span className="desktop-user-name" title={workspace?.user.email || user.email}>{workspace?.user.name || user.name}</span><Button variant="ghost" size="sm" onClick={() => go("account")}>{user.role === "admin" ? "账号管理" : "修改密码"}</Button><Button variant="ghost" size="icon-sm" onClick={logout} aria-label="退出登录" title="退出登录"><LogOut size={16} /></Button></div>
        <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <SheetTrigger asChild><Button variant="outline" size="sm" className="mobile-menu-trigger" aria-label="打开导航菜单"><Menu size={17} />菜单</Button></SheetTrigger>
          <SheetContent side="left" showCloseButton={false} className="mobile-navigation-sheet">
            <SheetHeader><div className="mobile-sheet-heading"><SheetTitle>分摊</SheetTitle><SheetClose asChild><Button variant="ghost" size="icon-sm" aria-label="关闭导航菜单"><X size={18} /></Button></SheetClose></div><SheetDescription>共享分摊账簿</SheetDescription></SheetHeader>
            <nav className="mobile-nav-links" aria-label="移动端主导航">{[...NAV, { id: "rules" as View, title: "分摊规则", icon: BookOpen }, { id: "account" as View, title: user.role === "admin" ? "账号管理" : "修改密码", icon: ShieldCheck }].map(({ id, title, icon: Icon }) => <Button key={id} variant="ghost" className={`nav-link ${view === id ? "active" : ""}`} aria-current={view === id ? "page" : undefined} onClick={() => go(id)}><Icon size={19} /><span>{title}</span>{id === "history" && pendingCount > 0 && <span className="nav-count">{pendingCount}</span>}</Button>)}</nav>
            <SheetFooter className="mobile-sheet-footer"><div className="mobile-identity"><span className="avatar">{Array.from(workspace?.user.name || user.name || "用")[0]}</span><div><strong>{workspace?.user.name || user.name}</strong><small>{workspace?.user.email || user.email}</small></div></div><Button variant="outline" onClick={logout}><LogOut size={16} />退出登录</Button></SheetFooter>
          </SheetContent>
        </Sheet>
      </div>
    </header>
    <div className="shell-main">
      <header className="topbar"><div className="breadcrumb"><span>费用分摊</span><ChevronRight size={13} /><strong>{currentTitle}</strong></div><div className="topbar-right"><span className="today">{today}</span><span className="topbar-divider" /><span className="sync-label">余额版本 {workspace?.version ?? "—"}</span><Button variant="ghost" size="icon-sm" aria-label="刷新账簿" disabled={!!busy} onClick={() => perform("refresh", async () => { await refresh(); })}><RefreshCw size={16} className={busy === "refresh" ? "animate-spin" : ""} /></Button></div></header>
      <main className="main-content">
        <div className="page-heading"><div><h1>{currentTitle}</h1><p>{DESCRIPTIONS[view]}</p></div>{view !== "new" && view !== "account" && canWrite && <Button size="lg" onClick={() => go("new")}><Plus size={17} />新建分摊</Button>}</div>
        {flash && <Alert variant={flash.kind === "error" ? "destructive" : "default"} className={`flash-message ${flash.kind === "success" ? "flash-success" : ""}`}>{flash.kind === "error" ? <CircleAlert /> : <CircleCheck />}<AlertTitle>{flash.title}</AlertTitle>{flash.message && <AlertDescription>{flash.message}</AlertDescription>}<Button variant="ghost" size="icon-xs" className="flash-close" aria-label="关闭提示" onClick={() => setFlash(null)}><X size={13} /></Button></Alert>}
        {!workspace && !flash && <div className="loading-line"><LoaderCircle className="animate-spin" size={17} />正在读取共享账簿…</div>}

        {!canWrite && <p className="field-note">当前账号为仅查看权限，可以查看及下载记录。</p>}
        {view === "account" && <AccountPanel role={user.role} userId={user.id} />}
        {view === "overview" && <>
          <section className="stats-grid" aria-label="账簿概览">
            <Card className="stat-card primary-stat"><CardContent><div className="stat-label"><WalletCards size={16} />剩余余额</div><div className="stat-value numeric">{workspace ? money(available) : "—"}</div><div className="stat-foot"><span className="live-dot" />{sources.length ? `${sources.length}个来源 · ${number(sources.reduce((sum, source) => sum + source.rowCount, 0))}条未用记录` : "等待导入金额来源"}</div></CardContent></Card>
            <Card className="stat-card"><CardContent><div className="stat-label">累计已用金额<Coins size={16} /></div><div className="stat-value numeric">{workspace ? money(used) : "—"}</div><div className="stat-foot">含来源表中承接的历史使用额</div></CardContent></Card>
            <Card className="stat-card"><CardContent><div className="stat-label">已完成批次<ClipboardCheck size={16} /></div><div className="stat-value numeric">{workspace ? number(batches.filter((batch) => completed(batch.status)).length) : "—"}<small>批</small></div><div className="stat-foot">本工作空间已正式入账</div></CardContent></Card>
            <Card className="stat-card"><CardContent><div className="stat-label">待核验批次<FileClock size={16} /></div><div className="stat-value numeric">{workspace ? number(pendingCount) : "—"}<small>批</small></div><div className="stat-foot">核验完成前不扣减余额</div></CardContent></Card>
          </section>
          <Card className="start-card"><CardContent><div className="start-copy"><h2>{sources.length ? "开始下一批产品分摊" : "建立你的第一份分摊账簿"}</h2><p>{sources.length ? "自动沿用当前余额。填写商品参数，精确试算后生成开票资料。" : "导入金额来源与税务资料，保留每个批次的使用记录和剩余金额。"}</p><Button onClick={() => go(sources.length ? "new" : "sources")}>{sources.length ? "填写商品信息" : "导入金额来源"}<ArrowRight size={16} /></Button></div><div className="start-process"><div><span className={sources.length ? "done" : ""}>{sources.length ? <Check size={16} /> : "01"}</span><strong>金额来源</strong><small>逐源保留身份与余额</small></div><i /><div><span>02</span><strong>精确分摊</strong><small>金额与数量逐项核对</small></div><i /><div><span>03</span><strong>核验入账</strong><small>双agent独立复核</small></div></div></CardContent></Card>
          <div className="overview-columns"><div className="overview-primary"><Card className="table-card"><CardHeader className="inline-card-header"><div><CardTitle>最近批次</CardTitle><CardDescription>查看生成、核验与入账进度</CardDescription></div><Button variant="ghost" size="sm" onClick={() => go("history")}>全部批次<ArrowUpRight size={15} /></Button></CardHeader><CardContent>{batchTable(batches.slice(0, 5), true)}</CardContent></Card>
            <Card className="sources-overview"><CardHeader className="inline-card-header"><div><CardTitle>来源余额</CardTitle><CardDescription>按既定顺序优先使用</CardDescription></div><Button variant="ghost" size="sm" onClick={() => go("sources")}>管理来源<ChevronRight size={14} /></Button></CardHeader><CardContent>{sources.length ? sources.map((source) => <div className="source-balance-row" key={source.id}><span className="source-order">{String(source.priority).padStart(2, "0")}</span><div><strong>{source.name}</strong><small>{number(source.rowCount)}条剩余记录</small></div><span className="numeric">{money(source.availableCents)}</span></div>) : <div className="quiet-empty"><WalletCards size={18} />导入金额表后，在这里查看各来源余额。</div>}</CardContent></Card>
          </div><div className="overview-secondary"><Card className="ledger-card"><CardHeader><CardTitle>账簿状态</CardTitle><CardDescription>确认资料和余额承接情况</CardDescription></CardHeader><CardContent><div className="check-row"><span><WalletCards size={16} />金额来源</span><Badge className={sources.length ? "status-green" : "status-muted"}>{sources.length ? `${sources.length}份已导入` : "待导入"}</Badge></div><div className="check-row"><span><Landmark size={16} />税务主体</span><strong className="numeric">{workspace ? number(workspace.taxCount) : "—"}<small>家</small></strong></div><div className="check-row"><span><ShieldCheck size={16} />正式入账要求</span><span className="plain-status">双agent通过</span></div><div className="ledger-equation"><span>每个来源独立核对</span><p>原总额 = 剩余金额 + 累计已用</p></div><Button variant="outline" className="full-width" onClick={() => go("rules")}>查看完整规则<ArrowRight size={14} /></Button></CardContent></Card><div className="small-guidance"><ReceiptText size={20} strokeWidth={1.5} /><h3>每批结果，完整留档</h3><p>两个来源对应六份Excel。文件夹末尾累计标注已分摊商品，下一批自动接续剩余金额。</p></div></div></div>
        </>}

        {view === "new" && <>
          {!sources.length && <Alert className="soft-notice"><CircleAlert /><AlertTitle>先导入金额来源</AlertTitle><AlertDescription>新批次默认使用共享账簿的当前余额。<Button variant="link" size="sm" onClick={() => go("sources")}>去导入<ArrowRight size={14} /></Button></AlertDescription></Alert>}
          {canWrite && <AiDraftAssistant disabled={!sources.length || !!busy} onApply={(draft) => {
            setProduct(draft.product);
            setPrice(draft.price);
            setQuantity(String(draft.quantity));
            clearTrial();
          }} />}
          <div className="new-grid"><Card className="form-card"><CardHeader><CardTitle>商品信息</CardTitle><CardDescription>总额由单价与数量精确计算</CardDescription></CardHeader><CardContent><form onSubmit={trial} className="form-stack"><div className="field"><Label htmlFor="product">商品名称</Label><Input id="product" disabled={!!busy} placeholder="输入本批分摊的商品名称" value={product} maxLength={80} required onChange={(event) => { setProduct(event.target.value); clearTrial(); }} /></div><div className="field-pair"><div className="field"><Label htmlFor="price">单价（元）</Label><Input id="price" disabled={!!busy} placeholder="0.00" inputMode="decimal" value={price} required onChange={(event) => { setPrice(event.target.value); clearTrial(); }} /></div><div className="field"><Label htmlFor="quantity">数量</Label><Input id="quantity" disabled={!!busy} placeholder="输入正整数" inputMode="numeric" value={quantity} required onChange={(event) => { setQuantity(event.target.value); clearTrial(); }} /></div></div><div className="total-preview"><span>本批精确总额</span><strong className="numeric">{estimatedTotal ? money(estimatedTotal) : "—"}</strong></div><Button type="submit" size="lg" className="full-width" disabled={!canTrial}>{busy === "simulate" ? <LoaderCircle className="animate-spin" size={17} /> : <Coins size={17} />}{busy === "simulate" ? "正在精确试算…" : "开始精确试算"}</Button><p className="field-note centered">试算不会扣减余额，也不会登记已用金额。</p></form></CardContent></Card><Card className="form-card source-selection"><CardHeader><CardTitle>本批金额来源</CardTitle><CardDescription>先最大化第一来源实际用额，再减少分组</CardDescription></CardHeader><CardContent>{sources.length ? <><div className="selected-source-list">{sources.map((source) => <div key={source.id}><span className="source-order">{String(source.priority).padStart(2, "0")}</span><span><strong>{source.name}</strong><small>优先级 {source.priority}</small></span><strong className="numeric">{money(source.availableCents)}</strong></div>)}</div><div className="source-total"><span>合计剩余余额</span><strong className="numeric">{money(available)}</strong></div></> : <div className="quiet-empty">尚未导入金额来源。</div>}<div className="context-note"><ShieldCheck size={16} /><p>剩余余额可能包含其他必填信息不完整的记录；部门空白可按规则参与，实际分摊以试算为准。每组使用额须为单价整数倍，使用后合并组余额须为0，或大于300元的整数。</p></div><Button variant="outline" className="full-width" onClick={() => go("sources")}>查看来源与历史记录<ArrowUpRight size={14} /></Button></CardContent></Card></div>
          {ambiguities.length > 0 && <Card className="simulation-card"><CardHeader><CardTitle>确认部门归属</CardTitle><CardDescription>这些来源行可匹配多个不同部门组合，请逐项选择。确认后才会继续试算；金额不会因确认而扣减。</CardDescription></CardHeader><CardContent><div className="issue-list">{ambiguities.map((item, index) => { const key = assignmentKey(item.sourceId, item.rowId); return <div key={key} className="context-note"><div><p><strong>{item.originalFile} · 第{item.originalRow}行</strong> · {money(item.amountCents)}</p><p>{item.applicant} · {item.costCenter} · {item.legalEntity} · {item.purpose}</p><p>原申领部门：{item.department || "空白"}；原使用中心：{item.useCenter || "空白"}</p><label htmlFor={`department-choice-${index}`}>请选择本行完整金额所属的部门组合</label><select id={`department-choice-${index}`} value={choices[key] ?? ""} disabled={!!busy} onChange={(event) => setChoices(previous => ({...previous, [key]:event.target.value}))}><option value="">请选择，不自动分配</option>{item.candidates.map((candidate, i) => <option key={i} value={String(i)}>申领部门：{candidate.department || "空白"}；使用中心：{candidate.useCenter || "空白"}</option>)}</select></div></div>; })}</div><Button onClick={resolveAmbiguities} disabled={!!busy || ambiguities.some(item => choices[assignmentKey(item.sourceId,item.rowId)] === undefined || choices[assignmentKey(item.sourceId,item.rowId)] === "")}>{busy === "simulate" ? "正在重新试算…" : "确认归属并重新试算"}</Button></CardContent></Card>}
          {simulation && <Card className="simulation-card"><CardHeader className="inline-card-header"><div><div className="inline-heading"><CardTitle>试算方案</CardTitle><Badge className="status-green">精确可行</Badge></div><CardDescription>{simulation.product} · {number(simulation.plan.quantity)}个 · {simulation.plan.groups.length}个分组</CardDescription></div><div className="simulation-amount numeric">{money(simulation.plan.totalCents)}</div></CardHeader><CardContent><Tabs defaultValue="groups"><TabsList><TabsTrigger value="groups">分组明细</TabsTrigger><TabsTrigger value="sources">来源与对账</TabsTrigger><TabsTrigger value="issues">未选记录与提示{simulation.plan.exclusions.length > 0 ? ` (${simulation.plan.exclusions.length})` : ""}</TabsTrigger></TabsList><TabsContent value="groups"><GroupTable plan={simulation.plan} /></TabsContent><TabsContent value="sources"><SourcePlanTable plan={simulation.plan} /></TabsContent><TabsContent value="issues"><div className="issue-list">{simulation.plan.warnings.map((warning, index) => <p key={index}><CircleAlert size={15} />{warning}</p>)}{simulation.plan.exclusions.length ? <Table><TableHeader><TableRow><TableHead>来源 / 原行</TableHead><TableHead>未选原因</TableHead><TableHead className="text-right">金额</TableHead></TableRow></TableHeader><TableBody>{simulation.plan.exclusions.map((item) => <TableRow key={`${item.sourceId}-${item.rowId}`}><TableCell>{item.originalFile} · 第{item.originalRow}行</TableCell><TableCell>{item.reason}</TableCell><TableCell className="text-right numeric">{money(item.amountCents)}</TableCell></TableRow>)}</TableBody></Table> : <p className="muted">没有因资料缺失而排除的记录。</p>}</div></TabsContent></Tabs><div className="template-section"><div><h3>上传本批开票模板</h3><p>保留EP编号与模板结构，生成待双agent核验的结果。</p></div><div className="template-input"><Label htmlFor="template-file" className="sr-only">开票模板文件</Label><Input key={templateKey} id="template-file" disabled={!!busy || !canWrite} type="file" accept=".xlsx" onChange={(event) => setTemplate(event.target.files?.[0] || null)} /><Button size="lg" disabled={!template || !!busy || !canWrite} onClick={prepare}>{busy === "prepare" ? <LoaderCircle size={16} className="animate-spin" /> : <FileSpreadsheet size={16} />}{busy === "prepare" ? "正在生成…" : "生成待核验文件"}</Button></div></div></CardContent></Card>}
        </>}

        {view === "ai" && <AiAsk />}

        {view === "sources" && <>
          <div className="section-heading"><h2>当前金额来源<span>{sources.length}</span></h2><Badge variant="outline">余额版本 {workspace?.version ?? "—"}</Badge></div>
          {sources.length ? <div className="source-card-grid">{sources.map((source) => <Card key={source.id} className="source-card"><CardHeader className="inline-card-header"><div className="source-card-title"><span className="source-order">{String(source.priority).padStart(2, "0")}</span><div><CardTitle>{source.name}</CardTitle><CardDescription>优先级 {source.priority} · {number(source.rowCount)}条剩余记录 · {"允许部门空白（不同非空值不合并）"}</CardDescription></div></div><FileSpreadsheet size={20} className="muted" /></CardHeader><CardContent><div className="source-available"><span>剩余余额</span><strong className="numeric">{money(source.availableCents)}</strong></div><div className="source-progress"><span style={{ width: `${Math.max(0, Math.min(100, source.originalCents ? source.usedCents / source.originalCents * 100 : 0))}%` }} /></div><div className="source-totals"><span>原总额<strong className="numeric">{money(source.originalCents)}</strong></span><span>累计已用<strong className="numeric">{money(source.usedCents)}</strong></span></div><div className="source-file"><FileSpreadsheet size={14} /><span title={source.fileName}>{source.fileName}</span></div><Button variant="outline" className="full-width" onClick={() => setSelectedSource(source)}>查看历批使用记录<ChevronRight size={14} /></Button></CardContent></Card>)}</div> : <Card className="empty-source-card"><Empty icon={WalletCards} title="从导入第一份金额表开始" description="上传剩余余额表，系统将识别原额、剩余额和顶部历史使用登记。" /></Card>}
          <Card className="import-card"><CardHeader><CardTitle>导入新的金额来源</CardTitle><CardDescription>追加独立来源，保留来源顺序。请勿将同一来源的原表与剩余表重复加入。</CardDescription></CardHeader><CardContent><form onSubmit={uploadSource} className="form-stack"><div className="import-fields"><div className="field"><Label htmlFor="source-file">金额来源文件</Label><Input key={sourceFileKey} id="source-file" disabled={!!busy || !canWrite} type="file" accept=".xlsx" required onChange={(event) => setSourceFile(event.target.files?.[0] || null)} /><p className="field-note">支持.xlsx，最大10MB。请使用未用余额明细表。</p></div><div className="field priority-field"><Label htmlFor="source-priority">使用优先级</Label><Input id="source-priority" disabled={!!busy || !canWrite} type="number" min={1} step={1} required value={sourcePriority} onChange={(event) => setSourcePriority(event.target.value)} /></div></div><div className="field"><Label htmlFor="source-history">截至当前已扣除的商品</Label><Input id="source-history" placeholder="例如：商品甲／商品乙／商品丙" value={sourceHistory} onChange={(event) => setSourceHistory(event.target.value)} disabled={!!busy || !canWrite || !!workspace?.productHistory.length} /><p className="field-note">按批次顺序填写，用“／”分隔。表中已有历史用额时必须填写；建立后沿用已确认清单。</p></div><p className="field-note">申领部门和使用中心可为空；具体归属按本批分组规则核对。</p><label className="confirm-line"><input type="checkbox" disabled={!!busy || !canWrite} checked={sourceConfirmed} onChange={(event) => setSourceConfirmed(event.target.checked)} required /><span>我已确认此来源与已导入金额不重复，历史商品清单及顺序正确。</span></label>{pendingCount > 0 && <p className="inline-warning"><CircleAlert size={15} />导入会更新余额版本，现有未入账批次需要重新试算。</p>}<div className="form-actions"><Button type="submit" disabled={!workspace || !sourceFile || !sourceConfirmed || !!busy || !canWrite}>{busy === "source" ? <LoaderCircle size={16} className="animate-spin" /> : <Upload size={16} />}{busy === "source" ? "正在核对并导入…" : "确认并导入来源"}</Button></div></form></CardContent></Card>
        </>}

        {view === "tax" && <div className="tax-grid"><div><Card className="tax-summary"><CardHeader><span className="icon-tile"><Landmark size={22} /></span><CardTitle>税务主体资料</CardTitle><CardDescription>已登记的开票资料</CardDescription></CardHeader><CardContent><div className="tax-count numeric">{workspace ? number(workspace.taxCount) : "—"}<span>家主体</span></div>{workspace?.taxFile ? <div className="source-file"><FileSpreadsheet size={15} /><span>{workspace.taxFile.name}</span></div> : <p className="muted">尚未上传税务主体表。</p>}<div className="context-note"><ShieldCheck size={16} /><p>按公司代码唯一精确匹配，再核对实际主体名称。账号和信用代码始终按文本保留。</p></div></CardContent></Card><Card className="import-card"><CardHeader><CardTitle>{workspace?.taxFile ? "更新税务资料" : "上传税务资料"}</CardTitle><CardDescription>后续批次使用更新后的资料，已生成批次保留原输入快照。</CardDescription></CardHeader><CardContent><form onSubmit={uploadTax} className="form-stack"><div className="field"><Label htmlFor="tax-file">税务主体记录</Label><Input key={taxFileKey} id="tax-file" disabled={!!busy || !canWrite} type="file" accept=".xlsx" required onChange={(event) => setTaxFile(event.target.files?.[0] || null)} /><p className="field-note">上传完整税务主体表，最大10MB。</p></div>{pendingCount > 0 && <p className="inline-warning"><CircleAlert size={15} />更新资料后，待入账批次需要重新生成并核验。</p>}<div className="form-actions"><Button type="submit" disabled={!workspace || !taxFile || !!busy || !canWrite}>{busy === "tax" ? <LoaderCircle size={16} className="animate-spin" /> : <Upload size={16} />}{busy === "tax" ? "正在校验资料…" : "上传并保存资料"}</Button></div></form></CardContent></Card></div><Card className="tax-rules"><CardHeader><CardTitle>开票明细填写规则</CardTitle><CardDescription>按来源表中的当前主体类型处理</CardDescription></CardHeader><CardContent><div className="tax-rule-row"><Badge variant="outline">小规模 / 简易征收</Badge><h3>仅填写统一社会信用代码</h3><p>按税务表保留信用代码原文。</p></div><div className="tax-rule-row"><Badge className="status-blue">一般纳税人 · 一般征收</Badge><h3>填写完整专票资料</h3><p>实际主体名称、信用代码、注册地址、开户行、基本户账号，空一行后填写“专票”。</p></div><div className="tax-rule-row"><Badge className="status-amber">资料待确认</Badge><h3>保留待补状态</h3><p>英文主体查不到资料时填写“形式发票”；其他无法核实的明细留空、红底，保留待补记录。金额仍按已确认规则独立核对。</p></div></CardContent></Card></div>}

        {view === "history" && <Card className="table-card history-card"><CardHeader className="inline-card-header"><div><CardTitle>全部批次</CardTitle><CardDescription>保留正式批次和待核验结果，避免重复扣减</CardDescription></div><div className="search-box"><Search size={16} /><Input aria-label="搜索商品或批次" placeholder="搜索商品或批次编号" value={query} onChange={(event) => setQuery(event.target.value)} /></div></CardHeader><CardContent>{batchTable(filteredBatches)}{batches.length >= 100 && <p className="field-note table-note">当前展示最近100个批次。</p>}</CardContent></Card>}

        {view === "rules" && <div className="rules-grid">{[
          ["01", "部门空值按规则匹配", "申领人、成本中心、费用承担法律主体、申领用途必须一致。申领部门和使用中心分别判断：空值可与唯一非空值合组；同字段不同非空值不能合组。存在多个可能归属时需要人工选择。法律主体允许名称与代码换序，二者本身都须一致。"],
          ["02", "精确金额与合并组余款", "每组使用额为单价整数倍，总金额与总数量精确达到目标。选用后，合并组余款为0，或大于300元的整数元；不按单条记录或单个来源单独判断门槛。"],
          ["03", "来源优先，逐行追溯", "同组可跨来源合并。先最大化第一来源实际贡献，再在这一最优值下减少分组；组内按来源优先级和原行顺序使用，不自动删除内容相同的真实记录。"],
          ["04", "实际使用与剩余分别保存", "已用金额标红；部分使用的原记录拆为红字已用金额和正常颜色的余额。剩余表仅删除已用行，保留所有未用金额，作为下一批来源。"],
          ["05", "逐源登记，顶部对账", "每批向右追加商品名称和从本表实际使用的金额，保留历史。独立核对：原总额＝剩余金额＋累计已用金额，差额必须为0；新增登记同步纳入公式。"],
          ["06", "六份结果，一批一夹", "两个来源生成开票单、两份已标红来源、两份剩余表和分摊核对记录。文件夹末尾沿实际余额链累计标注商品，例如（香蕉牛／新产品），同批重试不重复登记。"],
          ["07", "开票资料与主体排列", "按名称和公司代码精确核对税务信息，不猜测主体类型。同一费用承担法律主体的开票记录相邻列示，不因此合并六项不同的费用组。模板EP编号按原文保留。"],
          ["08", "双agent独立复核后入账", "由Codex启动两名独立agent，同时读取原始输入和最终Excel，各自重新计算核心金额。两份报告均通过、版本一致且问题已解决，才允许正式入账；核验失败或未完成时不扣减余额。"],
        ].map(([step, title, text]) => <Card key={step} className="rule-card"><CardHeader><span className="section-number">{step}</span><CardTitle>{title}</CardTitle></CardHeader><CardContent><p>{text}</p></CardContent></Card>)}</div>}
        <footer className="page-footer"><span>分摊 · Allocation</span><span>按来源核对 · 按批次留档</span></footer>
      </main>
    </div>

    <Dialog open={batchOpen} onOpenChange={setBatchOpen}><DialogContent className="batch-dialog">{selectedBatch && <>
      <DialogHeader><div className="inline-heading"><DialogTitle>{selectedBatch.product}</DialogTitle><Status status={selectedBatch.status} stale={selectedStale} /></div><DialogDescription>批次 <span className="batch-id">{selectedBatch.id}</span> · {date(selectedBatch.createdAt)}</DialogDescription></DialogHeader>
      {flash && <Alert variant={flash.kind === "error" ? "destructive" : "default"} className={flash.kind === "success" ? "flash-success" : ""}><CircleAlert /><AlertTitle>{flash.title}</AlertTitle><AlertDescription>{flash.message}</AlertDescription></Alert>}
      <div className="batch-detail-summary"><div><span>分摊总额</span><strong className="numeric">{money(selectedBatch.data.plan.totalCents)}</strong></div><div><span>商品数量</span><strong className="numeric">{number(selectedBatch.data.plan.quantity)}<small>个</small></strong></div><div><span>费用分组</span><strong className="numeric">{selectedBatch.data.plan.groups.length}<small>组</small></strong></div><div><span>独立核验</span><strong className="numeric">{passed.length}<small>/ 2</small></strong></div></div>
      <Tabs defaultValue="files"><TabsList className="detail-tabs"><TabsTrigger value="files">结果与核验</TabsTrigger><TabsTrigger value="groups">分摊明细</TabsTrigger><TabsTrigger value="sources">来源对账</TabsTrigger><TabsTrigger value="invoice">开票明细</TabsTrigger></TabsList>
        <TabsContent value="files">
          <AiPrecheck batchId={selectedBatch.id} disabled={!canWrite} />
          <div className="review-panel"><div><ShieldCheck size={21} /><div><h3>{completed(selectedBatch.status) ? "本批已正式入账" : selectedOldRule ? "分组规则已更新，需要重新试算" : selectedStale ? "余额版本已变化，需要重新试算" : canCommit ? "两份核验通过，可以确认入账" : "等待Codex完成双agent独立核验"}</h3><p>{completed(selectedBatch.status) ? "本批实际用额已登记，剩余金额已接续到共享账簿。" : selectedOldRule || selectedStale ? "请保留此批记录，使用当前规则和余额新建方案后重新核验。" : "未正式入账前，共享余额保持不变。复制指令到Codex启动核验。"}</p></div></div><div className="review-actions"><Button variant="outline" size="sm" onClick={copyReviewPrompt}><Copy size={14} />复制Codex核验指令</Button><Button variant="ghost" size="sm" disabled={!!busy} onClick={() => showBatch(selectedBatch.id)}><RefreshCw size={14} className={busy === "batch" ? "animate-spin" : ""} />刷新核验状态</Button></div></div>
          <div className="review-cards">{[0, 1].map((index) => { const report = reports[index]; return <div className={`review-card ${report?.status === "passed" ? "review-passed" : report?.status === "failed" ? "review-failed" : ""}`} key={index}><span className="review-agent-icon"><ClipboardCheck size={18} /></span><div><strong>{report ? report.reviewerId : `独立复核agent ${index + 1}`}</strong><p>{report ? report.status === "passed" ? "独立核验通过" : "核验未通过" : "尚未收到报告"}</p>{report?.summary && <p className="review-summary">{report.summary}</p>}{report?.issues?.map((issue, i) => <p className="error-text" key={i}>{issue}</p>)}{report?.unverified?.map((issue, i) => <p className="error-text" key={i}>未验证：{issue}</p>)}</div>{report?.status === "passed" && <CircleCheck size={18} className="green-text" />}</div>; })}</div>
          {reviewPrompt && <div className="copy-prompt"><Label htmlFor="review-prompt">核验指令</Label><textarea id="review-prompt" readOnly value={reviewPrompt} onFocus={(event) => event.target.select()} /></div>}
          <div className="files-heading"><div><h3>本批结果文件<span>{selectedBatch.data.manifest.length}份</span></h3><p className="folder-label"><FolderOpen size={14} />{selectedBatch.data.folderName}</p></div><Button variant="outline" asChild><a href={`/api/download?batch=${encodeURIComponent(selectedBatch.id)}`}><ArrowDownToLine size={15} />{completed(selectedBatch.status) ? "下载本批完整文件夹" : "下载待核验文件包"}</a></Button></div>
          <div className="file-list">{selectedBatch.data.manifest.map((file, index) => <a key={file.role} href={`/api/download?batch=${encodeURIComponent(selectedBatch.id)}&role=${encodeURIComponent(file.role)}`} className="result-file"><span className="file-index">{String(index + 1).padStart(2, "0")}</span><FileSpreadsheet size={18} /><span>{file.name}</span><ArrowDownToLine size={15} /></a>)}</div>
          {selectedBatch.data.taxPending > 0 && <p className="inline-warning"><CircleAlert size={15} />{selectedBatch.data.taxPending}条开票明细待补，已按规则留空并填红底。金额核验与税务待补分别记录。</p>}
          <div className="commit-bar"><p>{completed(selectedBatch.status) ? "本批已入账，重复操作不会再次扣减。" : selectedOldRule ? "当前批次使用旧分组规则，请重新试算并双重核验。" : selectedStale ? "当前批次余额版本已过期，禁止入账。" : "两名agent都通过后，由你确认正式入账。"}</p>{!completed(selectedBatch.status) && <Button disabled={!canCommit || !!busy} onClick={commit}>{busy === "commit" ? <LoaderCircle className="animate-spin" size={16} /> : <Check size={16} />}{busy === "commit" ? "正在核对并入账…" : "确认正式入账"}</Button>}</div>
        </TabsContent>
        <TabsContent value="groups"><GroupTable plan={selectedBatch.data.plan} /></TabsContent>
        <TabsContent value="sources"><SourcePlanTable plan={selectedBatch.data.plan} /><p className="field-note table-note">差额为0，同时独立核对分组、余款、拆分、历史登记和来源优先目标。</p></TabsContent>
        <TabsContent value="invoice"><Table className="invoice-table"><TableHeader><TableRow><TableHead>开票行</TableHead><TableHead>费用承担法律主体</TableHead><TableHead>开票明细</TableHead><TableHead>说明</TableHead></TableRow></TableHeader><TableBody>{selectedBatch.data.invoiceRows.map((row) => <TableRow key={row.key}><TableCell>{row.targetRow}</TableCell><TableCell className="wrap-cell legal-cell">{row.legalEntity}</TableCell><TableCell className={`invoice-text ${row.tax.mode === "pending" ? "tax-pending-cell" : ""}`}>{row.tax.text || "待补充"}</TableCell><TableCell className="wrap-cell muted">{row.tax.reason}</TableCell></TableRow>)}</TableBody></Table></TabsContent>
      </Tabs>
    </>}</DialogContent></Dialog>
    <Dialog open={!!selectedSource} onOpenChange={(open) => { if (!open) setSelectedSource(null); }}><DialogContent className="source-dialog">{selectedSource && <><DialogHeader><DialogTitle>{selectedSource.name} · 历批使用记录</DialogTitle><DialogDescription>仅登记本来源实际贡献，保留各批商品与用额。</DialogDescription></DialogHeader><Table><TableHeader><TableRow><TableHead>商品</TableHead><TableHead className="text-right">本来源实际使用</TableHead></TableRow></TableHeader><TableBody>{selectedSource.history.length ? selectedSource.history.map((entry, index) => <TableRow key={`${entry.batchId}-${index}`}><TableCell>{entry.product}</TableCell><TableCell className="text-right numeric">{money(entry.usedCents)}</TableCell></TableRow>) : <TableRow><TableCell colSpan={2} className="muted">尚无历史使用记录。</TableCell></TableRow>}</TableBody></Table><div className="source-equation"><span>原总额<strong>{money(selectedSource.originalCents)}</strong></span><i>=</i><span>剩余金额<strong>{money(selectedSource.availableCents)}</strong></span><i>+</i><span>累计已用<strong>{money(selectedSource.usedCents)}</strong></span></div><div className={`ledger-check ${sourceDifference === 0 ? "" : "error-text"}`}>{sourceDifference === 0 ? <CircleCheck size={16} /> : <CircleAlert size={16} />}<span>核对差额</span><strong className="numeric">{money(sourceDifference)}</strong></div></>}</DialogContent></Dialog>
  </div>;
}
