import Link from "next/link";
import type { ReactNode } from "react";

import { logoutAction } from "@/app/actions/auth";
import type { Viewer } from "@/lib/auth/guards";
import { NavLink } from "./NavLink";

export function AppHeader({
  viewer,
  pendingCount,
  portalUrl = null,
  serviceMenu = null,
}: {
  viewer: Viewer;
  pendingCount: number;
  /**
   * 포털 앱 런처(`/apps`)의 주소. 「통합 로그인으로」 단추가 갈 곳이다.
   *
   * 🔴 **로그아웃과 다르다.** 이 단추는 세션을 끊지 않는다 — 그냥 포털 화면으로
   * 옮겨 갈 뿐이라 돌아오면 그대로 들어와 있다. 옆의 「로그아웃」은 이 사이트
   * 세션과 포털 세션을 **둘 다** 끊는다. 생김새가 나란해서 헷갈리기 쉬우므로
   * 하나는 링크(`<a>`)로, 하나는 서버 액션을 부르는 `<form>` 으로 둔다.
   *
   * 🔴 메뉴바와도 다르다. 메뉴바는 **다른 시스템**(A/S·계측기·개선요청…)으로
   * 건너뛰는 길이고, 이것은 **포털 자신**으로 돌아가는 길이다. 포털은 자기
   * 자신을 서비스 목록에 넣지 않아서 메뉴바에는 포털로 가는 칸이 없다.
   *
   * null 이면 그리지 않는다 — 통합 로그인이 설정되지 않아 포털 주소를 모르는
   * 경우다. 그 판단은 (internal)/layout.tsx 가 하고 거기에 까닭이 적혀 있다.
   */
  portalUrl?: string | null;
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

        {/*
          나가는 길이 모인 오른쪽 묶음.

          🔴 `flex-wrap` 이다(2026-09-21, 「통합 로그인으로」를 더하면서 켰다).
          폰(360px)에서 이 줄의 속폭은 328px 인데, 이 묶음 하나가 그보다 넓어질
          수 있다 — 휴가 관리자로 들어온 사람 기준(글자 14px·뱃지 12px):

            이름 3자 + 직급 뱃지                                  ~84px
            「휴가 관리자」 뱃지                                   ~72px
            「통합 로그인으로」 글자 87 + px-2.5 20 + 테두리 2    ~109px
            「로그아웃」       글자 48 + px-2.5 20 + 테두리 2      ~70px
            사이 여백 gap-x-3 셋                                   36px
            ──────────────────────────────────────────────────────────
            합                                                   ~371px  > 328

          바깥 <header> 는 flex-wrap 이라 이 묶음을 통째로 아랫줄로 내려 주지만,
          묶음 **안**은 한 줄이라 거기서 다시 넘친다. 줄바꿈이 없으면 flex 가
          칸을 min-content 까지 눌러 **단추 안에서 글자를 접는다** —
          "통합 / 로그인으로" 가 되어 머리말이 두꺼워진다(개선요청 머리말이
          지금 그 상태로 버티고 있다). 여기서는 켜는 편이 맞다: 이 머리말은
          애초에 flex-wrap 이고 폰에서 이미 여러 줄이라, 한 줄 더 쓰는 것이
          글자가 접히는 것보다 낫다.

          🔴 이름·뱃지를 폰에서 감추는 길(개선요청이 택한 sr-only)은 쓰지 않는다.
          저쪽은 flex-wrap 이 없어 감추는 것 말고 방법이 없었지만, 여기는 줄을
          바꿀 수 있으므로 보이던 것을 없앨 이유가 없다.

          🔴 `justify-end` 는 줄이 바뀐 뒤에만 일한다 — 아랫줄로 내려간 단추들이
          왼쪽에 붙어 `ml-auto` 로 오른쪽에 세운 윗줄과 어긋나 보이지 않게 한다.
        */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
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
          {/*
            🔴 아래 둘은 폰에서도 감추지 않는다 — 이 사이트를 떠나는 유일한
            길이다. 나란히 서 있지만 하는 일이 다르다:

              통합 로그인으로   포털 앱 런처로 **옮겨 간다**. 세션은 그대로다.
              로그아웃          이 사이트와 포털 세션을 **둘 다 끊는다.**

            그래서 앞엣것은 평범한 링크이고 뒤엣것만 서버 액션을 부른다.
            링크는 GET 이라 브라우저가 미리 당겨 갈 수 있는데, 로그아웃이 링크면
            그 미리 당기기만으로 사람이 쫓겨난다 — 둘을 가르는 진짜 이유다.
          */}
          {portalUrl && (
            <a
              href={portalUrl}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              통합 로그인으로
            </a>
          )}

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
