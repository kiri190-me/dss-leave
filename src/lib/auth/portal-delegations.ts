/**
 * ============================================================================
 * 포털이 써 준 결재권 위임 — **제 표에서 읽는다**
 * ============================================================================
 * 2026-11-16 저녁에 방식이 뒤집혔다(설계 B-12). 그 전에는 결재할 때마다 이
 * 시스템이 포털에 **물었고**(B-3), 이제는 포털이 지정·철회할 때 각 시스템에
 * **써 준다**(`api/integration/delegations` → `web_portal_approval_delegations`).
 * 그래서 읽는 쪽은 **망이 아니라 같은 DB 의 표 하나**를 본다.
 *
 * 🟢 **결재 길목에서 망 호출이 사라졌다.** 그 전환으로 이 파일에 있던
 * `resolvePortalActingDelegations`(묻기 배선)와, 「못 물었다」를 나르던
 * leave/approval-delegation.ts · 화면 안내 · `portalDelegationUnavailable` 가
 * 함께 없어졌다 — **「못 물음」이라는 상태 자체가 없기 때문이다**(설계 B-12 의
 * 「없어지는 것들」). 설계 B-6·B-7(못 물었을 때의 처신과 안내)도 같은 까닭으로
 * 이 집에서는 더 읽을 것이 없다.
 *
 * ── 🔴 이 파일에 남은 둘은 **방향이 다르다** ──────────────────────────────
 *  · 아래 `loadActingForEmployeeIds` — **읽는 쪽.** 「지금 내가 대신 결재할 수
 *    있는 사람들」을 결재 판정에 올린다.
 *  · 🔴 `findEmployeeIdsBySubjects` — **받는 쪽**(조각 6)이 쓴다. 포털이 보낸
 *    `sub` 를 이 집 명단 번호로 바꾸는 자리이고, 부르는 곳은
 *    `app/api/integration/delegations/route.ts` 하나다. 🔴 **지우지 마라** —
 *    묻는 길을 걷어낼 때 같이 쓸려 나가기 가장 쉬운 함수인데, 없어지면 포털의
 *    전파가 500 으로 거절되고 **세 시스템의 위임 지정이 통째로 막힌다**(B-13).
 *
 * ── 🔴 열쇠가 **두 단**이다. 이 집에만 있는 사정이다 ──────────────────────
 *
 *     포털 sub → web_users.auth_sub 로 찾기 → web_users.employee_id
 *              → web_employees.id        ← 결재 권한의 실제 열쇠
 *
 * 🟢 **읽을 때는 그 변환이 없다.** 받는 통로가 저장하기 전에 두 단을 끝내
 * `web_employees.id` 로 적어 두기 때문이다(schema.ts 의 그 표 ⓒ). 그래서 읽는
 * 쪽은 **명단 번호 하나로** 묻고 답도 명단 번호로 나간다.
 * ============================================================================
 */
