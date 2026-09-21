// 임시 로그인 — 통합 로그인이 막혔을 때 들어갈 **뒷문**. 기본값은 꺼짐.
//
// 🔴 지우지 않는다(2026-09-21 결정). 통합 로그인(auth/oidc.ts)이 붙은 뒤에도
//    남긴다 — 포털이 멈췄거나, 아직 이 시스템을 등록하기 전이거나, Wi-Fi 가
//    바뀌어 issuer 주소가 어긋났을 때 들어갈 길이 하나는 있어야 한다.
//    그런 때가 실제로 있었고, 그때 손쓸 방법이 없으면 휴가 결재가 멈춘다.
//
// - DEV_FAKE_LOGIN_ENABLED === "true" 일 때만 동작한다. 기본값은 꺼짐이고,
//   이 파일의 모든 함수가 assertEnabled 로 그것을 다시 확인한다.
// - 통합 로그인과 **나란히 선다.** 갈라지는 곳은 「누구인지 어떻게 알았는가」
//   뿐이고, 두 길 다 web_users 의 한 행으로 모인 뒤 session.ts 의
//   createSession(userId) 하나로 끝난다. 세션·권한은 어느 쪽인지 모른다.
import { createHash } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { webEmployees, webRanks, webUsers, type WebUser } from "@/lib/db/schema";
import { env } from "@/lib/env";

export function devLoginEnabled(): boolean {
  return env.devFakeLoginEnabled;
}

function assertEnabled(): void {
  if (!devLoginEnabled()) {
    throw new Error("임시 로그인이 꺼져 있습니다.");
  }
}

/**
 * 이름에서 항상 같은 UUID 를 만든다.
 * 같은 이름으로 다시 로그인하면 같은 사람으로 이어지게 하기 위한 것뿐이다.
 * 실제 운영에서는 ID 토큰의 sub 가 이 자리를 대신한다.
 */
export function fakeSubFor(name: string): string {
  const h = createHash("sha256").update(`dev:${name}`).digest("hex");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-");
}

/** 로그인 화면에 보여줄 계정 목록 (직급 높은 순) */
export async function listDevUsers() {
  assertEnabled();
  const rows = await db
    .select({
      user: webUsers,
      employeeName: webEmployees.name,
      rankName: webRanks.name,
      rankOrder: webRanks.sortOrder,
    })
    .from(webUsers)
    .leftJoin(
      webEmployees,
      and(eq(webEmployees.id, webUsers.employeeId), eq(webEmployees.isDeleted, false)),
    )
    .leftJoin(webRanks, eq(webRanks.id, webEmployees.rankId))
    .where(and(eq(webUsers.isDeleted, false), eq(webUsers.isActive, true)))
    .orderBy(asc(webUsers.displayName));
  return rows.sort((a, b) => (b.rankOrder ?? -1) - (a.rankOrder ?? -1));
}

export async function findDevUser(id: string): Promise<WebUser | null> {
  assertEnabled();
  const rows = await db
    .select()
    .from(webUsers)
    .where(and(eq(webUsers.id, id), eq(webUsers.isDeleted, false)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 처음 보는 사람이면 계정을 만든다.
 * 기본 역할은 가장 낮은 권한(MEMBER)이고, 명단 연결도 비어 있다 → 확인 대기.
 */
export async function upsertDevMember(rawName: string): Promise<WebUser> {
  assertEnabled();

  const name = rawName.trim().slice(0, 40);
  if (!name) throw new Error("이름을 입력하세요.");

  const authSub = fakeSubFor(name);
  const existing = await db
    .select()
    .from(webUsers)
    .where(eq(webUsers.authSub, authSub))
    .limit(1);

  if (existing[0]) {
    const [updated] = await db
      .update(webUsers)
      .set({ displayName: name, lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(webUsers.id, existing[0].id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(webUsers)
    .values({ authSub, displayName: name, role: "MEMBER", lastLoginAt: new Date() })
    .returning();
  return created;
}

export async function touchLogin(userId: string): Promise<void> {
  await db
    .update(webUsers)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(webUsers.id, userId));
}
