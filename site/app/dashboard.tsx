"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { CircleHelp, LogOut, Settings2 } from "lucide-react";
import AccountPanel from "./account-panel";
import Workbench, { type SessionUser } from "./workbench";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const LegacyDashboard = dynamic(() => import("./legacy-dashboard"), { ssr: false, loading: () => <div className="job-loading">正在打开共享账簿管理…</div> });

export default function Dashboard({ user }: { user: SessionUser }) {
  const [legacy, setLegacy] = useState(false);
  const [legacyVisited, setLegacyVisited] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  async function logout() {
    setLogoutError("");
    try {
      const response = await fetch("/api/app-auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error("退出失败，请稍后重试。");
      window.location.assign("/login");
    } catch (error) { setLogoutError(error instanceof Error ? error.message : "退出失败，请稍后重试。"); setAccountOpen(true); }
  }

  return <>
    <div hidden={legacy}>
      <div className="job-workbench-wrap"><Workbench user={user} onOpenLegacy={() => { setLegacyVisited(true); setLegacy(true); }} onOpenAccount={() => setAccountOpen(true)} /></div>
    </div>
    {legacyVisited && <div className="job-legacy-wrap" hidden={!legacy}>
      <div className="job-legacy-return"><Button type="button" variant="outline" size="sm" onClick={() => setLegacy(false)}>返回批次工作区</Button><span>共享账簿管理</span></div>
      <LegacyDashboard user={{ ...user, email: user.email ?? "" }} />
    </div>}
    <Dialog open={accountOpen} onOpenChange={setAccountOpen}>
      <DialogContent className="job-account-dialog">
        <DialogHeader><DialogTitle>账户设置</DialogTitle><DialogDescription>管理密码和当前登录状态。</DialogDescription></DialogHeader>
        {logoutError && <p className="job-inline-error" role="alert"><CircleHelp size={15} />{logoutError}</p>}
        <AccountPanel role={user.role} userId={user.id} />
        <div className="job-account-footer"><Button type="button" variant="outline" onClick={() => void logout()}><LogOut size={15} />退出登录</Button><span><Settings2 size={14} />账号管理和共享账簿操作仍在“管理入口”。</span></div>
      </DialogContent>
    </Dialog>
  </>;
}
