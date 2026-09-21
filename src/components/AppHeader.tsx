import Link from "next/link";
import type { ReactNode } from "react";

import { logoutAction } from "@/app/actions/auth";
import type { Viewer } from "@/lib/auth/guards";
import { NavLink } from "./NavLink";

export function AppHeader({
  viewer,
  pendingCount,
  serviceMenu = null,
}: {
  viewer: Viewer;
  pendingCount: number;
  /**
   * 사내 시스템 오가기 목록(@dss/ui 의 ServiceMenuBar). (internal)/layout.tsx 가
   * 서버에서 만들어 내려보내고, 이 머리말이 **시스템 이름 바로 옆**에 그린다.
   *
   * 조각이 아니라 **다 그려진 노드**를 받는 이유: 이 파일이 @dss/ui 도, 목록을
   * 어디서 구하는지도 몰라야 한다. 그리는 자리만 여기가 정한다.
   * 목록이 비면 그 조각이 스스로 아무것도 그리지 않아 빈 칸만 남는다 —
   * 포털이 클레임을 싣기 전까지는 머리말이 예전과 똑같다.
   */
  serviceMenu?: ReactNode;
}) {
  const { employee } = viewer;
  return (
    // 🔴 overflow-hidden 을 걸지 않는다. 메뉴바를 펼친 목록은 단추 아래로
    // **떠서**(position:absolute) 그려지므로 머리말이나 그 조상이 넘치는 것을
    // 자르면 목록이 잘린다(@dss/ui README 3절).
    <header className="no-print border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tracking-tight text-slate-900">휴가 관리</span>
          <span className="text-xs font-medium text-slate-400">DSS</span>
        </Link>

        {/*
          사내 시스템 오가기 단추. 폰에서 이 줄이 넘치면 이 머리말은 이미
          flex-wrap 이라 메뉴·사용자 칸이 아랫줄로 내려간다 — 가로로 삐져나가
          잘리지 않는다. 단추 자체는 서비스가 몇이든 폭이 그대로다(드롭다운).
        */}
        <div className="shrink-0">{serviceMenu}</div>

        <nav className="flex flex-wrap items-center gap-1">
          <NavLink href="/" exact>
            달력
          </NavLink>
          {employee && (
            <>
              <NavLink href="/leave/new">휴가 신청</NavLink>
              <NavLink href="/leave" exact>
                내 휴가
              </NavLink>
            </>
          )}
          {viewer.isApprover && (
            <NavLink href="/approvals">
              결재함
              {pendingCount > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-500 px-1.5 py-0.5 text-xs font-semibold text-white">
                  {pendingCount}
                </span>
              )}
            </NavLink>
          )}
          {viewer.isAdmin && (
            <>
              <span className="mx-1 h-5 w-px bg-slate-200" aria-hidden />
              <NavLink href="/admin/employees">직원 관리</NavLink>
              <NavLink href="/admin/settings">휴가 설정</NavLink>
            </>
          )}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-sm text-slate-700">
            {employee ? employee.name : viewer.user.displayName}
            {employee && (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                {employee.rank.name}
              </span>
            )}
            {viewer.isAdmin && (
              <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-700">
                휴가 관리자
              </span>
            )}
          </span>
          <form action={logoutAction}>
            <button
              type="submit"
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              로그아웃
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
