/**
 * 포털에 맡긴 결재권 위임을 **이 사이트의 직원 번호로** 받아 오는 배선.
 *
 * 세 조각이 여기서 만난다:
 *  · 묻기      auth/oidc.ts 의 `fetchPortalActingSubjects` (포털과 이야기하는
 *              유일한 파일이다 — 주소도 자격증명도 거기 한 곳에만 있다)
 *  · 바꾸기    아래 `findEmployeeIdsBySubjects` (DB)
 *  · 판단      leave/approval-delegation.ts (DB 도 망도 모르는 순수 판단)
 *
 * 🔴 **두 단 변환이 이 파일의 핵심**이다. 들어오는 쪽(auth/portal-actor.ts 의
 * `findPortalActor`)이 한 사람에게 하는 일을 여러 사람에게 한 번에 하는 것이고,
 * 걸러 내는 줄은 **그 함수와 같다** — 정지·삭제된 계정은 없는 것으로 본다.
 * 거기만 느슨하면 이미 내보낸 사람의 결재권이 남에게 계속 살아 있게 된다.
 *
 * 🔴 **왜 portal-actor.ts 에 같이 두지 않았나.** 그 파일은 **들어오는** 쪽이다
 * (포털이 토큰으로 「이 사람」을 들고 와 결재함을 묻는다). 이것은 **나가는**
 * 쪽이고, 못 물었을 때의 처신도 다르다 — 저쪽은 빈 답이면 그만이지만 여기는
 * 사람이 결재를 못 누르는 결과로 이어져 안내까지 띄워야 한다(설계 B-7).
 */
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { webUsers } from "@/lib/db/schema";
import { env } from "@/lib/env";
import {
  NO_PORTAL_DELEGATIONS,
  resolveActingDelegations,
  type DelegatedApproverRow,
  type PortalActingDelegations,
} from "@/lib/leave/approval-delegation";
import { fetchPortalActingSubjects } from "./oidc";
import { isValidSubject } from "./sso-role";

/**
 * 포털 번호들 → 이 시스템의 계정·명단.
 *
 * 🔴 **못 찾은 번호를 채워 넣지 않는다.** 돌려주는 줄 수가 물어본 번호 수보다
 * 적은 것이 곧 「바꾸지 못한 수」이고, 그것을 세는 자리는 판단 쪽이다
 * (leave/approval-delegation.ts).
 *
 * 🔴 **명단에 안 이어진 계정도 그대로 올려 준다**(`employeeId: null`). 여기서
 * 버리면 「계정이 아예 없는 사람」과 섞여, 휴가 관리자가 계정만 이어 주면 풀릴
 * 일을 영영 못 알아챈다.
 *
 * 🔴 uuid 모양이 아닌 번호는 **묻기 전에 버린다** — `auth_sub` 는 uuid 열이라
 * 모양이 아닌 값으로 조회하면 드라이버가 던진다(portal-actor.ts 의 같은 줄).
 * 버려진 번호는 줄 수 차이로 셈에 잡힌다.
 */
export async function findEmployeeIdsBySubjects(
  subs: readonly string[],
): Promise<DelegatedApproverRow[]> {
  const asked = subs.filter((sub) => isValidSubject(sub));
  if (asked.length === 0) return [];

  return db
    .select({ authSub: webUsers.authSub, employeeId: webUsers.employeeId })
    .from(webUsers)
    .where(
      and(
        inArray(webUsers.authSub, asked),
        // 🔴 화면·알림과 **같은 조건**이다(portal-actor.ts · findPortalActor).
        eq(webUsers.isActive, true),
        eq(webUsers.isDeleted, false),
      ),
    );
}

/**
 * 🔴 **이 조각의 입구.** 「지금 내가 대신 결재할 수 있는 사람들」을 이 시스템의
 * `web_employees.id` 목록으로 돌려준다. **던지지 않는다.**
 *
 * ── 🔴 **거래를 열기 전에** 부를 것 ────────────────────────────────────────
 * 설계 C-3 이 정한 길이다. 결재 판정은 DB 거래 **안에서** 하는데(workflow.ts 의
 * `decideStep`), 망 호출을 그 안에 넣으면 거래가 망 지연만큼 열려 있게 된다 —
 * 포털이 느린 날 결재 행 잠금이 2초씩 붙들린다. 그래서 **먼저 묻고, 결과를
 * 거래 안으로 들고 들어간다.** 부르는 자리는 둘뿐이다:
 *  · 결재함 화면 app/(internal)/approvals/page.tsx — 「보이는가」
 *  · 서버 액션 app/actions/leave.ts 의 `decideAction` — 「눌러지는가」
 *
 * 🔴 **포털이 결재 목록을 가져가는 통로에서는 부르지 않는다**
 * (app/api/integration/approvals). 거기서 또 포털에 물으면 **포털이 이쪽을
 * 기다리는 동안 이쪽이 포털을 기다린다.**
 *
 * @param subject 이 사람의 포털 번호(`web_users.auth_sub`). 세션에서 그대로
 *                나온다 — 🔵 A/S 와 달리 **나가는 방향의 변환이 공짜**다.
 */
export async function resolvePortalActingDelegations(
  subject: string,
): Promise<PortalActingDelegations> {
  // 포털이 없는 기계(임시 로그인만 쓰는 개발 PC)에는 물을 곳이 없다. 🔴
  // 장애가 아니므로 `unavailable` 을 세우지 않는다 — 세우면 그 PC 의 모든 결재
  // 화면에 「포털을 확인하지 못했습니다」가 깔린다.
  // 🔵 `ssoConfigured` 는 설정이 없어도 **던지지 않는** 유일한 검사다(env.ts).
  if (!env.ssoConfigured) return NO_PORTAL_DELEGATIONS;

  return resolveActingDelegations(subject, {
    ask: fetchPortalActingSubjects,
    lookup: findEmployeeIdsBySubjects,
  });
}
