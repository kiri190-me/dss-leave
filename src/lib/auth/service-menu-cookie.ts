/**
 * 머리말 안의 **서비스 메뉴바**(이 사람이 들어갈 수 있는 사내 시스템 목록)를
 * 나르는 **세션과 별도인 서명 쿠키**.
 *
 * 포털(dss-auth)이 로그인 ID 토큰의 `dss_services` 클레임에 「이 사람이 들어갈
 * 수 있는 사내 시스템」을 실어 보낸다. 그 값을 여기서 걸러 서명한 쿠키에
 * 담아 두었다가, (internal)/layout.tsx 가 서버에서 풀어 **머리말 안**의
 * 메뉴바로 그린다(AppHeader 의 serviceMenu prop).
 *
 * ── 왜 세션에 넣지 않나 ─────────────────────────────────────────────────
 * 이 사이트의 세션은 **서버 저장형**이다 — 쿠키에는 랜덤 토큰 원문만 있고
 * 값은 web_sessions 행에 있다(session.ts). 메뉴 목록은 **그리는 데만 쓰는
 * 값**이라 그 행에 넣으려면 스키마를 늘려야 하고, 늘리면 인가 판정에 쓰는
 * 표에 화면 장식이 섞인다. 브라우저가 들고 다니게 두는 편이 싸다.
 *
 * ── 왜 서명하나 ─────────────────────────────────────────────────────────
 * 안 하면 사용자가 자기 브라우저에서 값을 고쳐 가짜 링크를 띄울 수 있다.
 * 자기만 속는 일이지만(이 값으로 열리는 권한은 없다) 막는 값이 몇 줄이라
 * 막는 편이 낫다.
 *
 * ── 🔴 서명 키는 SSO_TX_SECRET 에서 **갈라** 만든다 ─────────────────────
 * 이 저장소에는 세션 서명 키가 없다(서버 저장형이라 서명할 것이 없었다).
 * 새 환경변수를 하나 더 요구하면 이미 도는 개발 PC 와 NAS 설정이 모두
 * 「값 하나 빠짐」으로 멈춘다. 그래서 있는 비밀값에서 **HMAC 으로 한 번 더
 * 갈라** 쓴다 — 같은 키를 두 곳에 그대로 쓰면 한쪽에서 만든 서명이 다른 쪽에
 * 통하는지 매번 따져야 하지만, 이렇게 가르면 왕복 쿠키(leave_sso_tx)의
 * 서명과는 아예 다른 키가 된다.
 *
 * ── 권한을 판정하지 않는다 ──────────────────────────────────────────────
 * 이 파일은 포털이 준 목록을 **그대로** 나를 뿐, 무엇을 더하거나 빼지 않는다
 * (@dss/ui 의 normalizeServiceMenu 도 그릴 수 없는 칸만 버린다). 판정이 두
 * 벌이 되면 포털 타일(/apps)과 이 메뉴바가 서로 다른 말을 하게 된다.
 *
 * 🔴 쿠키는 포트를 가리지 않는다. 이름을 leave_ 로 시작하게 두는 이유는
 * auth/cookie-names.ts 에 적혀 있다.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";

import { normalizeServiceMenu, type ServiceMenuEntry } from "@dss/ui";
import { env } from "@/lib/env";
import { SERVICE_MENU_COOKIE } from "./cookie-names";

export { SERVICE_MENU_COOKIE } from "./cookie-names";

type ServiceMenuPayload = {
  services: ServiceMenuEntry[];
  /** 유닉스 초 */
  issuedAt: number;
  /** 유닉스 초 */
  expiresAt: number;
};

/**
 * 키를 가르는 꼬리표. 바꾸면 이미 구워 둔 쿠키가 전부 못 믿을 것이 되어
 * 메뉴바만 한 번 사라진다(로그인은 멀쩡하다). 그래서 판 번호를 붙여 둔다.
 */
const KEY_LABEL = "leave:service-menu:v1";

/**
 * 서명 키. **통합 로그인이 설정돼 있지 않으면 null 이다.**
 *
 * 🔴 던지지 않는다. 이 값은 머리말 장식에 쓰이는데, 여기서 터지면 본문까지
 * 못 보게 된다. 설정이 없으면 이 쿠키가 정당하게 구워질 길도 없으므로
 * (굽는 자리가 통합 로그인 콜백 하나다) 없는 것이 맞다.
 */
