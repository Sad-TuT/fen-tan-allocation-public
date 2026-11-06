"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CircleAlert, CircleCheck, LoaderCircle, Send, Sparkles, Square } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Draft = { product: string; price: string; quantity: number };
type Risk = { severity: "high" | "medium" | "low"; title: string; detail: string; evidence: string };

const money = (cents: number) => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);

async function callAi(body: Record<string, unknown>, signal?: AbortSignal, onUnauthorized?: () => void): Promise<Record<string, unknown>> {
  const response = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  if (response.status === 401) { onUnauthorized?.(); throw new Error("登录已失效，请重新登录。"); }
  let data: Record<string, unknown>;
  try { data = await response.json(); } catch { throw new Error("无法读取 AI 结果，请稍后重试。"); }
  if (!response.ok || data?.error) throw new Error(typeof data?.error === "string" ? data.error : "AI 处理失败。");
  return data;
}

const failureText = (error: unknown) => error instanceof Error ? error.message : "AI 处理失败，请稍后重试。";
const SEVERITY: Record<Risk["severity"], { label: string; className: string }> = {
  high: { label: "高", className: "ai-risk-high" },
  medium: { label: "中", className: "ai-risk-medium" },
  low: { label: "低", className: "ai-risk-low" },
};

export type AiWorkspaceVisibleData = {
  label: string;
  headers: string[];
  rows: { sourceRow: number; values: (string | number | null)[] }[];
};

type AiWorkspaceTurn = {
  role: "user" | "assistant";
  content: string;
  draft?: { product?: string; price?: string; quantity?: number } | null;
  missing?: ("product" | "price" | "quantity")[];
  evidence?: { label: string; value: string }[];
  dataScope?: string[];
};

const DRAFT_LABELS = { product: "商品名称", price: "单价", quantity: "数量" } as const;

function prepareVisibleData(data?: AiWorkspaceVisibleData): AiWorkspaceVisibleData | undefined {
  if (!data) return undefined;
  return {
    label: data.label.slice(0, 80),
    headers: data.headers.slice(0, 20).map((value) => value.slice(0, 48)),
    rows: data.rows.slice(0, 10).map((row) => ({
      sourceRow: row.sourceRow,
      values: row.values.slice(0, 20).map((value) => typeof value === "string" ? value.slice(0, 32) : value),
    })),
  };
}

