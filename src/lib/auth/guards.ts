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
 * - 결재함    : 위 결재권자 **또는** 결재선에 이름이 오른 사람 **또는** 지금
 *               유효한 결재권 위임을 받은 사람 (canOpenApprovals)
 * - 휴가 관리자: web_users.role = LEAVE_ADMIN **또는** 🔴 지금 LEAVE_ADMIN 이 맡긴
 *               결재권 위임을 받고 있는 사람 (2026-11-17, 기간 동안만 · isAdmin).
 *               🔴 뒤엣사람은 **역할 변경만** 못 한다 (auth/delegated-role.ts).
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
  type UserRole,
  type WebUser,
} from "@/lib/db/schema";
import { env } from "@/lib/env";
import { canOpenApprovalBox } from "@/lib/leave/approval-scope";
// 🔴 **역할 위임**(2026-11-17). 판정은 순수 모듈이, 표를 읽는 일은 위임 쪽 읽기
//    층이 한다 — 이 파일은 **역할을 읽는 유일한 자리**라서 그 둘을 여기서 잇는다.
import { decideDelegatedAdmin, needsDelegatorRoles, type DelegatedAdminDecision } from "./delegated-role";
import { loadActingForEmployeeIds, loadDelegatorRoles } from "./portal-delegations";
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
  /**
   * 🔴 **지금 이 사람이 대신 결재할 수 있는 사람들**의 명단 번호
   * (`web_employees.id`). 통합 승인함에서 맡긴 결재권 위임을 포털이 이 집 표에
   * 써 준 것을 읽은 값이다(설계 B-9·B-12, auth/portal-delegations.ts).
   *
   * 🔴 **여기 매단 까닭**: 이 값을 쓰는 곳이 넷인데(결재함 메뉴 · 대기 건수 배지 ·
   * 알림 종 · 결재 실행) 사람을 읽는 길은 **이 함수 하나**다. 각자 읽게 두면
   * 「메뉴는 있는데 배지가 0」처럼 **어긋나도 아무 오류가 안 나는** 모양이 된다.
   * 🔵 포털이 우리를 부르는 통로(`api/integration/*`)도 같은 길로 사람을 읽으므로
   * (auth/portal-actor.ts) 통합 승인함과 남의 종에도 저절로 따라간다.
   *
   * 🔴 **매 요청마다 다시 잰다.** 위임이 끝나면 다음 화면부터 빈 목록이 되고,
   * 그래서 메뉴도 배지도 저절로 닫힌다 — 만료를 적어 두는 칸이 없다는 것이 그
   * 보장이다(auth/portal-delegations.ts 의 `liveDelegationWhere`).
   */
  actingForEmployeeIds: readonly string[];
};

