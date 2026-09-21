/**
 * 머리말 안의 **서비스 메뉴바**(이 사람이 들어갈 수 있는 사내 시스템 목록)를
 * 나르는 쿠키. 이 저장소에는 아직 그 메뉴바가 없다 — 여기 있는 것은 **지우는
 * 쪽**뿐이다.
 *
 * 🔴 지우는 쪽을 먼저 두는 이유: 공용 PC 에서 앞사람이 남긴 목록이 뒷사람
 * 화면 머리말에 **남의 시스템 목록**으로 그대로 뜬다. 나중에 메뉴바를 붙일 때
 * 「굽는 쪽」만 더하면 되고, 지우는 자리를 빠뜨려 생기는 그 구멍은 처음부터
 * 없다. (개선요청 dss-improvements/src/lib/auth/service-menu-cookie.ts 가
 *  굽는 쪽까지 갖춘 완성본이다 — 붙일 때 그것을 옮겨 온다.)
 *
 * 🔴 쿠키는 포트를 가리지 않는다. 이름을 leave_ 로 시작하게 두는 이유는
 * auth/oidc.ts 의 SSO_TX_COOKIE 주석과 같다.
 */
import { cookies } from "next/headers";

import { env } from "@/lib/env";
import { SERVICE_MENU_COOKIE } from "./cookie-names";

export { SERVICE_MENU_COOKIE } from "./cookie-names";

/**
 * 이 브라우저에 남은 목록을 지운다.
 *
 * 🔴 로그인이 **시작되는** 자리와 로그아웃에서 부른다. 로그아웃에서는
 * **redirect 앞에서** 불러야 한다 — redirect 는 예외를 던지므로 뒤에 두면
 * 영영 실행되지 않는다.
 */
export async function clearServiceMenuCookie(): Promise<void> {
  (await cookies()).set(SERVICE_MENU_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // 사내망 HTTP 단계에서 켜면 브라우저가 쿠키를 저장하지 않는다(세션과 같다).
    secure: env.sessionCookieSecure,
    maxAge: 0,
  });
}
