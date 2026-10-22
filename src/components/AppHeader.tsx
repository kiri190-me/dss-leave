import Link from "next/link";
import type { ReactNode } from "react";

import { logoutAction } from "@/app/actions/auth";
import type { Viewer } from "@/lib/auth/guards";
import { HeaderMenuDismiss } from "./HeaderMenuDismiss";
import { NavLink } from "./NavLink";

/**
 * 「통합 로그인으로」·「로그아웃」의 생김새. **두 자리가 같은 값을 쓴다** — 넓은 화면의
 * 오른쪽 끝과 ☰ 서랍 안이다. 두 벌로 적으면 한쪽만 고쳐 둘이 달라 보이는 날이 온다.
 *
 * 🔴 2026-10-22 이전에 두 단추가 쓰던 글자와 **한 글자도 다르지 않다.** 넓은 화면이
 *    폰 작업으로 달라지지 않게 그대로 옮겨 적은 것이다.
 */
const HEADER_BUTTON =
  "rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50";

/**
 * 화면 링크들. **넓은 화면의 가로 메뉴와 ☰ 서랍이 이 조각 하나를 함께 쓴다** —
 * 생김새(`look`)만 다르다.
 *
 * 🔴 두 벌로 베껴 적지 않는 까닭: 여기 달린 자격 규칙(`employee`·`canOpenApprovals`·
 *    `isAdmin`)이 갈리면 **폰과 컴퓨터가 서로 다른 메뉴를 그린다.** 베낀 쪽은 고칠 때
 *    잊히고, 그 어긋남은 아무 오류도 내지 않는다.
 * 🔵 2026-10-22 에 이 조각으로 묶으면서 **규칙은 한 줄도 바꾸지 않았다** — 그 전에
 *    머리말 본문에 있던 것을 그대로 옮긴 것뿐이다.
 */
function ScreenLinks({
  viewer,
  pendingCount,
  look,
}: {
  viewer: Viewer;
  pendingCount: number;
  look: "bar" | "panel";
}) {
  const { employee } = viewer;
  return (
    <>
      <NavLink href="/" exact look={look}>
        달력
      </NavLink>
      {employee && (
        <>
          <NavLink href="/leave/new" look={look}>
            휴가 신청
          </NavLink>
          <NavLink href="/leave" exact look={look}>
            내 휴가
          </NavLink>
        </>
      )}
      {/*
        🔴 `viewer.isApprover`(직급의 결재권)가 아니라 `canOpenApprovals` 를
        묻는다 (2026-09-22). 결재선에 이름이 오른 사람은 직급에 결재권이
        없어도 자기 차례가 되면 알림을 받는데, 직급으로만 그리면 그 사람
        머리말에는 **들어갈 메뉴가 없다.** 두 값이 왜 갈렸는지는
        lib/leave/approval-scope.ts 의 canOpenApprovalBox 머리말에 있다.
      */}
      {viewer.canOpenApprovals && (
        <NavLink href="/approvals" look={look}>
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
          {/*
            관리자 메뉴 앞의 구분선. 🔵 가로 메뉴에서는 **세로 선**, 서랍에서는
            **가로 선**이다 — 같은 뜻을 그 자리에 맞게 그린 것뿐이라 조건은 하나다.
          */}
          <span
            className={
              look === "panel" ? "my-1 block h-px bg-slate-200" : "mx-1 h-5 w-px bg-slate-200"
            }
            aria-hidden
          />
          <NavLink href="/admin/employees" look={look}>
            직원 관리
          </NavLink>
          <NavLink href="/admin/settings" look={look}>
            휴가 설정
          </NavLink>
        </>
      )}
    </>
  );
}

