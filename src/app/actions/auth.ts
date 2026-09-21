"use server";

import { redirect } from "next/navigation";

import { writeAudit } from "@/lib/audit";
import { getViewer, safeReturnTo } from "@/lib/auth/guards";
import {
  devLoginEnabled,
  findDevUser,
  touchLogin,
  upsertDevMember,
} from "@/lib/auth/dev-login";
import { endSessionUrl } from "@/lib/auth/oidc";
import { clearServiceMenuCookie } from "@/lib/auth/service-menu-cookie";
import { createSession, destroySession } from "@/lib/auth/session";
import { env } from "@/lib/env";

/* ------------------------------------------------------------------ */
/* 임시 로그인 — 통합 로그인이 막혔을 때 들어갈 뒷문. 기본값은 꺼짐.      */
/*                                                                      */
/* 🔴 통합 로그인이 붙은 뒤에도 지우지 않는다. 포털이 멈췄거나 아직 등록  */
/* 전일 때 들어갈 길이 하나는 있어야 한다. 두 길은 아래에서 보듯 결국     */
/* createSession(user.id) 하나로 모이므로 나란히 설 수 있다.             */
/* (통합 로그인 쪽 입구는 api/auth/sso/callback/route.ts 에 있다)        */
/* ------------------------------------------------------------------ */

export async function devLoginAsAction(formData: FormData): Promise<void> {
  if (!devLoginEnabled()) redirect("/login");

  const userId = String(formData.get("userId") ?? "");
  const returnTo = safeReturnTo(String(formData.get("returnTo") ?? "/"));

  const user = await findDevUser(userId);
  if (!user || !user.isActive) redirect("/login?error=1");

  await touchLogin(user.id);
  await createSession(user.id);
  await writeAudit({
    actor: user,
    action: "LOGIN",
    summary: `${user.displayName} 로그인 (임시 로그인)`,
  });

  redirect(returnTo);
}

export async function devLoginNewAction(formData: FormData): Promise<void> {
  if (!devLoginEnabled()) redirect("/login");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) redirect("/login?error=1");

  const user = await upsertDevMember(name);
  await createSession(user.id);
  await writeAudit({
    actor: user,
    action: "LOGIN",
    summary: `${user.displayName} 로그인 (임시 로그인 · 처음 온 계정)`,
  });

  redirect("/");
}

/**
 * 로그아웃. 이 사이트의 세션을 끊고 **포털 세션까지** 끝낸다.
 *
 * 🔴 이 사이트 쿠키만 지우면 포털 세션이 그대로 살아 있어, 로그아웃한 사람이
 * 로그인 버튼을 한 번 누르는 것만으로 누구인지 다시 묻지도 않고 그대로
 * 들어온다. 공용 PC 에서는 그것이 곧 로그아웃이 안 된 것이다.
 *
 * 🔴 지우는 일은 전부 redirect **앞**에 둔다 — redirect 는 예외를 던지므로
 * 뒤에 적은 줄은 영영 실행되지 않는다.
 */
export async function logoutAction(): Promise<void> {
  const viewer = await getViewer();
  if (viewer) {
    await writeAudit({
      actor: viewer.user,
      action: "LOGOUT",
      summary: `${viewer.user.displayName} 로그아웃`,
    });
  }
  await destroySession();
  // 「이 사람이 어떤 시스템을 쓰는지」를 브라우저에 남겨 둘 이유가 없다.
  await clearServiceMenuCookie();

  // 포털에 등록하기 전(또는 임시 로그인만 쓰는 개발 PC)이면 갈 포털이 없다.
  redirect(env.ssoConfigured ? endSessionUrl() : "/login");
}
