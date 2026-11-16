/**
 * 포털이 써 준 결재권 위임을 **이 집 표에 적는** 배선 (DB 한 줄짜리 두 문장).
 *
 * 판단은 전부 leave/portal-delegation-sync.ts 에 있고, 여기 남은 일은 그 판단이
 * 내준 값을 `web_portal_approval_delegations` 에 넣는 것뿐이다.
 *
 * ── 🔴 왜 portal-delegations.ts 에 같이 두지 않았나 ───────────────────────
 * 그 파일은 **묻는 쪽**(이쪽이 포털에 물어 본다)이고 이것은 **받는 쪽**이다.
 * 지금은 둘이 나란히 돌지만, 읽는 길을 이 표로 옮기고 나면 **묻는 쪽은 통째로
 * 걷어낸다**(설계 B-12 의 전환, 다음 조각). 한 파일에 섞어 두면 그때 지울 줄과
 * 남길 줄을 한 줄씩 가려내야 한다 — 가르는 금을 지금 그어 둔다.
 * 🔵 다만 **포털 번호를 명단 번호로 바꾸는 조회는 그 파일 것을 그대로 쓴다**
 * (`findEmployeeIdsBySubjects`). 거르는 조건이 두 벌이 되면 「읽을 때는 되는데
 * 쓸 때는 안 되는」 사람이 생긴다.
 *
 * ── 🔴 질의를 만드는 함수를 따로 내보내는 까닭 ────────────────────────────
 * 아래 두 함수는 **질의를 만들기만** 하고 돌리지 않는다. 시험이 그것을
 * `.toSQL()` 로 **실제로 구워** 「번호로 덮어쓰는가(on conflict)」·「번호를
 * 우리가 만들지는 않는가」를 글자가 아니라 **구워진 SQL** 로 본다
 * (scripts/test-delegation-sync.ts). drizzle 의 질의는 `await` 할 때 비로소
 * 돌므로, 만들어 두기만 하는 것은 DB 에 닿지 않는다.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { webPortalApprovalDelegations } from "@/lib/db/schema";
import type { StoredPortalDelegation } from "@/lib/leave/portal-delegation-sync";

/**
 * 있으면 덮어쓰고 없으면 넣는다 — **포털이 정한 번호(`id`)가 그 기준**이다.
 *
 * 🔴 **멱등은 이 한 문장이 쥔다.** `id` 가 기본키이고 충돌하면 덮어쓰므로, 포털이
 * 같은 지정을 두 번 보내도(재시도·그물 끊김 뒤 다시 걸기) 줄은 하나다. 먼저
 * 조회해 보고 갈라 쓰는 방식은 두 요청이 겹칠 때 **둘 다 「없다」를 보고 둘 다
 * 넣는다.**
 *
 * ── 🔴 `revoked_at` 만 **한 방향**이다 ─────────────────────────────────────
 * 다른 칸은 포털이 보낸 값으로 전부 덮는데(저쪽이 그 줄의 주인이다), 이 칸만
 * **덮어쓸 때** 갈래가 둘이다:
 *  · **값이 실려 왔으면 그대로 적는다.** 버리면 「포털은 거뒀는데 여기서는 살아
 *    있는」 줄이 남고, 설계 B-13 이 **그쪽이 더 위험하다**고 못 박았다.
 *  · 🔴 **널이면 이미 적힌 값을 지우지 않는다.** 통로 규약에 **차례를 가릴 값이
 *    없어서**, 지정과 철회가 길에서 뒤바뀌면 나중에 닿은 것이 이긴다. 널까지
 *    덮으면 늦게 닿은 이 문장이 **거둔 위임을 되살리고**, 그 사람은 **아무 오류
 *    없이** 남의 결재를 대신 누를 수 있게 된다.
 * 🔵 **이 비대칭으로 잃는 것이 없다.** 포털은 새 지정에 **새 `id`** 를 쓰므로,
 *    거둔 줄을 같은 번호로 되살리라는 전파가 정상적으로 오는 길이 없다.
 * 🔴 **넣는 자리(`values`)는 그대로다** — 처음 받는 줄은 거둔 채로 와도 그대로
 *    적는다. 비대칭은 **충돌했을 때**만의 이야기다.
 * 🔴 **A/S·재고관리도 같은 규칙이다**(2026-11-16 에 셋을 맞췄다). 다음 사람이
 *    「왜 여기만 조건부지, 일관성 없네」로 되돌리기 가장 쉬운 자리다 — 한 집만
 *    되돌리면 같은 전파가 시스템마다 다른 줄을 남기고, 그것은 어긋남 점검
 *    (설계 B-14)에서야 드러난다.
 */
export function portalDelegationUpsertQuery(row: StoredPortalDelegation) {
  const always = {
    delegatorEmployeeId: row.delegatorEmployeeId,
    delegateEmployeeId: row.delegateEmployeeId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    reason: row.reason,
    // 🔴 **언제 받아 적었나**를 덮어쓸 때도 새로 찍는다 — 어긋남 점검이 「이
    //    시스템이 마지막으로 들은 때」로 읽는 값이다.
    syncedAt: new Date(),
  };
  return db
    .insert(webPortalApprovalDelegations)
    .values({ id: row.id, ...always, revokedAt: row.revokedAt })
    .onConflictDoUpdate({
      target: webPortalApprovalDelegations.id,
      // 🔴 널이면 `revoked_at` 을 **아예 안 싣는다**(위 머리말의 한 방향 규칙).
      //    실으면 SQL 이 `"revoked_at" = null` 을 쓰고 거기서 철회가 되살아난다.
      set: { ...always, ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt }) },
    });
}

export async function upsertPortalDelegation(row: StoredPortalDelegation): Promise<void> {
  await portalDelegationUpsertQuery(row);
}

/**
 * 철회 시각을 세운다. 🔵 **이미 거둔 줄에 또 와도 그냥 덮어쓴다** — 포털이 보낸
 * 시각이 늘 이긴다(저쪽이 이 값의 주인이다). 그래서 몇 번을 받아도 결과가 같다.
 *
 * 🔴 **지우지 않는다.** 끝난 위임의 기간을 눌러 그 기간의 결재를 보는 화면이
 * 설계에 있다(C-5). 줄이 사라지면 그 자리에서 아무것도 못 그린다.
 */
export function portalDelegationRevokeQuery(id: string, revokedAt: Date) {
  return db
    .update(webPortalApprovalDelegations)
    .set({ revokedAt, syncedAt: new Date() })
    .where(eq(webPortalApprovalDelegations.id, id))
    .returning({ id: webPortalApprovalDelegations.id });
}

/** @returns 그런 줄이 **있었는가.** 없으면 `false` — 오류가 아니다. */
export async function revokePortalDelegation(id: string, revokedAt: Date): Promise<boolean> {
  const touched = await portalDelegationRevokeQuery(id, revokedAt);
  return touched.length > 0;
}