/**
 * 나가는 길이 모인 묶음 — 이름·직급·「휴가 관리자」 배지 + [통합 로그인으로] + [로그아웃].
 * **넓은 화면의 오른쪽 끝과 ☰ 서랍 바닥이 이 조각 하나를 함께 쓴다.**
 *
 * 🔴 차례(이름 → 통합 로그인으로 → 로그아웃)는 두 자리가 같다. 일부러 맞춰 둔 것이다.
 *
 * ── 🔴 2026-10-22 이전의 폭 셈 — 이제는 **넓은 화면에만** 해당한다 ──────────
 * 아래 주석은 이 묶음이 폰에서도 머리말에 서 있던 때 잰 것이다. 2026-10-22 에 폰
 * (768px 미만)에서는 이 묶음이 통째로 ☰ 서랍 안으로 들어갔으므로, **그 숫자들이
 * 말하던 상황은 이제 일어나지 않는다.** 지우지 않고 남겨 둔다 — 「폰에서 왜 줄바꿈이
 * 켜져 있나」와 「종이 왜 맨 오른쪽인가」의 까닭이 거기 적혀 있고, 둘 중 뒤엣것은
 * 지금도 그대로 유효하다.
 *
 *   🔴 `flex-wrap` 이다(2026-09-21, 「통합 로그인으로」를 더하면서 켰다).
 *   폰(360px)에서 이 줄의 속폭은 328px 인데, 이 묶음 하나가 그보다 넓어질
 *   수 있다 — 휴가 관리자로 들어온 사람 기준(글자 14px·뱃지 12px):
 *
 *     이름 3자 + 직급 뱃지                                  ~84px
 *     「휴가 관리자」 뱃지                                   ~72px
 *     「통합 로그인으로」 글자 87 + px-2.5 20 + 테두리 2    ~109px
 *     「로그아웃」       글자 48 + px-2.5 20 + 테두리 2      ~70px
 *     사이 여백 gap-x-3 셋                                   36px
 *     ──────────────────────────────────────────────────────────
 *     합                                                   ~371px  > 328
 *
 *   바깥 header 는 flex-wrap 이라 이 묶음을 통째로 아랫줄로 내려 주지만,
 *   묶음 **안**은 한 줄이라 거기서 다시 넘친다. 줄바꿈이 없으면 flex 가
 *   칸을 min-content 까지 눌러 **단추 안에서 글자를 접는다** —
 *   "통합 / 로그인으로" 가 되어 머리말이 두꺼워진다(개선요청 머리말이
 *   지금 그 상태로 버티고 있다). 여기서는 켜는 편이 맞다: 이 머리말은
 *   애초에 flex-wrap 이고 폰에서 이미 여러 줄이라, 한 줄 더 쓰는 것이
 *   글자가 접히는 것보다 낫다.
 *
 *   🔴 이름·뱃지를 폰에서 감추는 길(개선요청이 택한 sr-only)은 쓰지 않는다.
 *   저쪽은 flex-wrap 이 없어 감추는 것 말고 방법이 없었지만, 여기는 줄을
 *   바꿀 수 있으므로 보이던 것을 없앨 이유가 없다.
 *   🔵 2026-10-22 덧붙임 — 폰에서는 이제 **감추는 것이 아니라 서랍으로 옮겼다.**
 *      ☰ 를 열면 이름도 배지도 그대로 다 보인다. 없애지 않는다는 위 결정은 그대로다.
 *
 *   🔴 `justify-end` 는 줄이 바뀐 뒤에만 일한다 — 아랫줄로 내려간 단추들이
 *   왼쪽에 붙어 `ml-auto` 로 오른쪽에 세운 윗줄과 어긋나 보이지 않게 한다.
 */
function AccountBox({
  viewer,
  portalUrl,
  look,
}: {
  viewer: Viewer;
  portalUrl: string | null;
  look: "bar" | "panel";
}) {
  const { employee } = viewer;
  const panel = look === "panel";
  return (
    <div
      className={
        panel
          ? "mt-3 flex flex-col items-stretch gap-2 border-t border-slate-200 pt-3"
          : "hidden flex-wrap items-center justify-end gap-x-3 gap-y-1.5 md:flex"
      }
    >
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

        🔵 2026-10-22 덧붙임 — 폰에서 이 둘은 ☰ 서랍 바닥에 선다. 감춘 것이
           아니라 자리를 옮긴 것이다(위 머리말의 같은 날 주석).
      */}
      {portalUrl && (
        <a href={portalUrl} className={panel ? `${HEADER_BUTTON} block text-center` : HEADER_BUTTON}>
          통합 로그인으로
        </a>
      )}

      <form action={logoutAction}>
        <button type="submit" className={panel ? `${HEADER_BUTTON} w-full` : HEADER_BUTTON}>
          로그아웃
        </button>
      </form>
    </div>
  );
}