function signingKey(): Buffer | null {
  if (!env.ssoConfigured) return null;
  return createHmac("sha256", env.ssoTxSecret).update(KEY_LABEL).digest();
}

/** 세션 쿠키와 같은 수명 — 어긋나면 세션은 살아 있는데 메뉴바만 사라진다. */
function maxAgeSeconds(): number {
  return env.sessionHours * 60 * 60;
}

function sign(payloadBase64: string, key: Buffer): string {
  return createHmac("sha256", key).update(payloadBase64).digest("base64url");
}

/**
 * ID 토큰에서 꺼낸 `dss_services` 클레임을 쿠키에 담을 토큰으로 만든다.
 *
 * 🔴 **그릴 것이 없으면 null 이다 — 쿠키를 굽지 않는다.** 포털이 이 시스템에
 * 그 클레임을 실어 주기 전에는 로그인해도 클레임이 아예 없을 수 있고, 그때
 * 머리말은 예전과 같아야 한다(빈 자리도 남기지 않는다). 클레임이 없는 것과
 * 값이 이상한 것을 구분하지 않는 이유도 같다 — 어느 쪽이든 그릴 수 있는
 * 칸이 없으면 메뉴바는 없는 것이 맞다.
 */
export function createServiceMenuToken(claim: unknown): string | null {
  const key = signingKey();
  if (!key) return null;

  const services = normalizeServiceMenu(claim);
  if (services.length === 0) return null;

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: ServiceMenuPayload = {
    services,
    issuedAt,
    expiresAt: issuedAt + maxAgeSeconds(),
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadBase64}.${sign(payloadBase64, key)}`;
}

/**
 * 위조 · 변조 · 만료된 토큰은 모두 **빈 목록**이다(예외를 던지지 않는다).
 *
 * 메뉴바는 곁다리인데 여기서 터지면 본문까지 못 보게 된다. 서명이 맞아도 안에
 * 든 값은 다시 거른다 — 옛 토큰이 남아 있거나 포털 쪽이 먼저 바뀐 경우가 있다.
 */
export function parseServiceMenuToken(token: string): ServiceMenuEntry[] {
  const key = signingKey();
  if (!key) return [];

  const dot = token.indexOf(".");
  if (dot <= 0) return [];

  const payloadBase64 = token.slice(0, dot);
  const presented = token.slice(dot + 1);

  // 문자열 비교는 앞에서부터 다른 지점까지 걸리는 시간이 달라, 서명을 한
  // 글자씩 알아내는 공격이 이론상 가능하다(oidc.ts 의 왕복 쿠키와 같은 이유).
  const a = Buffer.from(presented);
  const b = Buffer.from(sign(payloadBase64, key));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8"));
  } catch {
    return [];
  }

  if (typeof parsed !== "object" || parsed === null) return [];
  const candidate = parsed as Record<string, unknown>;

  // 🔴 Max-Age 는 브라우저의 호의일 뿐이다. 만료는 서명 안에 든 값으로 본다.
  if (typeof candidate.expiresAt !== "number") return [];
  if (candidate.expiresAt <= Math.floor(Date.now() / 1000)) return [];

  return normalizeServiceMenu(candidate.services);
}

/**
 * 로그인에 성공한 사람에게 이 쿠키를 준다.
 *
 * 속성을 세션 쿠키(session.ts 의 createSession)와 같은 값으로 맞춘다. 그릴
 * 것이 없으면 굽지 않고 **남아 있던 것을 지운다** — 포털이 아직 그 클레임을
 * 싣지 않는 동안, 공용 PC 에서 앞사람이 남긴 목록이 뒷사람 화면에 그대로
 * 뜨는 것을 막는 자리다.
 */
export async function writeServiceMenuCookie(claim: unknown): Promise<void> {
  const token = createServiceMenuToken(claim);
  if (!token) {
    await clearServiceMenuCookie();
    return;
  }

  (await cookies()).set(SERVICE_MENU_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // 사내망 HTTP 단계에서 켜면 브라우저가 쿠키를 저장하지 않는다(세션과 같다).
    secure: env.sessionCookieSecure,
    maxAge: maxAgeSeconds(),
  });
}

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

/** 쿠키가 없거나 못 믿을 것이면 빈 목록 — 그때 메뉴바는 그려지지 않는다. */
export async function readServiceMenu(): Promise<ServiceMenuEntry[]> {
  const token = (await cookies()).get(SERVICE_MENU_COOKIE)?.value;
  if (!token) return [];
  return parseServiceMenuToken(token);
}
