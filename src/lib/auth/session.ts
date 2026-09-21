/**
 * 이 사이트의 세션을 읽고 쓰는 유일한 파일.
 *
 * 화면·API 곳곳에서 쿠키를 직접 읽지 않는다. 반드시 여기를 거친다.
 *
 * 서버 저장형이다 — 쿠키에는 랜덤 토큰 원문만 담고 DB 에는 그 sha256 만 둔다.
 * 이렇게 해야 퇴사자·문제 계정을 즉시 끊을 수 있다.
 */
import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { cookies } from "next/headers";

import { db } from "@/lib/db";
import { webSessions, webUsers, type WebUser } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { SESSION_COOKIE } from "./cookie-names";

/**
 * 이 사이트 고유 쿠키 이름. 겹치면 안 되는 까닭은 auth/cookie-names.ts 에 있다.
 * 부르는 쪽이 세션을 다루며 이름도 함께 얻도록 여기서 다시 내보낸다.
 */
export { SESSION_COOKIE } from "./cookie-names";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + env.sessionHours * 60 * 60 * 1000);

  await db.insert(webSessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // 사내망 HTTP 단계에서 켜면 쿠키가 저장되지 않아 로그인이 조용히 실패한다.
    secure: env.sessionCookieSecure,
    expires: expiresAt,
  });
}

/** 현재 요청의 로그인 계정. 없으면 null. */
export async function getSessionUser(): Promise<WebUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const rows = await db
    .select({ user: webUsers })
    .from(webSessions)
    .innerJoin(webUsers, eq(webUsers.id, webSessions.userId))
    .where(
      and(
        eq(webSessions.tokenHash, hashToken(token)),
        gt(webSessions.expiresAt, new Date()),
        isNull(webSessions.revokedAt),
        eq(webUsers.isActive, true),
        eq(webUsers.isDeleted, false),
      ),
    )
    .limit(1);

  return rows[0]?.user ?? null;
}

/**
 * 포털이 "이 사람 끊어라" 라고 알려 왔을 때 — 그 사람의 **살아 있는 세션을
 * 전부** 끊는다. 끊을 것이 하나라도 있었으면 true.
 *
 * 🔴 이 시스템이 서버 저장형(web_sessions)이라 할 수 있는 일이다. 서명 토큰을
 * 쓰는 이웃 시스템들은 이 자리에서 web_users 에 기준선(sessions_valid_from)을
 * 올려야 했지만, 여기서는 그 사람의 세션 행에 revoked_at 을 적으면 끝이다 —
 * getSessionUser 가 이미 revoked_at 이 비어 있는 행만 본다. **스키마 변경 0.**
 *
 * sid 가 아니라 sub 단위로 끊는 이유: 공용 PC 에서 나간 사람에게는 그편이
 * 기대에 맞고, 정지된 사람에게는 반드시 그래야 한다.
 */
export async function revokeSessionsForSubject(authSub: string): Promise<boolean> {
  if (!authSub) return false;

  const userIds = db
    .select({ id: webUsers.id })
    .from(webUsers)
    .where(eq(webUsers.authSub, authSub));

  const revoked = await db
    .update(webSessions)
    .set({ revokedAt: new Date() })
    .where(and(inArray(webSessions.userId, userIds), isNull(webSessions.revokedAt)))
    .returning({ id: webSessions.id });

  return revoked.length > 0;
}

/**
 * 이 브라우저의 세션만 끊는다. (포털 세션은 그대로 — oidc.ts 의
 * endSessionUrl 로 보내는 것이 그 몫이다. 이 사이트 쿠키만 지우면 로그인
 * 버튼 한 번으로 아무것도 묻지 않고 다시 들어온다.)
 */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  if (token) {
    await db
      .update(webSessions)
      .set({ revokedAt: new Date() })
      .where(eq(webSessions.tokenHash, hashToken(token)));
  }

  store.delete(SESSION_COOKIE);
}
