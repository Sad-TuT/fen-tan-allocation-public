"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, CircleAlert, CircleCheck, LoaderCircle, Send, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AllocationPlan, DepartmentAssignment } from "./lib/allocation";

type Draft = { product: string; price: string; quantity: number };
type AgentSimulation = {
  version: number;
  product: string;
  priceCents: number;
  assignments: DepartmentAssignment[];
  plan: AllocationPlan;
};
type DraftResult = { draft: Draft; note: string; plan: { groups: number; totalCents: number; quantity: number } | null; warning: string | null; simulation: AgentSimulation | null };
type Risk = { severity: "high" | "medium" | "low"; title: string; detail: string; evidence: string };

const money = (cents: number) => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);

async function callAi(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (response.status === 401) { window.location.assign("/login"); throw new Error("登录已失效，请重新登录。"); }
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

// DeepSeek interprets the request and schedules the trusted exact solver. Any
// financial fields returned by the model are ignored; only validated solver
// output may populate the dashboard.
export function AiDraftAssistant({ disabled, onApply, embedded = false }: { disabled: boolean; onApply: (draft: Draft, simulation: AgentSimulation | null) => void; embedded?: boolean }) {
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DraftResult | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(await callAi({ action: "parse", text: description }) as unknown as DraftResult);
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  }

  const content = <>
    <form onSubmit={submit} className="ai-form">
      <div className="field">
        <Label htmlFor="ai-description">一句话描述本批</Label>
        <Textarea id="ai-description" rows={3} maxLength={1000} disabled={disabled || busy} placeholder="例如：流苏毯，单价 59 元，数量 1500，总额 88500 元" value={description} onChange={(event) => setDescription(event.target.value)} />
      </div>
      <div className="ai-actions">
        <Button type="submit" disabled={disabled || busy || !description.trim()}>{busy ? <LoaderCircle className="animate-spin" size={16} /> : <Sparkles size={16} />}{busy ? "DeepSeek 正在规划与试算…" : "DeepSeek 自动分摊"}</Button>
        <p className="field-note">DeepSeek 理解指令并调度精确分摊；每条来源、金额、余款和数量均由网站整数分校验器复核后才可生成 Excel。</p>
      </div>
    </form>
    {error && <p className="ai-error"><CircleAlert size={15} />{error.replace(/[。！？]+$/, "")}。你仍可在下方手动填写，不影响继续处理。</p>}
    {result && <div className="ai-result">
      <div className="ai-result-title"><Badge className="status-blue">{result.simulation ? "方案已通过试算" : "参数已识别"}</Badge><span>{result.simulation ? "DeepSeek 规划完成，请核对精确结果" : "请核对后补充或确认部门归属"}</span></div>
      <div className="ai-fields">
        <div><span>商品名称</span><strong>{result.draft.product}</strong></div>
        <div><span>单价</span><strong className="numeric">{money(Number(result.draft.price) * 100)}</strong></div>
        <div><span>数量</span><strong className="numeric">{result.draft.quantity}</strong></div>
      </div>
      {result.plan && <p className="ai-ok"><CircleCheck size={15} />精确试算通过：{result.plan.groups} 个分组，合计 {money(result.plan.totalCents)}。</p>}
      {result.warning && <p className="ai-warning"><CircleAlert size={15} />{result.warning}</p>}
      {result.note && <p className="field-note">{result.note}</p>}
      <Button variant="outline" onClick={() => { onApply(result.draft, result.simulation); setResult(null); setDescription(""); }}>{result.simulation ? "采用方案并查看明细" : "填入参数并继续确认"}<ArrowRight size={15} /></Button>
    </div>}
  </>;

  if (embedded) return <div className="ai-entry">
    <div className="ai-entry-heading"><span className="ai-icon"><Sparkles size={18} /></span><div><div className="inline-heading"><h3>DeepSeek 自动分摊</h3><Badge variant="outline">网站内处理</Badge></div><p>输入商品、单价和数量。DeepSeek 完成理解与规划，网站精确校验后生成 Excel；正式入账仍须两名独立复核。</p></div></div>
    <div className="ai-agent-stages" aria-label="DeepSeek 自动处理阶段"><span>理解指令</span><i /><span>生成方案</span><i /><span>逐分钱校验</span><i /><span>生成 Excel</span></div>
    {content}
  </div>;

  return <Card className="ai-card">
    <CardHeader><div className="ai-card-heading"><span className="ai-icon"><Sparkles size={18} /></span><div><CardTitle>DeepSeek 自动分摊</CardTitle><CardDescription>用一句话描述这一批，模型规划后由网站校验并生成文件，不会直接入账。</CardDescription></div></div></CardHeader>
    <CardContent>{content}</CardContent>
  </Card>;
}