/** A single persistent, opt-in assistant surface for the file-first workspace. */
export function AiWorkspaceAssistant({ jobId, userId, jobStatus = "draft", contextLabel, disabled = false, canApplyDraft = true, allowDraftApply, onApplyDraft, onNavigate, visibleData }: {
  jobId?: string;
  userId?: string;
  jobStatus?: "draft" | "prepared" | "adopted" | "discarded";
  contextLabel?: string;
  disabled?: boolean;
  canApplyDraft?: boolean;
  allowDraftApply?: boolean;
  onApplyDraft?: (draft: Draft) => void;
  onNavigate?: (view: string) => void;
  visibleData?: AiWorkspaceVisibleData;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"assistant" | "precheck">("assistant");
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<AiWorkspaceTurn[]>([]);
  const [sendingVisibleData, setSendingVisibleData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState("");
  const [configState, setConfigState] = useState<"checking" | "configured" | "missing" | "unknown">("checking");
  const [precheck, setPrecheck] = useState<{ summary: string; risks: Risk[]; total: number; reviewed: number } | null>(null);
  const [precheckBusy, setPrecheckBusy] = useState(false);
  const [precheckError, setPrecheckError] = useState("");
  const activeController = useRef<AbortController | null>(null);
  const precheckController = useRef<AbortController | null>(null);
  const previousIdentity = useRef(`${userId ?? ""}:${jobId ?? ""}`);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/ai", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) { router.push("/login"); return null; }
        if (!response.ok) { setConfigState("unknown"); return null; }
        return await response.json() as { configured?: boolean };
      })
      .then((status) => { if (status) setConfigState(status.configured === true ? "configured" : "missing"); })
      .catch(() => setConfigState("unknown"));
    return () => controller.abort();
  }, [router]);

  useEffect(() => {
    const nextIdentity = `${userId ?? ""}:${jobId ?? ""}`;
    if (previousIdentity.current !== nextIdentity) {
      activeController.current?.abort();
      activeController.current = null;
      precheckController.current?.abort();
      precheckController.current = null;
      setBusy(false);
      setPrecheckBusy(false);
      setTurns([]);
      setInput("");
      setError("");
      setPrecheck(null);
      setSendingVisibleData(false);
      previousIdentity.current = nextIdentity;
    }
  }, [jobId, userId]);

  useEffect(() => () => {
    activeController.current?.abort();
    precheckController.current?.abort();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || busy || disabled) return;
    const checkedIdentity = `${userId ?? ""}:${jobId ?? ""}`;
    const controller = new AbortController();
    activeController.current = controller;
    setBusy(true);
    setCancelled(false);
    setError("");
    try {
      const history = turns.slice(-4).map((turn) => ({
        role: turn.role,
        content: [
          turn.content.slice(0, 400),
          turn.role === "assistant" && turn.draft ? `草稿字段：${JSON.stringify(turn.draft)}；待补字段：${(turn.missing ?? []).join("、")}` : "",
        ].filter(Boolean).join("\n").slice(0, 500),
      }));
      const selectedData = sendingVisibleData ? prepareVisibleData(visibleData) : undefined;
      const result = await callAi({
        action: "workspace",
        message,
        history,
        ...(jobId ? { jobId } : {}),
        ...(selectedData ? { visibleData: selectedData } : {}),
      }, controller.signal, () => router.push("/login"));
      if (controller.signal.aborted || previousIdentity.current !== checkedIdentity) return;
      const draft = result.draft && typeof result.draft === "object" ? result.draft as AiWorkspaceTurn["draft"] : null;
      const missing = Array.isArray(result.missing)
        ? result.missing.filter((item): item is "product" | "price" | "quantity" => item === "product" || item === "price" || item === "quantity")
        : [];
      setTurns((current) => [...current.slice(-15),
        { role: "user", content: message },
        {
          role: "assistant",
          content: typeof result.answer === "string" ? result.answer : "这次没有得到可用回答，请补充条件后重试。",
          draft,
          missing,
          evidence: Array.isArray(result.evidence) ? result.evidence.slice(0, 5) as AiWorkspaceTurn["evidence"] : [],
          dataScope: Array.isArray(result.dataScope) ? result.dataScope.filter((item): item is string => typeof item === "string").slice(0, 4) : [],
        },
      ]);
      setInput("");
      setSendingVisibleData(false);
    } catch (failure) {
      if (controller.signal.aborted) setCancelled(true);
      else setError(failureText(failure));
    } finally {
      if (activeController.current === controller) {
        activeController.current = null;
        setBusy(false);
      }
    }
  }

  async function runPrecheck() {
    if (!mayPrecheck || !jobId || disabled || precheckBusy) return;
    const checkedJobId = jobId;
    const controller = new AbortController();
    precheckController.current?.abort();
    precheckController.current = controller;
    setPrecheckBusy(true);
    setPrecheckError("");
    setPrecheck(null);
    try {
      const result = await callAi({ action: "workspace-precheck", jobId: checkedJobId }, controller.signal, () => router.push("/login"));
      if (controller.signal.aborted || previousIdentity.current !== `${userId ?? ""}:${checkedJobId}`) return;
      setPrecheck({
        summary: typeof result.summary === "string" ? result.summary : "",
        risks: Array.isArray(result.risks) ? result.risks as Risk[] : [],
        total: Number.isSafeInteger(result.groupCount) ? Number(result.groupCount) : 0,
        reviewed: Number.isSafeInteger(result.groupsReviewed) ? Number(result.groupsReviewed) : 0,
      });
    } catch (failure) {
      if (!controller.signal.aborted && previousIdentity.current === `${userId ?? ""}:${checkedJobId}`) setPrecheckError(failureText(failure));
    } finally {
      if (precheckController.current === controller) {
        precheckController.current = null;
        setPrecheckBusy(false);
      }
    }
  }

  const mayApplyDraft = canApplyDraft && (allowDraftApply ?? true);
  const mayPrecheck = Boolean(jobId && (jobStatus === "prepared" || jobStatus === "adopted"));
  const hasVisibleData = Boolean(visibleData?.headers.length && visibleData.rows.length);
  const configNotice = configState === "missing" ? "AI 服务尚未配置，可以继续手动处理资料。" : configState === "unknown" ? "暂时无法读取 AI 配置状态。你仍可尝试发送请求，或继续手动处理。" : null;

  return <section className="space-y-4 rounded-xl border border-border bg-card p-4 md:p-5" aria-label="AI 工作助手">
    <header className="flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Sparkles size={18} /></span>
        <div><h2 className="text-base font-semibold">AI 工作助手</h2><p className="mt-1 text-sm text-muted-foreground">整理本批参数、解释数据并提示待确认事项。</p></div>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
        <span className={`size-2 rounded-full ${configState === "configured" ? "bg-emerald-600" : configState === "missing" ? "bg-amber-600" : "bg-muted-foreground/50"}`} />
        {configState === "configured" ? "已配置" : configState === "missing" ? "未配置" : configState === "unknown" ? "状态未知" : "读取状态"}
      </div>
    </header>

    <nav className="flex gap-1 rounded-lg bg-muted p-1" aria-label="AI 功能">
      <button type="button" className={`min-h-10 flex-1 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${mode === "assistant" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`} aria-pressed={mode === "assistant"} onClick={() => setMode("assistant")}>助手</button>
      <button type="button" className={`min-h-10 flex-1 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${mode === "precheck" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`} aria-pressed={mode === "precheck"} onClick={() => setMode("precheck")} disabled={!mayPrecheck}>批次预检</button>
    </nav>

    {configNotice && <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900" role="status"><CircleAlert size={17} className="mt-0.5 shrink-0" />{configNotice}</div>}

    {mode === "assistant" ? <>
      {jobId && <p className="text-xs text-muted-foreground">当前上下文：{contextLabel || "本批资料与余额汇总"}。AI可以读取本批摘要，不会自动读取整份工作簿。</p>}
      {turns.length > 0 && <ol className="max-h-[30rem] space-y-3 overflow-y-auto rounded-lg bg-muted/40 p-3" aria-label="AI 对话" role="log" aria-live="polite" aria-relevant="additions text">
        {turns.map((turn, index) => <li key={`${index}-${turn.role}`} className={turn.role === "user" ? "ml-8 rounded-lg bg-primary px-3 py-2.5 text-sm text-primary-foreground" : "mr-4 rounded-lg bg-background px-3 py-2.5 text-sm"}>
          <p className="whitespace-pre-wrap leading-6">{turn.content}</p>
          {turn.role === "assistant" && turn.draft && <div className="mt-3 rounded-md border border-border p-3 text-foreground">
            <div className="flex items-center gap-2 text-sm font-medium"><Sparkles size={15} className="text-primary" />分摊草稿</div>
            <dl className="mt-2 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
              <div><dt className="text-xs text-muted-foreground">商品</dt><dd className="mt-0.5 font-medium">{turn.draft.product || "待补充"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">单价</dt><dd className="mt-0.5 font-medium tabular-nums">{turn.draft.price ? money(Math.round(Number(turn.draft.price) * 100)) : "待补充"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">数量</dt><dd className="mt-0.5 font-medium tabular-nums">{turn.draft.quantity ?? "待补充"}</dd></div>
            </dl>
            {turn.missing?.length ? <p className="mt-2 text-xs text-amber-800">还需要：{turn.missing.map((field) => DRAFT_LABELS[field]).join("、")}</p> : null}
            {turn.draft.product && turn.draft.price && turn.draft.quantity && onApplyDraft && mayApplyDraft && <Button type="button" className="mt-3" size="sm" variant="outline" onClick={() => onApplyDraft({ product: turn.draft!.product!, price: turn.draft!.price!, quantity: turn.draft!.quantity! })}>核对后填入本批参数<ArrowRight size={14} /></Button>}
          </div>}
          {turn.role === "assistant" && turn.evidence?.length ? <div className="mt-2 space-y-1 border-t border-border pt-2"><p className="text-xs font-medium text-muted-foreground">本次依据</p>{turn.evidence.map((entry, itemIndex) => <p className="text-xs text-muted-foreground" key={`${entry.label}-${itemIndex}`}>{entry.label}：{entry.value}</p>)}</div> : null}
          {turn.role === "assistant" && turn.dataScope?.length ? <details className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground"><summary className="cursor-pointer select-none">本次发送了哪些资料</summary><ul className="mt-1 list-inside list-disc space-y-0.5">{turn.dataScope.map((scope, itemIndex) => <li key={`${index}-scope-${itemIndex}`}>{scope}</li>)}</ul></details> : null}
        </li>)}
        {busy && <li className="mr-4 rounded-lg bg-background px-3 py-3 text-sm text-muted-foreground" aria-live="polite"><span className="inline-flex items-center gap-2"><LoaderCircle size={15} className="animate-spin" />正在整理当前问题…</span></li>}
      </ol>}

      {!turns.length && <div className="rounded-lg bg-muted/40 px-4 py-5 text-sm">
        <p className="font-medium">可以这样开始</p>
        <ul className="mt-2 space-y-1.5 text-muted-foreground"><li>“做一批折叠椅，单价120元，数量60件”</li><li>“这批用了多少第一来源余额？”</li><li>“当前表格这些部门的记录有什么异常？”</li></ul>
        <p className="mt-3 text-xs text-muted-foreground">AI只整理成待确认的参数草稿，金额由分摊引擎精确计算。</p>
      </div>}

      <form onSubmit={submit} className="space-y-2">
        <label htmlFor="workspace-ai-message" className="sr-only">描述本批分摊或询问当前资料</label>
        <Textarea id="workspace-ai-message" rows={3} maxLength={2000} disabled={disabled || busy || configState === "missing"} placeholder={jobId ? "描述本批分摊，或询问当前余额和进度" : "描述本批分摊，AI会整理成待确认参数草稿"} value={input} onChange={(event) => setInput(event.target.value)} />
        {hasVisibleData && <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1.5 text-xs text-muted-foreground">
          <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={sendingVisibleData} onChange={(event) => setSendingVisibleData(event.target.checked)} disabled={busy || disabled} />
          <span>将当前预览的前10行发送给 AI：{visibleData!.label}，最多20列、每格32字，可能含人员、部门或金额信息。</span>
        </label>}
        <p className="text-xs text-muted-foreground">发送给 DeepSeek 的范围：本次描述、最近几轮对话{jobId ? "、本批摘要" : ""}{sendingVisibleData && visibleData ? `、你勾选的${visibleData.label}预览` : ""}。不会自动发送整份工作簿。</p>
        {error && <p className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert"><CircleAlert size={16} className="mt-0.5 shrink-0" />{error}</p>}
        {cancelled && <p className="text-sm text-muted-foreground" role="status">已取消本次请求，你可以修改内容后再试。</p>}
        <div className="flex justify-end gap-2">
          {busy && <Button type="button" size="sm" variant="outline" onClick={() => activeController.current?.abort()}><Square size={13} />停止</Button>}
          <Button type="submit" size="sm" disabled={disabled || busy || configState === "missing" || !input.trim()}>{busy ? <LoaderCircle className="animate-spin" size={15} /> : <Send size={15} />}{busy ? "整理中…" : error ? "重试" : "发送"}</Button>
        </div>
      </form>
      {onNavigate && <button type="button" className="text-xs text-primary underline-offset-4 hover:underline" onClick={() => onNavigate("new")}>打开分摊录入</button>}
    </> : <div className="space-y-3">
      <p className="text-sm text-muted-foreground">AI 只解释程序生成的试算摘要和检查信号，结果供人工核对。</p>
      {precheckError && <p className="text-sm text-destructive" role="alert">{precheckError}</p>}
      {precheck && <div className="space-y-3 rounded-lg bg-muted/30 p-3">
        <p className="text-xs text-muted-foreground">检查覆盖：{precheck.reviewed}/{precheck.total} 个分组明细。此次未把源行或完整工作簿发送给 AI；预检不替代技能要求的独立复核。</p>
        {precheck.summary && <p className="text-sm leading-6">{precheck.summary}</p>}
        {precheck.risks.length ? <ul className="space-y-2">{precheck.risks.map((risk, index) => <li key={`${risk.title}-${index}`} className={`flex gap-3 rounded-md p-3 ${SEVERITY[risk.severity]?.className ?? "bg-background"}`}><Badge className="ai-risk-badge">{SEVERITY[risk.severity]?.label ?? "提示"}</Badge><div><strong className="text-sm">{risk.title}</strong>{risk.detail && <p className="mt-1 text-sm">{risk.detail}</p>}{risk.evidence && <p className="mt-1 text-xs text-muted-foreground">依据：{risk.evidence}</p>}</div></li>)}</ul> : <p className="flex items-start gap-2 text-sm"><CircleCheck size={16} className="text-emerald-700" />AI 未发现额外提示，仍需完成独立核对。</p>}
      </div>}
      <Button type="button" size="sm" variant="outline" disabled={!mayPrecheck || disabled || precheckBusy || configState === "missing"} onClick={runPrecheck}>{precheckBusy ? <LoaderCircle size={15} className="animate-spin" /> : <Sparkles size={15} />}{precheckBusy ? "检查中…" : precheck ? "重新预检" : "预检本批"}</Button>
      <p className="text-xs text-muted-foreground">{precheck ? "本次AI读取试算摘要，程序的确定性差异提示另行列出；未读取输入工作簿或分组明细。" : "生成本批候选文件后，可以运行摘要预检。"}</p>
    </div>}
  </section>;
}