export function AppHeader({
  viewer,
  pendingCount,
  portalUrl = null,
  serviceMenu = null,
  notificationBell = null,
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
  /**
   * 알림 종(@dss/ui 의 NotificationBell). 메뉴바와 **같은 방식**으로 받는다 —
   * 다 그려진 노드다. 이 파일은 @dss/ui 도, 알림을 어디서 구하는지도 모른다.
   *
   * (internal)/layout.tsx 가 `<Suspense>` 로 감싼 조각을 내려보내므로, 포털이
   * 느려도 이 머리말은 기다리지 않는다 — 종만 나중에 흘러 들어온다.
   *
   * 🔴 그릴 알림이 없으면 그 조각이 **스스로 null** 이다(@dss/ui 의 판단 —
   * 눌러도 아무것도 없는 단추를 머리말에 남기지 않는다). 그래서 래퍼 <div> 로
   * 감싸지 않고 **flex 항목으로 그대로** 둔다: 감싸면 알림이 없을 때도 빈
   * 항목과 그 앞 여백(gap-x-3 12px)이 남아 머리말이 예전과 달라진다.
   */
  notificationBell?: ReactNode;
}) {
  /**
   * 🔴 결재함 배지와 ☰ 의 점이 **같은 값**을 본다. 폰에서는 배지가 서랍 안으로
   *    숨으므로, 「할 일이 있다」는 사실만은 접힌 채로도 보여야 한다(아래 summary).
   *    두 곳이 서로 다른 셈을 쓰면 서랍을 열기 전과 연 뒤가 다른 말을 한다.
   *    가리는 조건도 결재함 메뉴와 같다 — 문이 안 열리는 사람에게 점만 찍으면
   *    눌러서 갈 곳이 없다.
   */
  const hasPending = viewer.canOpenApprovals && pendingCount > 0;

  return (
    // 🔴 overflow-hidden 을 걸지 않는다. 메뉴바를 펼친 목록은 단추 아래로
    // **떠서**(position:absolute) 그려지므로 머리말이나 그 조상이 넘치는 것을
    // 자르면 목록이 잘린다(@dss/ui README 3절).
    //
    // ── 🔴 머리말은 굴러도 화면 위에 남는다 (2026-10-22) ───────────────────
    // 🔴 position 은 한 요소에 하나다. 여기에 relative·absolute 를 함께 적지 마라 —
    //    Tailwind 가 CSS 를 찍는 차례에 따라 한쪽이 **조용히** 이기고, 지는 날
    //    머리말이 안 고정되거나 서랍의 기준이 어긋난다.
    // 🔴 바깥((internal)/layout.tsx)이 flex min-h-full flex-col 이고 이를 막는
    //    overflow 가 조상에 없어 그대로 먹는다.
    // 🔴 z 값 30 은 **재 본 값**이다 (2026-10-22). 이 저장소의 src 아래에는 z 를 쓰는
    //    자리가 **하나도 없어서**(본문 쪽 최대 0) 30 이면 그 위다. 그래도 숫자를 0 이
    //    아니라 30 으로 둔 까닭은 쌓임 맥락이다: sticky 에 z 를 주면 머리말이 제
    //    맥락을 만들고, 그 뒤로 머리말 **안**의 z(메뉴바 목록 50 · 종 목록 50 — 둘 다
    //    공용 묶음의 CSS · 아래 서랍 60)는 전부 그 안에서만 겨루며 바깥과는 이 30
    //    하나로 겨룬다. 그래서 본문에 30 이상을 더하는 날에는 **이 값도 함께 올려야
    //    한다** — 안 올리면 머리말이 덮이는데 오류는 안 난다.
    // 🔵 인쇄에서 고정을 되돌리는 클래스를 따로 두지 않았다. 이 머리말은 `no-print`
    //    라 인쇄에서 **통째로 사라지므로**(globals.css 의 @media print) 되돌릴
    //    position 자체가 없다. 🔴 언젠가 no-print 를 떼는 날에는 인쇄용으로
    //    position 을 static 으로 돌리는 클래스를 **반드시 함께** 더해라 —
    //    안 그러면 쪽마다 겹쳐 찍히거나 첫 쪽 본문을 가린다. 그 짝을 검사가 지킨다.
    <header className="no-print sticky top-0 z-30 border-b border-slate-200 bg-white">
      {/*
        🔵 위아래를 한꺼번에 주던 패딩이 위·아래로 갈린 까닭: 머리말이 화면 맨 위에
        고정되면서 **노치 밑에 깔릴 수 있는 맨 위 요소**가 됐다. 🔴 패딩과 인셋은
        **한 클래스 안에서 calc 로 더해야** 한다 — 위아래를 한꺼번에 주는 클래스를 둔 채
        인셋을 따로 걸면 같은 padding-top 을 두 클래스가 다투고, 지는 날 아이폰에서
        인셋이 조용히 사라진다.
        인셋이 0인 기기에서는 정확히 10px 이라 예전(위아래 10px)과 **픽셀 단위로 같다.**
        🔵 이 앱은 아직 viewport-fit=cover 를 켜지 않아 인셋이 늘 0 이다 — 켜는 날 저절로 맞는다.
        🔴 이 주석에 그 클래스 이름을 **대괄호째 적지 마라.** Tailwind 는 주석까지 긁어
           가짜 클래스를 CSS 로 찍으려 들고, 줄임표가 섞이면 globals.css 가 통째로 깨진다.
      */}
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-[calc(0.625rem+env(safe-area-inset-top))] pb-2.5">
        {/*
          ☰ — 768px 미만에서만 선다. 🔴 **머리말 맨 왼쪽**이다, 시스템 이름보다도 앞
          (A/S 시스템·재고관리와 같은 모양. 2026-10-22).

          🔴 접는 경계 768px 은 공용 묶음(@dss/ui)의 메뉴바가 단추 이름을 감추는 폭과
             **같은 값**이다(service-menu.css 의 미디어 질의 — 거기 주석이 「사이트가 그
             폭에서 햄버거를 감춘다」를 전제로 적혀 있다). 한쪽만 옮기면 두 단추의 모양이
             어긋난다.
          🔴 768px 이상에서는 통째로 안 그려진다(md:hidden) — 그래서 넓은 화면은 머리말이
             위에 고정되는 것 말고는 예전과 글자 하나 다르지 않다.
          🔴 `shrink-0` — 이 줄에서 눌려도 되는 것은 글자뿐이다. 없으면 좁은 폭에서 flex 가
             단추 크기를 깎아 **손가락에 안 잡히는 크기**가 된다.
          🔴 `<details>` 라서 **자바스크립트를 쓰지 않는다.** `useState` 로 여닫으려면 이
             파일이 통째로 클라이언트로 내려가야 하는데, 그 경계가 깨지면 **검사가 다
             통과해도 화면이 안 열리는** 종류의 결함이 생기고 `npm run build` 에서만
             드러난다. 여는 일은 브라우저에 맡긴다.
             🔵 그 대가 하나를 아래 <HeaderMenuDismiss /> 가 갚는다 — 서랍 안의 링크를 눌러
                화면을 옮겨도 서랍이 열린 채 남는 것(머리말은 레이아웃이라 다시 그려지지
                않고 open 은 브라우저가 쥔 값이다). **아무것도 그리지 않는 조각**이라 이
                파일은 그대로 서버 컴포넌트다.
          🔴 `<summary>` 앞의 ▶ 삼각형은 `list-none`(파이어폭스·크롬)과 웹킷 표식 감추기
             (사파리) **둘 다** 꺼야 사라진다.
          🔴 `data-header-menu` 는 모양이 아니라 **표식**이다 — HeaderMenuDismiss 가
             「우리 ☰」만 골라 집는 손잡이로 쓴다. 이 칸을 지우거나 이름을 바꾸면 서랍이
             **저절로 안 접히는데 오류도 안 난다.**
        */}
        <details className="shrink-0 md:hidden" data-header-menu="">
          <summary
            className="relative flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-md text-slate-700 select-none hover:bg-slate-100 [&::-webkit-details-marker]:hidden"
            // 🔴 접으면 결재함의 대기 건수 배지가 서랍 안으로 숨는다 — **할 일이 있다는
            //    사실**만은 접힌 채로도 보여야 해서 아래 점을 찍고, 화면 낭독기에는
            //    이름으로 말한다. 세는 값은 여전히 하나다(위 hasPending).
            aria-label={hasPending ? `메뉴 — 결재 대기 ${pendingCount}건` : "메뉴"}
          >
            <span aria-hidden="true" className="text-lg leading-none">
              ☰
            </span>
            {hasPending ? (
              <span
                aria-hidden="true"
                className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-white"
                title="결재 대기"
              />
            ) : null}
          </summary>
          {/*
            서랍을 **저절로 접는** 조각. 아무것도 그리지 않는다 — 마크업이 한 글자도 늘지
            않으므로 아래 서랍의 모양과 차례는 그대로다.
            🔵 이 조각이 없어도(스크립트가 아직 안 붙었어도) ☰ 는 눌러서 열리고 다시 눌러
               접힌다. 더해지는 것은 **접히는 때** 셋뿐이다 — 까닭은 그 파일 머리말에.
          */}
          <HeaderMenuDismiss />
          {/*
            서랍 — 왼쪽에서 나온다 (A/S 시스템·재고관리와 같은 모양).

            🔴 `fixed` 는 **화면**에 매달린다 — 머리말에 매달리지 않는다. 위 `sticky` 는
               position:fixed 의 기준(containing block)을 만들지 않으므로(그것을 만드는
               것은 transform·filter·contain 같은 것들이다) 머리말 안에 적어도 화면 전체를
               덮는다.
            🔴 z 는 **머리말 안에서만** 겨룬다(머리말이 쌓임 맥락이다 — 위 header 주석).
               같은 맥락에 메뉴바의 펼친 목록과 종의 펼친 목록이 각각 50 으로 들어와 있다.
               서랍은 화면을 덮는 것이므로 둘보다 위여야 해서 60 으로 둔다.
            🔵 인쇄 숨김을 여기 또 적지 않는다 — 머리말 전체가 이미 `no-print` 다.
          */}
          <div className="fixed inset-0 z-[60] flex">
            {/*
              검은 바탕. 🔴 **반드시 `<button>` 이어야 한다** — 모양 때문이 아니라
              **눌러서 닫히게 하려고** 그렇다.

              서랍이라서 이 바탕이 `<details>` **안**에 있다. 그래서 HeaderMenuDismiss 의
              「바깥 누르기」(pointerdown)에는 **안 걸린다** — 안이니까. 걸리는 길은 다른
              쪽이다: 서랍 **안**은 click 으로 듣고, 눌린 것이 거기 PANEL_ACTIONS 에
              걸릴 때만 접는다. 이것이 `<button>` 이면 그대로 접히고, 평범한 `<div>` 면
              **눌러도 아무 일이 없는데 오류도 안 난다.**
              🔴 규칙이 두 파일에 흩어져 있어 한쪽만 바뀌면 조용히 깨진다 — 두 파일을
                 맞대어 보는 검사가 scripts/test-app-header.ts 에 있다.
              🔴 `type="button"` 을 빠뜨리지 마라. 빠지면 기본값이 `submit` 이다. 같은
                 서랍 안에 [로그아웃]의 `<form>` 이 있어, 마크업을 조금만 손대면 **누를
                 때마다 로그아웃된다.**
            */}
            <button type="button" aria-label="메뉴 닫기" className="absolute inset-0 bg-black/40" />
            {/*
              서랍 본체. 🔴 아래쪽 인셋 패딩의 까닭: 서랍은 화면 높이를 꽉 채우므로, 없으면
              **맨 아래 칸**(로그아웃)이 홈 인디케이터/제스처 바에 겹쳐 눌리지 않는다.
              🔴 패딩과 인셋은 **한 클래스 안에서** 더한다 — 따로 두면 같은 padding-bottom 을
                 두 클래스가 다투고, 지는 날 아이폰에서 인셋이 조용히 사라진다. 인셋이 0인
                 기기에서는 정확히 12px 이다.
              🔵 `overflow-y-auto`(+`min-h-0`) — 가로로 눕힌 폰에서는 메뉴가 화면보다 길다.
                 `overscroll-contain` 은 끝까지 민 스크롤이 뒤 페이지로 새는 것을 막는다.
            */}
            <div className="relative z-50 flex min-h-0 w-64 flex-col overflow-y-auto overscroll-contain border-r border-slate-200 bg-white px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
              <nav aria-label="화면" className="flex flex-col gap-0.5">
                <ScreenLinks viewer={viewer} pendingCount={pendingCount} look="panel" />
              </nav>
              {/*
                빈 칸막이 — 아래 묶음을 **서랍 바닥**에 붙인다.

                🔴 **`mt-auto` 를 쓰지 않은 까닭.** 아래 묶음에 margin-top:auto 를 주면 자리가
                   남을 때는 잘 내려가지만, 메뉴가 **서랍보다 길어지는 순간**(가로로 눕힌 폰 ·
                   글자 크기를 키운 기기 · 메뉴가 더 느는 날) 남는 자리가 없어 auto 가 **0 으로
                   풀린다.** 그러면 지금 보장돼 있는 구분선 위 12px 간격(AccountBox 의 mt-3)이
                   사라져 구분선이 마지막 링크에 바짝 달라붙는다 — 간격이 가장 필요한 때에
                   없어지는데 오류는 한 줄도 안 나고 눈에만 드러난다.
                🔵 **칸막이는 두 경우가 모두 옳다.** 서랍 본체가 세로 flex 이고 높이가 화면에
                   매여 있으므로(바깥이 fixed inset-0),
                    · 자리가 남으면 `grow` 가 남는 자리를 **전부** 가져가 아래 묶음이 바닥에 붙고,
                    · 내용이 길어지면 남는 자리가 없어 칸막이가 **높이 0** 으로 줄어 예전과
                      픽셀 단위로 같은 모양이 된다(스크롤도 그대로 생긴다).
                🔴 **빈 div 라고 지우지 마라.** 지우면 아래 묶음이 다시 링크 바로 밑으로
                   올라붙는데 오류는 안 난다. 그것을 검사가 못 박는다.
                🔵 `aria-hidden` — 아무것도 그리지 않으므로 낭독기에 알릴 것이 없다.
                🔵 HeaderMenuDismiss 의 「안쪽을 누르면 접는다」 규칙은 링크·단추만 본다 —
                   칸막이는 둘 다 아니라 거기 안 걸린다. 눌러도 아무 일이 없다(맞다).
              */}
              <div aria-hidden="true" className="grow" />
              <AccountBox viewer={viewer} portalUrl={portalUrl} look="panel" />
            </div>
          </div>
        </details>

        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tracking-tight text-slate-900">휴가 관리</span>
          <span className="text-xs font-medium text-slate-400">DSS</span>
        </Link>

        {/*
          사내 시스템 오가기 단추. 폰에서 이 줄이 넘치면 이 머리말은 이미
          flex-wrap 이라 메뉴·사용자 칸이 아랫줄로 내려간다 — 가로로 삐져나가
          잘리지 않는다. 단추 자체는 서비스가 몇이든 폭이 그대로다(드롭다운).

          🔴 2026-10-22 덧붙임 — 이 단추는 ☰ 서랍 **밖**에서 늘 보인다. 접으면 다른
             시스템으로 갈 길이 함께 사라지기 때문이다. 폰에서는 공용 묶음 쪽 CSS 가
             단추 이름을 감춰 아이콘 하나로 줄어들므로 자리를 거의 안 먹는다.
        */}
        <div className="shrink-0">{serviceMenu}</div>

        {/*
          넓은 화면의 가로 메뉴. 🔵 768px 미만에서는 이 줄이 통째로 사라지고 **같은
          링크가 ☰ 서랍 안에 세로로** 선다(같은 ScreenLinks 조각이다 — 자격 규칙이 두
          벌이 되지 않게).
        */}
        <nav aria-label="화면" className="hidden flex-wrap items-center gap-1 md:flex">
          <ScreenLinks viewer={viewer} pendingCount={pendingCount} look="bar" />
        </nav>

        {/*
          오른쪽 끝. 🔵 2026-10-22 에 **묶음이 둘로 갈렸다** — 나가는 길(이름·통합
          로그인으로·로그아웃)은 768px 미만에서 ☰ 서랍으로 들어가고, 알림 종만 폰에서도
          여기 남는다. 넓은 화면에서는 둘이 gap-x-3(12px) 사이로 나란히 서서 예전과 같다.

          ── 🔴 종이 왜 맨 끝인가 (2026-09-21 · 2026-10-22 에도 그대로) ──────────
          까닭은 폭이 아니라 **펼친 목록**에 있다: 목록은 종에 오른쪽 끝을 맞춰
          왼쪽으로 펼쳐지고(그쪽 CSS 의 `right: 0`) 폭이 `min(20rem, 100vw - 2rem)` 이다.
          폰(360px)에서 그 폭은 320px 이라, 종이 줄 가운데쯤(예: 이름 앞)에 앉으면
          목록 왼쪽이 **화면 밖으로 나가 잘린다.** 맨 끝에 있으면 목록 오른쪽이 머리말
          여백(16px)에 맞아 320px 이 화면 안에 그대로 들어온다(왼쪽 끝 24px).
          🔵 2026-10-22 에 나가는 길이 서랍으로 들어가면서, 폰에서 이 줄의 오른쪽 끝에
             남는 것은 **종 하나**가 됐다. 전제는 그대로다 — 종 오른쪽에 무언가를
             더하는 날 목록이 잘린다.

          🔴 그리고 알림이 없으면 종은 **아예 안 그려진다**(조각이 스스로 null 이다).
             그래서 래퍼 <div> 로 감싸지 않는다 — 감싸면 빈 flex 항목과 그 앞 여백
             12px 이 늘 남아 머리말이 예전과 달라진다.
        */}
        <div className="ml-auto flex items-center gap-x-3">
          <AccountBox viewer={viewer} portalUrl={portalUrl} look="bar" />
          {notificationBell}
        </div>
      </div>
    </header>
  );
}