// Advisory risk scan shown inside the batch dialog, before the two-agent gate.
export function AiPrecheck({ batchId, disabled }: { batchId: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ summary: string; risks: Risk[] } | null>(null);

  async function run() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const data = await callAi({ action: "precheck", batchId });
      setResult({ summary: typeof data.summary === "string" ? data.summary : "", risks: Array.isArray(data.risks) ? data.risks as Risk[] : [] });
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ai-precheck">
      <div className="ai-precheck-heading">
        <div><h3><Sparkles size={15} />AI 预核验</h3><p>批次分组、主体及金额会发送至 DeepSeek；结果是补充提示，不能替代两名 agent 的独立核验。</p></div>
        <Button variant="outline" size="sm" disabled={disabled || busy} onClick={run}>{busy ? <LoaderCircle className="animate-spin" size={14} /> : <Sparkles size={14} />}{busy ? "正在检查…" : result ? "重新检查" : "开始预核验"}</Button>
      </div>
      {error && <p className="ai-error"><CircleAlert size={15} />{error}</p>}
      {result && <>
        {result.summary && <p className="ai-summary">{result.summary}</p>}
        {result.risks.length ? <ul className="ai-risk-list">{result.risks.map((risk, index) => <li key={index} className={SEVERITY[risk.severity]?.className ?? "ai-risk-low"}><Badge className="ai-risk-badge">{SEVERITY[risk.severity]?.label ?? "低"}</Badge><div><strong>{risk.title}</strong>{risk.detail && <p>{risk.detail}</p>}{risk.evidence && <p className="ai-evidence">依据：{risk.evidence}</p>}</div></li>)}</ul> : <p className="ai-ok"><CircleCheck size={15} />没有发现需要额外确认的风险项。</p>}
        <p className="field-note">AI 结果仅供参考，入账仍以两名 agent 的核验报告为准。</p>
      </>}
    </div>
  );
}

type Turn = { question: string; answer: string };

// Grounded Q&A over the workspace summary; the model never queries the ledger.
export function AiAsk() {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const asked = question.trim();
    if (!asked) return;
    setBusy(true);
    setError("");
    try {
      const data = await callAi({ action: "ask", question: asked });
      setTurns((current) => [...current.slice(-9), { question: asked, answer: typeof data.answer === "string" ? data.answer : "" }]);
      setQuestion("");
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="ai-card">
      <CardHeader>
        <div className="ai-card-heading"><span className="ai-icon"><Sparkles size={18} /></span><div><CardTitle>账簿问答</CardTitle><CardDescription>基于当前来源余额与最近批次回答，结果供参考。</CardDescription></div></div>
      </CardHeader>
      <CardContent>
        {turns.length > 0 && <div className="ai-thread">{turns.map((turn, index) => <div key={index} className="ai-turn"><p className="ai-question">{turn.question}</p><p className="ai-answer">{turn.answer}</p></div>)}</div>}
        {!turns.length && <div className="quiet-empty"><Sparkles size={18} />可以问：上个月研发部一共分摊多少？还剩多少余额？最近一批为什么待核验？</div>}
        {error && <p className="ai-error"><CircleAlert size={15} />{error}</p>}
        <form onSubmit={submit} className="ai-ask-form">
          <Label htmlFor="ai-question" className="sr-only">问题</Label>
          <Textarea id="ai-question" rows={2} maxLength={500} disabled={busy} placeholder="输入关于当前账簿的问题" value={question} onChange={(event) => setQuestion(event.target.value)} />
          <Button type="submit" disabled={busy || !question.trim()}>{busy ? <LoaderCircle className="animate-spin" size={16} /> : <Send size={16} />}{busy ? "正在查询…" : "提问"}</Button>
        </form>
        <p className="field-note">问题与账簿摘要会发送到 DeepSeek；如问题指定批次，还会发送该批次部分人员、部门和金额明细。</p>
      </CardContent>
    </Card>
  );
}
