/**
 * 권한 판정은 여기서만 한다.
 *
 * 클라이언트가 보낸 사용자 ID·역할·직원 ID 는 절대 믿지 않는다.
 * 항상 서버에서 세션을 검증해 얻은 값만 쓴다.
 * 화면에서 버튼을 숨기는 것은 UI 편의일 뿐이고, 실제 차단은 반드시 서버에서 한다.
 *
 * 역할
 * - 직원      : 명단에 연결된 계정
 * - 결재권자  : 직원 중 직급의 결재권이 켜진 사람 (과장·부장·대표)
 * - 결재함    : 위 결재권자 **또는** 결재선에 이름이 오른 사람 (canOpenApprovals)
 * - 휴가 관리자: web_users.role = LEAVE_ADMIN
 */
import { and, eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { cache } from "react";

import { db } from "@/lib/db";
import {
  webApprovalRouteSteps,
  webEmployees,
  webRanks,
  type Employee,
  type Rank,
  type WebUser,
} from "@/lib/db/schema";
import { env } from "@/lib/env";
import { canOpenApprovalBox } from "@/lib/leave/approval-scope";
import { RETURN_TO_FALLBACK, safeReturnTo } from "./return-to";
import { getSessionUser } from "./session";

export type EmployeeWithRank = Employee & {
  rank: Rank;
  /**
   * 결재선(web_approval_route_steps)에 제 이름이 살아 있는가.
   *
   * 🔴 **왕복이 늘지 않는다** — 아래 `loadEmployee` 의 **같은 질의**가 exists
   * 하위 질의로 함께 읽는다. 이 파일은 모든 화면이 지나는 자리라 질의를 하나
   * 더 더하면 매 요청에 왕복이 하나 는다. 결재선 목록을 읽는 함수는 이미
   * 있지만(leave/data.ts 의 `loadApprovalRoute`) 쓰지 않았다: 질의가 하나
   * 늘고, 그 파일이 이 파일의 `canSeeReason` 을 값으로 가져다 쓰므로
   * 거꾸로 부르면 순환 import 가 된다.
   *
   * 퇴사·삭제 여부는 볼 필요가 없다 — `loadEmployee` 가 이미 재직 중인
   * 직원만 찾으므로, 여기까지 온 사람은 `loadApprovalRoute` 의 살아 있는
   * 결재선 구성원(active=true)과 같은 조건이다.
   */
  onApprovalRoute: boolean;
};

export type Viewer = {
  user: WebUser;
  /** 명단에 연결되지 않았거나 퇴사 처리된 계정이면 null */
  employee: EmployeeWithRank | null;
  isAdmin: boolean;
  /**
   * 🔴 **직급의 결재권**(web_ranks.can_approve)뿐이다. 뜻을 넓히지 않는다 —
   * 이 값은 사유 열람(`canSeeReason`)과 **사람 칸이 빈 옛 직급 단계**의 판정
   * (leave/approval-scope.ts)에도 그대로 넘어간다. 결재함 문을 열지 말지는
   * 아래 `canOpenApprovals` 가 따로 답한다.
   */
  isApprover: boolean;
  /**
   * 결재함을 열 수 있는가 — 직급에 결재권이 있거나 **결재선에 제 이름이
   * 올라 있으면** 열린다 (leave/approval-scope.ts 의 `canOpenApprovalBox`,
   * 까닭은 그 머리말에).
   *
   * 🔴 「이 단계를 결재할 수 있는가」와 다른 말이다. 문이 열려도 결재함이
   * 보여 주는 것은 내 단계뿐이고, 실제 승인·반려는 `decideStep` 이 단계마다
   * 다시 막는다.
   */
  canOpenApprovals: boolean;
};

export type Member = Viewer & { employee: EmployeeWithRank };

/**
 * 로그인 후 돌아갈 주소의 판정은 auth/return-to.ts 한 곳이 갖는다.
 *
 * 이 파일이 갖지 않는 이유: 그 판정은 import 가 하나도 없는 순수 함수여야
 * 시험할 수 있는데, 이 파일은 next/navigation 과 세션(→ DB)을 끌고 온다.
 * 여기서 다시 내보내는 것은 부르는 쪽(로그인 통로·로그인 화면·서버 액션)이
 * 「로그인 문지기」 한 곳만 알면 되게 하려는 것이다.
 *
 * 🔴 2026-09-21 까지 여기 **네 줄**짜리 판정이 있었다. 제어문자를 막지 않아
 * "/(탭)/evil.example" 이 그대로 통과했고(브라우저가 탭을 지우면 "//evil.example"
 * 이 된다), 한글이 든 주소는 응답 머리말에 실리지 못해 로그인이 500 으로 끝났다.
 * 무엇이 왜 더해졌는지는 return-to.ts 머리말에 적혀 있다.
 */
export { RETURN_TO_FALLBACK, RETURN_TO_MAX_LENGTH, safeReturnTo } from "./return-to";

export async function loadEmployee(
  employeeId: string,
): Promise<EmployeeWithRank | null> {
  const rows = await db
    .select({
      employee: webEmployees,
      rank: webRanks,
      // 결재선에 제 이름이 올라 있는가. 🔴 하위 질의로 **이 질의 안에서** 본다 —
      // 왕복을 늘리지 않으려는 것이다 (EmployeeWithRank 머리말).
      onApprovalRoute: sql<boolean>`exists (
        select 1 from ${webApprovalRouteSteps}
        where ${webApprovalRouteSteps.approverEmployeeId} = ${webEmployees.id}
          and ${webApprovalRouteSteps.isDeleted} = false
      )`,
    })
    .from(webEmployees)
    .innerJoin(webRanks, eq(webRanks.id, webEmployees.rankId))
    .where(
      and(
        eq(webEmployees.id, employeeId),
        eq(webEmployees.isDeleted, false),
        eq(webEmployees.isActive, true),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row
    ? { ...row.employee, rank: row.rank, onApprovalRoute: row.onApprovalRoute }
    : null;
}

/** 현재 요청의 사용자. 한 요청 안에서는 한 번만 읽는다. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const user = await getSessionUser();
  if (!user) return null;
  const employee = user.employeeId ? await loadEmployee(user.employeeId) : null;
  return {
    user,
    employee,
    isAdmin: user.role === "LEAVE_ADMIN",
    isApprover: Boolean(employee?.rank.canApprove),
    canOpenApprovals: employee
      ? canOpenApprovalBox({
          rankCanApprove: employee.rank.canApprove,
          onApprovalRoute: employee.onApprovalRoute,
        })
      : false,
  };
});

/**
 * 로그인 필수. 없으면 통합 로그인으로 보낸다.
 *
 * 포털 설정이 있으면 `/api/auth/sso/start` 로 **곧장** 보낸다. `/login` 을
 * 거치지 않는 이유: 그 화면에 있는 것이라고는 "포털로 가세요" 버튼 하나뿐이라
 * 포털 앱 런처에서 타일을 눌러 들어온 사람에게는 눌러야 할 버튼이 하나 느는
 * 일일 뿐이다.
 *
 * 포털 설정이 없으면(= 아직 등록 전이거나 임시 로그인만 쓰는 개발 PC)
 * `/login` 으로 보낸다 — 거기에 임시 로그인 뒷문이 있다.
 *
 * `/login` 화면 자체는 남는다: 로그인이 **거절됐을 때** 이유를 보여줄 자리가
 * 필요하고, 그 화면에서는 자동으로 다시 보내지 않는다(그러면 무한 왕복이 된다).
 */
export async function requireSession(returnTo?: string): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) {
    // 🔴 여기까지 온 값은 무엇이든 safeReturnTo 를 거친다. 부르는 쪽이 주소를
    // 어디서 얻었든(화면·링크·손으로 친 주소) 믿지 않는다.
    const target = safeReturnTo(returnTo);
    const base = env.ssoConfigured ? "/api/auth/sso/start" : "/login";
    redirect(
      target === RETURN_TO_FALLBACK
        ? base
        : `${base}?returnTo=${encodeURIComponent(target)}`,
    );
  }
  return viewer;
}

/**
 * 사내 화면에 들어올 수 있는가.
 * 명단에 연결되지 않은 계정은 '확인 대기' 화면으로 보낸다.
 * (단, 휴가 관리자는 명단 연결 전이라도 관리 화면을 쓸 수 있어야 한다)
 */
export async function requireViewer(): Promise<Viewer> {
  const viewer = await requireSession();
  if (!viewer.employee && !viewer.isAdmin) redirect("/pending");
  return viewer;
}

/** 명단에 연결된 직원이어야 하는 화면 (신청·내 휴가) */
export async function requireMember(): Promise<Member> {
  const viewer = await requireSession();
  if (!viewer.employee) {
    redirect(viewer.isAdmin ? "/admin/employees?needLink=1" : "/pending");
  }
  return viewer as Member;
}

/**
 * 결재함 문지기.
 *
 * 🔴 묻는 것은 `canOpenApprovals` 다 — **직급의 결재권이 아니다**(2026-09-22).
 * 결재선에 이름이 오른 사람은 직급에 결재권이 없어도 자기 차례가 되어 알림까지
 * 받는데, 예전처럼 `isApprover` 를 물으면 바로 그 사람이 홈으로 튕겨 나간다.
 *
 * 🔴 **지금 이 함수를 부르는 곳은 없다.** 결재함 화면과 결재 서버 액션은
 * `requireMember()` 로 들이고 「내 단계인가」를 질의·`decideStep` 에서 따로
 * 막는다(그쪽 머리말들). 그래도 지우지 않고 뜻을 맞춰 둔다 — 「결재자만 들어오는
 * 화면」이 다시 생길 때 여기서 옛 판정을 집어 가면 같은 결함이 되살아난다.
 */
export async function requireApprover(): Promise<Member> {
  const member = await requireMember();
  if (!member.canOpenApprovals) redirect("/");
  return member;
}

export async function requireAdmin(): Promise<Viewer> {
  const viewer = await requireSession();
  if (!viewer.isAdmin) redirect("/");
  return viewer;
}

/**
 * 휴가 사유를 볼 수 있는가: 본인과 결재권자만 (휴가 관리자라도 결재권이 없으면 못 본다)
 *
 * 🔴 `canOpenApprovals` 가 아니라 `isApprover`(직급의 결재권)를 묻는다 —
 * 결재함 문이 넓어진 것과 **사유 열람은 별개**다. 결재선에 이름만 오른 사람은
 * 달력에서 남의 사유를 보지 못하고, 자기 결재함에 든 신청의 사유만 본다
 * (그 화면은 이 함수를 거치지 않는다).
 */
export function canSeeReason(viewer: Viewer, requestEmployeeId: string): boolean {
  return viewer.isApprover || viewer.employee?.id === requestEmployeeId;
}
