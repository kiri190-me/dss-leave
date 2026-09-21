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
 * - 휴가 관리자: web_users.role = LEAVE_ADMIN
 */
import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { cache } from "react";

import { db } from "@/lib/db";
import {
  webEmployees,
  webRanks,
  type Employee,
  type Rank,
  type WebUser,
} from "@/lib/db/schema";
import { env } from "@/lib/env";
import { RETURN_TO_FALLBACK, safeReturnTo } from "./return-to";
import { getSessionUser } from "./session";

export type EmployeeWithRank = Employee & { rank: Rank };

export type Viewer = {
  user: WebUser;
  /** 명단에 연결되지 않았거나 퇴사 처리된 계정이면 null */
  employee: EmployeeWithRank | null;
  isAdmin: boolean;
  isApprover: boolean;
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
    .select({ employee: webEmployees, rank: webRanks })
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
  return row ? { ...row.employee, rank: row.rank } : null;
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

export async function requireApprover(): Promise<Member> {
  const member = await requireMember();
  if (!member.isApprover) redirect("/");
  return member;
}

export async function requireAdmin(): Promise<Viewer> {
  const viewer = await requireSession();
  if (!viewer.isAdmin) redirect("/");
  return viewer;
}

/** 휴가 사유를 볼 수 있는가: 본인과 결재권자만 (휴가 관리자라도 결재권이 없으면 못 본다) */
export function canSeeReason(viewer: Viewer, requestEmployeeId: string): boolean {
  return viewer.isApprover || viewer.employee?.id === requestEmployeeId;
}