export type Viewer = {
  user: WebUser;
  /** 명단에 연결되지 않았거나 퇴사 처리된 계정이면 null */
  employee: EmployeeWithRank | null;
  /**
   * 휴가 관리자 문이 열리는가. 🔴 **진짜 `LEAVE_ADMIN` 이거나**, 🔴 **`LEAVE_ADMIN`
   * 이 맡긴 결재권 위임을 지금 받고 있으면**(2026-11-17) 참이다.
   *
   * 🔴 **`user.role` 로 다시 묻지 마라.** 승격은 이 칸에서만 일어난다 — 위임으로
   * 받은 관리자는 `user.role` 이 여전히 `MEMBER` 다(까닭은 auth/delegated-role.ts
   * 머리말: 감사 로그가 거짓말을 하지 않게 하려는 것이다). 역할 칸으로 울타리를
   * 적으면 임시 관리자만 조용히 거절당한다.
   */
  isAdmin: boolean;
  /**
   * 🔴 **그 관리자 자격이 결재권 위임에서 왔는가** (2026-11-17).
   *
   * 「권한이 있나」가 아니라 **「계정의 역할까지 바꿀 수 있나」를 가르는 값**이다 —
   * 임시 관리자에게 주지 않는 문이 그 하나뿐이라서다(까닭은
   * auth/delegated-role.ts 의 `mayChangeUserRole`).
   * 🔴 **진짜 `LEAVE_ADMIN` 은 위임을 받았든 안 받았든 언제나 `false`** 다. 자격이
   * 둘이면 높은 쪽이 이긴다 — 여기가 참이 되면 그 사람은 위임을 받았다는 이유만으로
   * 역할 변경을 잃는다.
   */
  delegatedAdmin: boolean;
  /**
   * 🔴 **직급의 결재권**(web_ranks.can_approve)뿐이다. 뜻을 넓히지 않는다 —
   * 이 값은 사유 열람(`canSeeReason`)과 **사람 칸이 빈 옛 직급 단계**의 판정
   * (leave/approval-scope.ts)에도 그대로 넘어간다. 결재함 문을 열지 말지는
   * 아래 `canOpenApprovals` 가 따로 답한다.
   */
  isApprover: boolean;
  /**
   * 결재함을 열 수 있는가 — 직급에 결재권이 있거나 **결재선에 제 이름이
   * 올라 있거나** 🔴 **지금 유효한 결재권 위임을 받았으면**(2026-11-16) 열린다
   * (leave/approval-scope.ts 의 `canOpenApprovalBox`, 까닭은 그 머리말에).
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

/**
 * 명단의 한 사람 + 결재에 필요한 두 가지 곁값(결재선에 있나 · 지금 누구를
 * 대신할 수 있나).
 *
 * 🔴 **질의 둘을 나란히 던진다**(`Promise.all`). 위임 목록은 결재선 여부처럼
 * 하위 질의로 접어 넣을 수가 없다 — 필요한 것이 「있나 없나」가 아니라 **번호
 * 목록**이고, 그것을 배열 하위 질의로 적으면 「살아 있는 위임」의 조건이 날
 * SQL 로 이 파일에 한 벌 더 생긴다. 그 조건은 한 곳에만 있어야 한다
 * (auth/portal-delegations.ts 의 `liveDelegationWhere`). 나란히 던지므로 **기다리는
 * 시간은 한 왕복**이고, 느린 쪽이 전체 시간을 정한다.
 */
export async function loadEmployee(
  employeeId: string,
): Promise<EmployeeWithRank | null> {
  const [rows, actingForEmployeeIds] = await Promise.all([
    db
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
      .limit(1),
    // 🔴 **지금** 유효한 위임만 읽는다. 기준 시각을 여기서 찍으므로 요청마다
    //    다시 재진다 — 기간이 끝나면 다음 화면부터 저절로 닫힌다.
    loadActingForEmployeeIds(employeeId),
  ]);
  const row = rows[0];
  return row
    ? {
        ...row.employee,
        rank: row.rank,
        onApprovalRoute: row.onApprovalRoute,
        actingForEmployeeIds,
      }
    : null;
}

/**
 * 🔴 **결재권 위임이 역할까지 넘긴다** (2026-11-17). `LEAVE_ADMIN` 이 맡긴 위임의
 * 대리인은 **그 기간 동안** 휴가 관리자다. 뜻과 까닭은 auth/delegated-role.ts 머리말.
 *
 * 🔴 **DB 의 역할 칸을 바꿔 쓰지 않는다.** 아래 `getViewer` 가 매 요청마다 돌기
 * 때문에 여기서 계산하면 기간이 끝날 때 **저절로** 닫힌다 — 밤에 도는 작업표도,
 * 만료 처리도 필요 없고, 「여는 조건과 닫는 조건이 다른 곳에」 생기지도 않는다.
 *
 * 🔴 **거르는 규칙을 한 줄도 새로 안 적는다.** 기간(반열린 구간)·철회 판정은 넘겨
 * 받는 목록이 **이미** 끝낸 일이다(portal-delegations.ts 의 `liveDelegationWhere`
 * 한 곳). 이 함수가 제 손으로 하는 일은 **「역할을 읽어다 판정에 넘기기」** 하나다.
 *
 * 🔴 **왕복이 늘지 않는 길이 하나 있어 그것을 골랐다.** 「내가 대신하는 사람들」은
 * `loadEmployee` 가 **이미** 읽어 온 값이다(결재함 메뉴·배지·종이 쓰는 그 목록).
 * 여기서 위임 표를 다시 묻지 않고 그 결과를 그대로 받는다 — 다시 물으면 같은 조건을
 * 두 번 재게 되고, 그 둘이 다른 순간을 보는 날 「결재는 되는데 역할은 안 넘어오는」
 * 짝이 생긴다.
 *
 * 🔴 **못 읽으면 던진다**(삼키지 않는다). 여기까지 왔다는 것은 바로 앞 두 질의가
 * 같은 DB 에서 이미 성공했다는 뜻이라, 이 자리에서 터진 요청은 어차피 한 줄도 못
 * 그린다. 삼키면 **위임만 조용히 안 듣는** 상태가 되는데, 그것이 이 저장소들에서
 * 가장 비싼 결함 모양이다(portal-delegations.ts 의 입구들이 같은 말을 한다).
 */
async function resolveDelegatedAdmin(
  ownRole: UserRole,
  actingForEmployeeIds: readonly string[],
): Promise<DelegatedAdminDecision> {
  // 🔴 묻지 않는 가지도 **같은 판정 함수**를 지난다. 여기서 값을 손으로 지어내면
  //    「진짜 관리자」의 뜻이 두 곳에 생긴다.
  if (!needsDelegatorRoles(ownRole, actingForEmployeeIds)) return decideDelegatedAdmin(ownRole, []);
  return decideDelegatedAdmin(ownRole, await loadDelegatorRoles(actingForEmployeeIds));
}

/** 현재 요청의 사용자. 한 요청 안에서는 한 번만 읽는다. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const user = await getSessionUser();
  if (!user) return null;
  const employee = user.employeeId ? await loadEmployee(user.employeeId) : null;
  // 🔴 **명단에 안 이어진 계정은 위임을 받을 수 없다.** 위임 표의 대리인 칸이 명단
  //    번호라 적힐 자리가 없다 — 그래서 빈 목록이고, 역할도 안 넘어온다.
  const delegated = await resolveDelegatedAdmin(user.role, employee?.actingForEmployeeIds ?? []);
  return {
    user,
    employee,
    isAdmin: delegated.isAdmin,
    delegatedAdmin: delegated.delegatedAdmin,
    isApprover: Boolean(employee?.rank.canApprove),
    canOpenApprovals: employee
      ? canOpenApprovalBox({
          rankCanApprove: employee.rank.canApprove,
          onApprovalRoute: employee.onApprovalRoute,
          // 🔴 **빠뜨리면 위임만 받은 사람에게 결재함 메뉴가 안 그려진다** —
          //    오류 하나 없이 「결재함이 없는 사람」이 된다(2026-11-16 조각 5
          //    에서 실제로 그랬다). 같은 값이 결재 판정에도 그대로 간다
          //    (leave/data.ts 의 `deciderOf`) — 한 번 읽어 둘에 쓴다.
          actingForEmployeeIds: employee.actingForEmployeeIds,
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
