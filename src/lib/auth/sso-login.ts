/**
 * 포털이 확인해 준 사람을 이 사이트의 이용자와 잇는다.
 *
 * 포털의 users 표는 건드리지 않는다. 이 사이트는 자기 web_users 를 갖고,
 * 🔴 `auth_sub` **하나로만** 이어진다 — 이름이 바뀌어도, 이메일이 바뀌어도,
 * 사람은 같은 사람이다. 이메일로 이으면 언젠가 남의 계정이 된다(이메일은
 * 사람이 바꿀 수 있는 값이고, 회사 메일은 퇴사자 주소를 다시 쓰기도 한다).
 *
 * 임시 로그인(dev-login.ts)과 **나란히 선다.** 갈라지는 곳은 「누구인지
 * 어떻게 알았는가」뿐이고, 둘 다 web_users 의 한 행으로 모인 뒤
 * session.ts 의 createSession(userId) 하나로 끝난다.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { USER_ROLES, webUsers, type WebUser } from "@/lib/db/schema";
import type { SsoIdentity } from "./oidc";
import { decideRole, isValidSubject } from "./sso-role";

export type SsoLoginResult =
  | { outcome: "SESSION"; user: WebUser; created: boolean }
  | {
      outcome: "REJECTED";
      code: "BAD_SUBJECT" | "UNKNOWN_ROLE" | "INACTIVE" | "DELETED";
    };

/**
 * 처음 보는 사람이면 **일반(MEMBER)으로** 만든다. 명단 연결은 비어 있으므로
 * 그 사람은 곧바로 「관리자 확인 대기」 화면으로 간다 — 휴가 관리자가 직원
 * 명단과 이어 줘야 신청·결재를 쓸 수 있다.
 *
 * 포털이 "우리 회사 사람인가" 를 이미 판정했으니 계정 자체를 만드는 데 또
 * 승인을 받을 이유는 없다. 다만 자동으로 주는 권한은 가장 낮은 것뿐이다 —
 * 휴가 관리자는 포털에서 LEAVE_ADMIN 을 명시적으로 받아야 한다.
 */
export async function resolveSsoLogin(identity: SsoIdentity): Promise<SsoLoginResult> {
  // auth_sub 는 uuid 열이다. 아닌 값이 오면 insert 가 터지므로 먼저 막는다.
  if (!isValidSubject(identity.subject)) {
    console.error("[sso] sub 가 uuid 형식이 아닙니다.");
    return { outcome: "REJECTED", code: "BAD_SUBJECT" };
  }

  const decision = decideRole(identity.role);
  if (decision.kind === "REJECT") {
    console.error(
      `[sso] 이 시스템이 모르는 역할입니다: ${String(identity.role)} ` +
        `(아는 값: ${USER_ROLES.join(", ")})`,
    );
    return { outcome: "REJECTED", code: "UNKNOWN_ROLE" };
  }

  const displayName = identity.name?.trim().slice(0, 40) || "이름 없음";
  const now = new Date();

  // 🔴 삭제된 사람도 함께 찾는다. auth_sub 의 유일 색인에는 조건이 없어서,
  // 못 본 척하면 새로 만들려다 색인 충돌로 터진다. 그리고 내보낸 사람이
  // 조용히 새 계정으로 돌아오는 편이 더 나쁘다.
  const [existing] = await db
    .select()
    .from(webUsers)
    .where(eq(webUsers.authSub, identity.subject))
    .limit(1);

  if (existing) {
    if (existing.isDeleted) {
      console.warn(`[sso] 삭제된 계정입니다: ${identity.subject}`);
      return { outcome: "REJECTED", code: "DELETED" };
    }
    if (!existing.isActive) {
      console.warn(`[sso] 정지된 계정입니다: ${identity.subject}`);
      return { outcome: "REJECTED", code: "INACTIVE" };
    }

    const [updated] = await db
      .update(webUsers)
      .set({
        displayName,
        // 🔴 포털에 이메일이 없으면 예전 값을 지우지 않는다. 카카오에서
        // 이메일은 선택 동의라 있다가 없어질 수 있다 — "말하지 않았다" 와
        // "비웠다" 는 다르다.
        ...(identity.email ? { email: identity.email } : {}),
        ...(decision.kind === "APPLY" ? { role: decision.role } : {}),
        lastLoginAt: now,
        updatedAt: now,
      })
      .where(eq(webUsers.id, existing.id))
      .returning();

    return { outcome: "SESSION", user: updated, created: false };
  }

  const [created] = await db
    .insert(webUsers)
    .values({
      authSub: identity.subject,
      displayName,
      email: identity.email,
      role: decision.kind === "APPLY" ? decision.role : "MEMBER",
      lastLoginAt: now,
    })
    .returning();

  return { outcome: "SESSION", user: created, created: true };
}
