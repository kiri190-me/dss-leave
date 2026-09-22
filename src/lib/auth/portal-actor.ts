/**
 * 포털이 토큰에 실어 온 사람을 이 사이트의 사람으로 되짚는다.
 *
 * 🔴 **잇는 열쇠는 `auth_sub` 하나뿐이다** — 로그인이 쓰는 그것과 같다
 * (sso-login.ts 머리말: 이름도 이메일도 바뀔 수 있고, 이메일로 이으면 언젠가
 * 남의 계정이 된다). 포털의 users 표는 여기서도 건드리지 않는다.
 *
 * 🔴 **그 사람의 값은 토큰에서만 온다.** 부르는 쪽이 준 쿼리나 본문에서 사람을
 * 고르지 않는다 — 그러면 토큰 하나로 아무 사람의 알림이나 볼 수 있다
 * (portal-service-token.ts 의 8번).
 *
 * 걸러 내는 줄은 화면과 **같다**: 삭제·정지된 계정은 없는 것으로 보고
 * (session.ts 의 getSessionUser 와 같은 조건), 명단 연결은 loadEmployee 가
 * 퇴사·삭제까지 걸러 준다(guards.ts). 통로만 느슨하면 정지된 사람의 밀린 일이
 * 남의 종에 계속 뜬다.
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { webUsers } from "@/lib/db/schema";
import { portalActorOf, type PortalActor } from "@/lib/leave/portal-notifications";
import { loadEmployee } from "./guards";
import { isValidSubject } from "./sso-role";

/**
 * 못 찾으면 null. 🔴 **오류가 아니다** — 포털은 여러 시스템에 같은 질문을
 * 던지고, 이 시스템에 아직 들어와 본 적 없는 사람은 흔하다.
 */
export async function findPortalActor(subject: string): Promise<PortalActor | null> {
  // auth_sub 는 uuid 열이다. 모양이 아닌 값으로 조회하면 드라이버가 던진다
  // (sso-login.ts 가 계정을 만들기 전에 같은 것을 본다).
  if (!isValidSubject(subject)) return null;

  const [user] = await db
    .select()
    .from(webUsers)
    .where(
      and(
        eq(webUsers.authSub, subject),
        eq(webUsers.isActive, true),
        eq(webUsers.isDeleted, false),
      ),
    )
    .limit(1);
  if (!user) return null;

  const employee = user.employeeId ? await loadEmployee(user.employeeId) : null;

  return portalActorOf({
    user,
    employee,
    // 화면과 같은 판정이다(guards.ts 의 getViewer) — 직급의 결재권. 옛 단계를
    // 직급으로 판정할 때만 쓰이지만, 두 곳이 다른 값을 쓰면 그 옛 단계가
    // 결재함과 알림 중 한쪽에만 나타난다.
    isApprover: Boolean(employee?.rank.canApprove),
  });
}