import { and, eq, gt, inArray, isNull, lte, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { webPortalApprovalDelegations, webUsers } from "@/lib/db/schema";
import type { DelegatedApproverRow } from "@/lib/leave/portal-delegation-sync";
import { isValidSubject } from "./sso-role";

/* ------------------------------------------------------------------ */
/* 읽는 쪽 — 결재 판정이 쓴다                                           */
/* ------------------------------------------------------------------ */

/**
 * 🔴 **「살아 있는 위임」의 조건.** 이 집에서 이 문장은 여기 한 곳에만 있다.
 *
 *  · `revoked_at` 이 **비어 있다.** 포털이 거두면 값이 찍히고 줄은 그대로
 *    남는다(portal-delegation-store.ts) — 끝난 위임의 기간을 눌러 그 기간의
 *    결재를 보는 화면이 설계에 있어서다(C-5). 그러니 「줄이 있다」가 아니라
 *    **「거둔 표시가 없다」**로 물어야 한다.
 *  · 🔴 **반열린 구간**이다 — `starts_at <= 지금 < ends_at`. 끝을 `<=` 로 적으면
 *    끝나는 그 순간이 한 번 더 열리고, 그 한 번은 아무 오류도 내지 않는다.
 *    표의 CHECK 가 `ends_at > starts_at` 을 지키므로 「하루도 못 쓰는 위임」은
 *    애초에 들어오지 못한다.
 *
 * ── 🔴 **지금 시각을 인자로 받는다** ──────────────────────────────────────
 * 부르는 쪽이 **매 요청마다 새로** 찍는다. 그래서 기간이 끝나면 다음 화면부터
 * 결재함 메뉴도 배지도 종도 **저절로 닫힌다** — 만료를 적어 두는 칸도, 밤에 도는
 * 작업표도 없다. 🔴 이 값을 어딘가에 캐 두면 「끝났는데 아직 열려 있는」 위임이
 * 생기고, 여는 조건과 닫는 조건이 **같은 함수 하나**라는 이 설계의 안전장치가
 * 바로 그 자리에서 깨진다(설계 D-7 ④ 가 재고관리에서 같은 말을 한다).
 */
export function liveDelegationWhere(delegateEmployeeId: string, now: Date): SQL {
  return and(
    eq(webPortalApprovalDelegations.delegateEmployeeId, delegateEmployeeId),
    isNull(webPortalApprovalDelegations.revokedAt),
    lte(webPortalApprovalDelegations.startsAt, now),
    gt(webPortalApprovalDelegations.endsAt, now),
  )!;
}

/**
 * 「지금 이 사람이 대신 결재할 수 있는 사람들」을 고르는 질의.
 *
 * 🔴 **질의를 만들기만 하고 돌리지 않는다.** 시험이 이것을 `.toSQL()` 로 **실제로
 * 구워** 반열린 구간과 거둔 줄 거르기를 글자가 아니라 **구워진 SQL** 로 본다
 * (portal-delegation-store.ts 가 같은 까닭으로 같은 모양이다). drizzle 의 질의는
 * `await` 할 때 비로소 돌므로 만들어 두기만 하는 것은 DB 에 닿지 않는다.
 *
 * 🔴 **이어 붙지 않는다** — 고르는 줄은 `delegate_employee_id = 나` 하나뿐이다.
 * A→B, B→C 라도 C 는 A 를 못 얻는다. 재귀 질의를 쓰면 아무도 지정하지 않은
 * 결재권이 생긴다(approval-scope.ts 의 `approvableEmployeeIds` 와 같은 말).
 *
 * 🔵 `selectDistinct` 와 차례를 못 박는 것은 **같은 사람에게 기간이 겹치는 위임이
 * 둘 이상** 있을 수 있어서다. 합치는 자리가 중복을 다시 걷지만(위 함수), 여기서
 * 줄여 두면 결재함 SQL 의 `in (...)` 이 같은 번호를 두 번 싣지 않는다.
 */
export function actingForEmployeeIdsQuery(delegateEmployeeId: string, now: Date) {
  return db
    .selectDistinct({
      delegatorEmployeeId: webPortalApprovalDelegations.delegatorEmployeeId,
    })
    .from(webPortalApprovalDelegations)
    .where(liveDelegationWhere(delegateEmployeeId, now))
    .orderBy(webPortalApprovalDelegations.delegatorEmployeeId);
}

/**
 * 🔴 **이 조각의 입구.** 「지금 내가 대신 결재할 수 있는 사람들」을 이 시스템의
 * `web_employees.id` 목록으로.
 *
 * 🔴 **던지는 것을 삼키지 않는다.** 묻던 시절에는 포털이 앓아도 결재가 그대로
 * 진행되도록 모든 오류를 값으로 바꿔 돌려주었다(설계 B-6). 지금 읽는 곳은
 * **이 시스템 자신의 DB** 라, 여기서 못 읽는 날이면 이 화면은 어차피 한 줄도
 * 그리지 못한다. 삼키면 **위임만 조용히 안 듣는** 상태가 되는데, 그것이 이
 * 저장소들에서 가장 비싼 결함 모양이다.
 *
 * @param delegateEmployeeId 대신 누르는 사람의 **명단 번호**(`web_employees.id`).
 *                           🔴 계정 번호(`web_users.id`)도 포털 번호도 아니다 —
 *                           넣으면 오류 없이 영원히 빈 목록이 나온다.
 * @param now 판정 기준 시각. 기본은 **지금**이고, 부르는 쪽이 요청마다 새로
 *            찍는다(위 `liveDelegationWhere` 의 그 까닭).
 */
export async function loadActingForEmployeeIds(
  delegateEmployeeId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await actingForEmployeeIdsQuery(delegateEmployeeId, now);
  return rows.map((row) => row.delegatorEmployeeId);
}

/* ------------------------------------------------------------------ */
/* 🔴 받는 쪽이 쓴다 — 읽는 쪽과 **거르개를 함께 쓰는** 자리              */
/* ------------------------------------------------------------------ */

/**
 * 포털 번호들 → 이 시스템의 계정·명단.
 *
 * 🔴 **부르는 곳은 받는 통로 하나다**(`app/api/integration/delegations`). 포털이
 * 보낸 `sub` 를 명단 번호로 바꿔 표에 적는 두 단 변환의 첫 단이고, 판단 쪽
 * (leave/portal-delegation-sync.ts)이 `lookup` 자리에 이 함수를 꽂는다.
 *
 * 🔴 **못 찾은 번호를 채워 넣지 않는다.** 돌려주는 줄 수가 물어본 번호 수보다
 * 적은 것이 곧 「바꾸지 못한 수」이고, 그것을 가려 읽는 자리는 판단 쪽이다.
 *
 * 🔴 **명단에 안 이어진 계정도 그대로 올려 준다**(`employeeId: null`). 여기서
 * 버리면 「계정이 아예 없는 사람」과 섞여, 휴가 관리자가 계정만 이어 주면 풀릴
 * 일을 영영 못 알아챈다 — 통로가 돌려주는 「해당 없음」의 까닭이 그 둘로 갈린다.
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
