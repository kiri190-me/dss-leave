/**
 * DSS 통합 로그인 포털(dss-auth)과 이야기하는 유일한 파일.
 *
 * OIDC 를 여기에만 가둔다 — 화면·서버 액션·라우트 어디에서도 포털의 주소나
 * 토큰 형식을 알지 못하게 한다. 나중에 포털이 바뀌어도 고칠 곳은 여기다.
 *
 * 이 사이트는 자체 로그인을 만들지 않는다. 포털이 신원을 확인하고, 여기서는
 * 그 결과(ID 토큰)를 검증해 자기 세션(leave_session)을 발급할 뿐이다.
 *
 * ⚠️ 이 파일의 절차는 A/S 시스템(RF_Service_System) · 계측기 시스템(njlee) ·
 *    개선요청(dss-improvements) · PO/내자(dss-po)의 것과 **같다.** 모두 같은
 *    포털에 붙고 같은 함정을 이미 밟았다. 한쪽에서 프로토콜 쪽을 고치면
 *    나머지도 함께 봐야 한다.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { createRemoteJWKSet, jwtVerify } from "jose";

// 🔴 **타입만** 빌려 온다(import type — 남는 코드가 없다). 포털이 내주는 알림
// 한 줄의 모양과 종이 받는 모양이 글자 하나까지 같아서, 받은 배열을 옮겨 담지
// 않고 그대로 넘길 수 있다. 둘이 어긋나면 tsc 가 먼저 말해 준다.
import type { NotificationBellItem } from "@dss/ui";
import { env } from "@/lib/env";

/* ------------------------------------------------------------------ */
/* 로그인 왕복 동안 들고 있어야 하는 값                                  */
/* ------------------------------------------------------------------ */

/**
 * 포털의 dss_sso 와도, 이 사이트의 leave_session 과도 겹치지 않는 이름.
 * 겹치면 안 되는 까닭은 auth/cookie-names.ts 에 적혀 있다.
 */
export { SSO_TX_COOKIE } from "./cookie-names";

/**
 * 이 쿠키는 로그인 왕복에서만 쓰인다. 경로를 좁혀 두면 나머지 요청에
 * 딸려 나가지 않는다.
 */
export const SSO_TX_COOKIE_PATH = "/api/auth/sso";

/**
 * 10분. 카카오 동의 화면에서 잠시 망설일 만큼은 되고, 중간에 그만둔 시도가
 * 오래 살아 있지는 않을 만큼 짧다.
 */
export const SSO_TX_MAX_AGE_SECONDS = 600;

export type SsoTransaction = {
  /** 남의 로그인 응답이 이 브라우저에 떨어지는 것을 막는다. */
  state: string;
  /** 예전 ID 토큰을 다시 들이미는 것을 막는다. */
  nonce: string;
  /** PKCE. 이 값은 이 서버 밖으로 나가지 않으므로 인가 코드만으로는 쓸모가 없다. */
  codeVerifier: string;
  /** 로그인 후 돌아갈 이 사이트 안의 경로. */
  returnTo: string;
  /** 유닉스 초. 쿠키의 Max-Age 는 브라우저의 호의일 뿐이라 값으로도 확인한다. */
  expiresAt: number;
};

/* ------------------------------------------------------------------ */
/* 왕복 쿠키 서명                                                       */
/*                                                                     */
/* 서명이 곧 PKCE 다 — 서명이 없으면 브라우저가 code_verifier 를 제 손으로 */
/* 바꿔 끼울 수 있어 PKCE 가 무의미해진다.                               */
/* ------------------------------------------------------------------ */

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function sealTransaction(tx: SsoTransaction): string {
  const payload = Buffer.from(JSON.stringify(tx), "utf8").toString("base64url");
  return `${payload}.${sign(payload, env.ssoTxSecret)}`;
}

/** 서명이 맞고 만료되지 않았을 때만 값을 돌려준다. 아니면 null. */
export function openTransaction(raw: string | undefined): SsoTransaction | null {
  if (!raw) return null;

  const dot = raw.indexOf(".");
  if (dot <= 0) return null;

  const payload = raw.slice(0, dot);
  const presented = raw.slice(dot + 1);
  const expected = sign(payload, env.ssoTxSecret);

  // 문자열 비교는 앞에서부터 다른 지점까지의 시간이 달라, 서명을 한 글자씩
  // 알아내는 공격이 이론상 가능하다. 길이가 다르면 timingSafeEqual 이 던지므로
  // 먼저 본다.
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const tx = parsed as Record<string, unknown>;
  if (
    typeof tx.state !== "string" ||
    typeof tx.nonce !== "string" ||
    typeof tx.codeVerifier !== "string" ||
    typeof tx.returnTo !== "string" ||
    typeof tx.expiresAt !== "number"
  ) {
    return null;
  }

  if (tx.expiresAt <= Math.floor(Date.now() / 1000)) return null;

  return tx as SsoTransaction;
}

/* ------------------------------------------------------------------ */
/* 1단계 — 포털로 보낸다                                                */
/* ------------------------------------------------------------------ */

/**
 * 세 값을 새로 만든다. 각각 다른 구멍을 막는다.
 *   state         로그인 CSRF (남의 로그인 응답이 내 브라우저에 떨어지는 것)
 *   nonce         ID 토큰 재사용 (예전 토큰을 다시 들이미는 것)
 *   codeVerifier  인가 코드 가로채기 (코드만으로는 토큰을 못 받게)
 */
export function beginLogin(returnTo: string): {
  authorizeUrl: string;
  transaction: SsoTransaction;
} {
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  // 64바이트 → base64url 86자. RFC 7636 이 정한 43~128자 안이다.
  const codeVerifier = randomBytes(64).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier, "ascii")
    .digest("base64url");

  const url = new URL(`${env.ssoIssuer}/api/oidc/authorize`);
  url.search = new URLSearchParams({
    client_id: env.ssoClientId,
    redirect_uri: env.ssoRedirectUri,
    response_type: "code",
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();

  return {
    authorizeUrl: url.href,
    transaction: {
      state,
      nonce,
      codeVerifier,
      returnTo,
      expiresAt: Math.floor(Date.now() / 1000) + SSO_TX_MAX_AGE_SECONDS,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 2단계 — 인가 코드를 ID 토큰으로 바꾼다 (서버 대 서버)                 */
/* ------------------------------------------------------------------ */

/** 실패는 전부 null 이다. 이유는 서버 로그에만 남긴다. */
export async function exchangeCodeForIdToken(
  code: string,
  codeVerifier: string,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(`${env.ssoIssuer}/api/oidc/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        // /authorize 에 보낸 값과 문자 단위로 같아야 한다.
        redirect_uri: env.ssoRedirectUri,
        code_verifier: codeVerifier,
        client_id: env.ssoClientId,
        client_secret: env.ssoClientSecret,
      }),
      cache: "no-store",
    });
  } catch (error) {
    console.error("[sso] 포털에 연결할 수 없습니다:", error);
    return null;
  }

  if (!response.ok) {
    // 포털의 오류 본문은 내부 설정을 설명할 수 있다. 화면에는 내보내지 않는다.
    console.error("[sso] 토큰 교환 거절:", response.status);
    return null;
  }

  const body = (await response.json()) as { id_token?: unknown };
  if (typeof body.id_token !== "string") {
    console.error("[sso] 응답에 id_token 이 없습니다.");
    return null;
  }
  return body.id_token;
}

/* ------------------------------------------------------------------ */
/* 3단계 — ID 토큰을 검증한다                                           */
/* ------------------------------------------------------------------ */

/**
 * 한 번 만들어 재사용한다 — jose 가 JWKS 캐시·키 교체·재조회 간격을 알아서
 * 처리한다. 요청마다 만들면 포털을 두드리게 되고 그 캐시가 무의미해진다.
 *
 * 지연 생성인 이유: 이 파일을 불러오는 것만으로 SSO_ISSUER 를 요구하면
 * next build 가 환경변수 없이 돌지 못한다(도커 이미지에는 .env 가 없다).
 *
 * 🔴 **내보내는 이유**: 포털이 알림을 물으러 올 때 들고 오는 서명 토큰도 같은
 * 포털의 같은 열쇠로 검증한다(auth/portal-service-token.ts). 거기서 JWKS 를
 * 한 벌 더 만들면 캐시도 두 벌이 되어, 포털이 키를 갈 때 한쪽만 늦게 따라간다.
 */
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
export function portalJwks(): ReturnType<typeof createRemoteJWKSet> {
  jwksCache ??= createRemoteJWKSet(new URL(`${env.ssoIssuer}/.well-known/jwks.json`));
  return jwksCache;
}

export type SsoIdentity = {
  /** 포털의 users.id. 이 사이트가 사람을 잇는 유일한 열쇠다. */
  subject: string;
  /** 화면 표시용. 없을 수 있다. */
  name: string | null;
  /** 카카오에서 이메일은 선택 동의라 없을 수 있다. */
  email: string | null;
  /**
   * 이 시스템에서의 역할. 포털이 지정하지 않았으면 아예 실리지 않는다.
   * "안 왔다" 와 "이상한 값이 왔다" 는 다르게 다뤄야 하므로 unknown 으로 둔다 —
   * 무엇인지 정하는 곳은 sso-role.ts 의 decideRole 한 곳뿐이다.
   */
  role: unknown;
  /**
   * 「이 사람이 들어갈 수 있는 사내 시스템 목록」(포털의 `dss_services` 클레임).
   * 머리말 안 서비스 메뉴바를 그리는 데만 쓰고 **인가 판정에는 쓰지 않는다.**
   *
   * role 과 같은 이유로 unknown 이다 — 포털이 이 시스템에 그 값을 아직 안 실어
   * 줄 수 있고, 모양을 보고 거르는 곳은 service-menu-cookie.ts 한 곳뿐이다
   * (거기서 @dss/ui 의 normalizeServiceMenu 로 그릴 수 없는 칸을 버린다).
   */
  services: unknown;
};

export async function verifyIdToken(
  idToken: string,
  expectedNonce: string,
): Promise<SsoIdentity | null> {
  try {
    const { payload } = await jwtVerify(idToken, portalJwks(), {
      issuer: env.ssoIssuer,
      audience: env.ssoClientId,
      // 이 PC 와 포털의 시계 차이 몇 초를 흡수한다. 그 이상은 맞춰야 할
      // 시계지 감싸 줄 일이 아니다.
      clockTolerance: 30,
    });

    // 🔴 jwtVerify 는 서명·iss·aud·exp 까지만 본다. nonce 는 따로 봐야 한다.
    // 건너뛰면 예전 ID 토큰을 다시 들이미는 길이 열린 채로 남는다.
    if (payload.nonce !== expectedNonce) {
      console.error("[sso] nonce 가 일치하지 않습니다.");
      return null;
    }
    if (typeof payload.sub !== "string" || payload.sub === "") {
      console.error("[sso] id_token 에 sub 가 없습니다.");
      return null;
    }

    return {
      subject: payload.sub,
      name: typeof payload.name === "string" ? payload.name : null,
      email: typeof payload.email === "string" ? payload.email : null,
      role: payload.role,
      services: payload.dss_services,
    };
  } catch (error) {
    console.error("[sso] id_token 검증 실패:", error);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 백채널 로그아웃 — 포털이 "이 사람 세션 끊어라" 라고 알려 온다          */
/* ------------------------------------------------------------------ */

/** 규격이 정한 표시. 이것이 없으면 로그아웃 통보가 아니다. */
const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";

/**
 * 서명이 확인된 로그아웃 토큰의 **내용**만 본다. 누구를 끊으라는 것인지
 * 돌려주고, 로그아웃 토큰이 아니면 null.
 *
 * 서명 검증에서 떼어 낸 이유는 하나다: 이 판정은 포털도 네트워크도 없이
 * 시험할 수 있어야 한다(`npm run test:auth`). 서명은 jwtVerify 가 보고,
 * jwtVerify 가 **보지 않는** 것을 여기가 본다.
 */
export function readLogoutClaims(payload: Record<string, unknown>): string | null {
  // 🔴 nonce 가 있으면 ID 토큰이다. 규격이 로그아웃 토큰에 nonce 를 금지하는
  // 이유가 이것이다 — ID 토큰을 여기로 들이밀어 남을 로그아웃시키지 못하게 한다.
  if (payload.nonce !== undefined) {
    console.error("[sso] nonce 가 있는 토큰입니다(ID 토큰일 수 있음).");
    return null;
  }

  const events = payload.events;
  if (
    typeof events !== "object" ||
    events === null ||
    !(LOGOUT_EVENT in (events as Record<string, unknown>))
  ) {
    console.error("[sso] 로그아웃 이벤트 표시가 없습니다.");
    return null;
  }

  if (typeof payload.sub !== "string" || payload.sub === "") {
    console.error("[sso] 로그아웃 토큰에 sub 가 없습니다.");
    return null;
  }
  return payload.sub;
}

/**
 * 이 창구는 인증 없이 누구나 두드릴 수 있다. 그래서 서명 검증이 전부다 —
 * 건너뛰면 아무나 아무 사람이나 로그아웃시킬 수 있는 창구가 된다.
 */
export async function verifyLogoutToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, portalJwks(), {
      issuer: env.ssoIssuer,
      audience: env.ssoClientId,
      clockTolerance: 30,
    });
    return readLogoutClaims(payload as Record<string, unknown>);
  } catch (error) {
    console.error("[sso] 로그아웃 토큰 검증 실패:", error);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 로그아웃 — 포털 세션까지 끝낸다                                       */
/* ------------------------------------------------------------------ */

/**
 * 🔴 이 사이트 쿠키만 지우면 포털 세션은 그대로 살아 있다. 그러면 로그아웃한
 * 사람이 로그인 버튼을 한 번 누르는 것만으로, 누구인지 다시 묻지도 않고
 * 그대로 들어온다. 공용 PC 에서는 그것이 곧 로그아웃이 안 된 것이다.
 *
 * post_logout_redirect_uri 를 일부러 붙이지 않는다 — 붙이면 이 사이트의
 * 로그인 화면으로 돌아오는데, 그 화면은 "포털로 가세요" 한 장을 더 거치게
 * 할 뿐이다. 방금 모든 시스템에서 나간 사람이 있어야 할 곳은 포털이다.
 * (포털은 이 값을 지원한다 — 나중에 생각이 바뀌면 등록만 하면 된다.)
 */
export function endSessionUrl(): string {
  return `${env.ssoIssuer}/api/oidc/logout`;
}

/* ------------------------------------------------------------------ */
/* 포털 앱 런처로 가기 — 로그아웃이 **아니다**                           */
/* ------------------------------------------------------------------ */

/**
 * 포털의 앱 런처(`/apps`) — 이 사람이 쓸 수 있는 다른 사내 시스템이 타일로
 * 놓인 화면.
 *
 * 🔴 바로 위의 `endSessionUrl()` 과 헷갈리면 안 된다. 생김새가 닮았지만 하는
 * 일이 정반대다:
 *
 *   endSessionUrl()   /api/oidc/logout   포털 세션까지 **끊는다**
 *   portalAppsUrl()   /apps              세션을 **그대로 두고** 화면만 옮긴다
 *
 * 그래서 여기로 갔다가 돌아오면 다시 로그인하지 않는다. 프로토콜 주소가 아니라
 * 사람이 보는 화면이라 OIDC 왕복도 없다 — 평범한 링크 한 줄이면 된다.
 *
 * 이 함수가 화면이 아니라 이 파일에 있는 이유는 파일 머리말과 같다: 포털의
 * 주소를 아는 곳은 여기 한 곳뿐이어야 한다. 화면에서 `env.ssoIssuer` 를 직접
 * 읽어 붙이기 시작하면 포털이 옮겨 갈 때 고칠 곳이 흩어진다.
 *
 * 🔴 부르기 전에 `env.ssoConfigured` 를 본다. `env.ssoIssuer` 는 설정이 없으면
 * **던지므로**, 등록 전 PC 에서 그냥 부르면 머리말이 아니라 화면 전체가 죽는다.
 * (개선요청 dss-improvements 의 같은 이름 함수와 한 글자도 다르지 않다 —
 *  한쪽을 고치면 다른 쪽도 함께 봐야 한다.)
 */
export function portalAppsUrl(): string {
  return `${env.ssoIssuer}/apps`;
}

/* ------------------------------------------------------------------ */
/* 「이 사람의 합쳐진 알림」을 포털에 묻는다                              */
/*                                                                     */
/* 부르는 법과 거절 목록은 dss-auth/docs/사이트-알림-통로.md 에 있다.     */
/* 이 파일에 두는 이유는 파일 머리말과 같다 — 포털 주소와 자격증명을      */
/* 아는 곳은 이 파일 하나다. 화면은 받은 배열을 그릴 뿐이다.             */
/*                                                                     */
/* 🔴 자격증명은 로그인에 쓰는 것과 **같다**(SSO_CLIENT_ID/SECRET) —      */
/*    새 설정이 필요 없다. 위의 백채널 로그아웃 검증이 같은 포털·같은     */
/*    자격증명을 쓰는 것과 한 짝이다.                                    */
/* ------------------------------------------------------------------ */

/**
 * 이 왕복을 얼마나 기다릴지.
 *
 * 🔴 상한이 **반드시** 있어야 한다. 포털이 죽어 연결이 거절되면 fetch 는 곧바로
 * 실패하지만, 주소가 틀려 **응답이 없는 곳**을 두드리면 기본값으로는 하염없이
 * 기다린다. 이 종은 머리말에 있어 모든 화면에 딸려 오므로, 상한이 없으면 알림
 * 하나 때문에 사이트 전체가 멈춘 것처럼 보인다.
 *
 * 2초인 이유: 포털은 같은 사내망에 있고 30초 캐시까지 들고 있어 정상이라면
 * 수십 ms 다. 2초를 넘겼다는 것은 이미 정상이 아니라는 뜻이다.
 */
const NOTIFICATIONS_TIMEOUT_MS = 2000;

/**
 * 포털이 **다른 시스템들에** 물어 합쳐 준 알림.
 *
 * 🔴 여기에 **이 사이트(휴가)의 알림은 없다.** 포털은 부른 사이트 자신에게는
 *    묻지 않는다(되돌기와 30초 캐시 때문이다 — 그쪽 문서 「빠져 있는 것」 절).
 *    휴가가 제 결재 알림을 **내주는** 일은 별도이고, 그때 이 화면은
 *    `[...내것, ...받은것]` 으로 이어 붙이고 개수도 **더해야** 한다.
 *    지금은 자체 알림이 없어 받은 것이 곧 전부다.
 *
 * 칸 이름이 @dss/ui 의 `NotificationBellItem` 과 글자 하나까지 같아서 받은
 * 배열을 종에 **그대로** 넘긴다 — 그 타입 자체가 포털 응답의 거울이다.
 */
export type PortalNotificationFeed = {
  items: NotificationBellItem[];
  /**
   * 배지에 찍을 숫자. 🔴 **포털이 센 값 그대로** 나른다 — 줄 수로 다시 세지
   * 않는다. 세는 규칙은 시스템마다 다르고(A/S 는 같은 대상을 한 번만 센다),
   * 여기서 다시 세면 그 시스템의 종과 이 종이 서로 다른 숫자를 말하게 된다.
   */
  count: number;
  /**
   * 🔴 「한 곳이라도 못 물어봤다」는 표시. **「알림이 없다」와 다른 말이다.**
   * 지금은 화면에 쓰지 않지만(알림이 없는 것과 똑같이 그린다) 값을 버리지는
   * 않는다 — 나중에 「일부를 불러오지 못했습니다」를 보이기로 하면 여기 있다.
   */
  degraded: boolean;
  /**
   * 🔴 그 사람이 지운 알림의 열쇠 — **이 사이트 몫만** 온다.
   *
   * 남의 시스템 줄은 포털이 **제 손으로 걸러서** 보낸다(items 에서 빠져 있고
   * count 도 그만큼 줄어 있다). 하지만 **휴가 자신의 줄**은 포털이 손댈 수
   * 없다 — 애초에 포털이 보내지 않는 목록이고(위 칸 주석: 부른 사이트에는
   * 묻지 않는다), 우리가 제 DB 에서 직접 계산해 앞에 이어 붙이는 것이기
   * 때문이다. 그 걸러내기에 쓰라고 포털이 함께 보내 주는 것이 이 칸이다.
   *
   * 🔴 **이 칸을 안 쓰면 「휴가에서 지웠는데 휴가 종에만 그대로 뜬다」가
   *    된다** — 다른 시스템에서는 사라지는데 여기서만 남아 제일 헷갈린다.
   *    실제로 거르는 자리는 leave/portal-notifications.ts 의
   *    `bellFeedWithOwnFirst` 다. 거기인 이유: 자기 줄의 **열쇠를 만드는
   *    자리**가 거기라, 접두사 만드는 식이 두 벌이 되지 않는다.
   *
   * 열쇠 모양은 `items[].key` 와 같다(`{client_id}:{id}`). 지운 것이 없으면
   * 빈 배열이고, 포털이 지움 기록을 못 읽으면 빈 배열에 `degraded` 가 선다 —
   * 그때는 지웠던 줄이 다시 뜬다(지움은 보기를 미루는 것이지 자료를 지우는
   * 것이 아니라, 종을 통째로 끄는 것보다 낫다고 포털이 정했다).
   */
  dismissed: string[];
};

/**
 * 못 물어봤을 때의 답. 🔴 **던지지 않는다** — 알림 하나 때문에 머리말이,
 * 곧 사이트 전체가 깨지는 일은 없어야 한다(그쪽 문서: 사이트는 거절을 삼킨다).
 *
 * 🔴 `dismissed` 는 **빈 배열**이다. 못 물어봤으니 「지운 것이 없다」가 아니라
 *    「모른다」가 맞지만, 그 둘을 가르는 값을 두는 대신 지웠던 줄이 다시 뜨는
 *    쪽을 고른다 — 포털이 지움 기록만 못 읽었을 때의 답과 같은 모습이다(위 칸
 *    주석). 어느 쪽이든 종은 그려지고 화면은 뜬다.
 */
const UNREACHABLE: PortalNotificationFeed = {
  items: [],
  count: 0,
  degraded: true,
  dismissed: [],
};

/** 한 줄의 아홉 칸. 하나라도 글자가 아니면 그 줄만 버린다. */
function toBellItem(row: unknown): NotificationBellItem | null {
  if (typeof row !== "object" || row === null) return null;
  const { key, sourceId, sourceName, id, kind, kindLabel, subject, detail, href } =
    row as Record<string, unknown>;
  if (
    typeof key !== "string" ||
    typeof sourceId !== "string" ||
    typeof sourceName !== "string" ||
    typeof id !== "string" ||
    typeof kind !== "string" ||
    typeof kindLabel !== "string" ||
    typeof subject !== "string" ||
    typeof detail !== "string" ||
    typeof href !== "string"
  ) {
    return null;
  }
  return { key, sourceId, sourceName, id, kind, kindLabel, subject, detail, href };
}

/**
 * 포털의 답을 그릴 수 있는 모양으로 만든다. **네트워크를 타지 않는 순수
 * 함수라** 검사가 그대로 불러 본다(scripts/test-notification-bell.ts).
 *
 * 왜 한 번 더 보나: 포털은 우리 편이지만 그 답에는 **다른 시스템들이 만든
 * 글자**가 실려 온다. 한 시스템이 이상한 줄을 하나 섞어 보냈다고 머리말이
 * 통째로 깨지면 안 된다 — 그래서 모양이 안 맞는 줄은 **그 줄만** 버린다.
 * (주소가 그릴 수 없는 것이면 @dss/ui 가 또 한 번 거른다.)
 */
export function normalizePortalNotificationFeed(body: unknown): PortalNotificationFeed {
  if (typeof body !== "object" || body === null) return UNREACHABLE;
  const answer = body as Record<string, unknown>;

  const items: NotificationBellItem[] = [];
  if (Array.isArray(answer.items)) {
    for (const row of answer.items) {
      const item = toBellItem(row);
      if (item) items.push(item);
    }
  }

  // 🔴 숫자가 아니면 **0** 이다(줄 수로 대신 세지 않는다 — 위 count 주석).
  // 0 이면 배지만 안 그려지고 목록은 그대로 보인다.
  const count =
    typeof answer.count === "number" && Number.isFinite(answer.count) && answer.count > 0
      ? answer.count
      : 0;

  // 🔴 글자인 줄만 담는다 — 줄 걸러내기에 그대로 쓰이는 값이라, 글자가 아닌
  //    것이 섞이면 Set 안에서 영영 아무것과도 안 맞는 쓰레기가 된다. 칸 자체가
  //    없는 포털(아직 안 고친 판)에서는 **빈 배열**이 되어 예전 그대로 돈다.
  const dismissed = Array.isArray(answer.dismissed)
    ? answer.dismissed.filter((key): key is string => typeof key === "string")
    : [];

  return { items, count, degraded: answer.degraded === true, dismissed };
}

/**
 * 포털에 묻는다. 🔴 **어떤 일이 있어도 던지지 않는다** — 포털이 죽었든(503),
 * 우리를 거절했든(401·403·429), 주소가 틀렸든, 설정이 빠졌든 빈 목록이 나간다.
 *
 * @param subject 포털의 users.id (= ID 토큰의 sub). 이 사이트는 `web_users.authSub`
 *                로 들고 있다. 포털 계정과 이어지지 않은 사람(임시 로그인으로
 *                들어온 사람)은 물을 수 없다 — 빈 sub 로는 나가지 않는다.
 *
 * 🔴 자격증명은 **머리말(Authorization: Basic)** 로만 보낸다. 주소에 실으면
 *    포털이 400 으로 거절하고, 그 값은 이미 접근 로그에 남아 **다시 발급**해야
 *    한다(그쪽 문서). 값은 어떤 로그에도 찍지 않는다.
 */
export async function fetchPortalNotifications(
  subject: string,
): Promise<PortalNotificationFeed> {
  if (!subject) return UNREACHABLE;

  let response: Response;
  try {
    // 🔴 env 의 getter 는 값이 없으면 **던진다** — 그래서 try **안**에서 읽는다.
    // 설정이 빠진 것 때문에 머리말이 깨지면 안 된다(임시 로그인만 쓰는 PC).
    const credentials = `${encodeURIComponent(env.ssoClientId)}:${encodeURIComponent(
      env.ssoClientSecret,
    )}`;

    response = await fetch(`${env.ssoIssuer}/api/integration/notifications`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({ sub: subject }).toString(),
      // 포털의 답은 사람마다 다르고 방금 처리한 일이 바로 빠져야 한다.
      // 포털이 이미 30초 캐시를 들고 있으므로 여기서 또 담아 둘 이유가 없다.
      cache: "no-store",
      signal: AbortSignal.timeout(NOTIFICATIONS_TIMEOUT_MS),
    });
  } catch (error) {
    // 🔴 찍는 것은 오류의 **종류**뿐이다(TimeoutError·TypeError …).
    console.error(
      "[sso] 알림을 물어보지 못했습니다:",
      error instanceof Error ? error.name : "unknown",
    );
    return UNREACHABLE;
  }

  if (!response.ok) {
    // 거절 본문은 포털의 내부 설정을 설명할 수 있다. 상태만 남긴다.
    console.error("[sso] 알림 통로 거절:", response.status);
    return UNREACHABLE;
  }

  try {
    return normalizePortalNotificationFeed(await response.json());
  } catch {
    console.error("[sso] 알림 응답을 읽지 못했습니다.");
    return UNREACHABLE;
  }
}

/* ------------------------------------------------------------------ */
/* 「이 알림은 그만 보겠다」 — 지움을 포털에 **적는** 쪽                   */
/*                                                                     */
/* 🔴 바로 위(fetchPortalNotifications)와 같은 방향이다 — 우리가 포털에  */
/*    가는 길이고, POST 이고, 자격은 이 시스템의 client_secret(Basic)다. */
/*    주소만 다르다(/api/integration/notification-dismissals).          */
/*                                                                     */
/* 지움이 브라우저가 아니라 포털에 쌓이는 까닭: 브라우저 저장소는 주소   */
/* (포트)별로 갈려서 같은 사람이 시스템마다 다른 목록을 봤다 — A/S(3000) */
/* 에서 지운 줄이 휴가(3700)의 종에는 그대로 떴다. 포털 한 곳에 모으면   */
/* 어디서 지우든 사내 시스템 **전부의 종**에서 사라진다.                 */
/* 부르는 법은 dss-auth 의 docs/사이트-알림-통로.md 에 있다.             */
/* ------------------------------------------------------------------ */

/**
 * 한 번에 보낼 수 있는 열쇠 수.
 *
 * 🔴 **넘으면 포털이 400 으로 통째로 거절한다 — 앞의 200개만 받아 주지
 *    않는다.** 그래서 자르는 일을 보내는 쪽이 한다. 🔴 여기 값을 올려도 포털이
 *    안 올라가면 소용이 없다 — 이 숫자는 **저쪽을 따라가는 값**이지 우리가
 *    정하는 값이 아니다(dss-auth 의 MAX_DISMISSAL_KEYS_PER_REQUEST).
 */
const DISMISSALS_PER_REQUEST = 200;

/**
 * 열쇠 한 묶음을 포털에 적는다. 🔴 **던지지 않는다** — 돌려주는 것은
 * 「적혔는가」뿐이고, 까닭은 서버 로그에만 남는다.
 *
 * 자격증명을 읽는 자리·머리말에 싣는 방식·시간 상한·no-store 는 모두 묻는
 * 쪽(fetchPortalNotifications)과 **같은 모양**이다. 둘이 어긋나면 「알림은
 * 오는데 지움은 안 먹히는」 상태가 되고, 그 어긋남은 신고로만 드러난다.
 */
async function recordDismissalChunk(
  subject: string,
  keys: readonly string[],
): Promise<boolean> {
  let response: Response;
  try {
    // 🔴 env 의 getter 는 값이 없으면 던진다 — 그래서 try **안**에서 읽는다.
    //    설정이 빠진 것 때문에 ✕ 한 번이 화면을 깨면 안 된다.
    const credentials = `${encodeURIComponent(env.ssoClientId)}:${encodeURIComponent(
      env.ssoClientSecret,
    )}`;

    response = await fetch(`${env.ssoIssuer}/api/integration/notification-dismissals`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({ sub: subject, keys: keys.join(",") }).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(NOTIFICATIONS_TIMEOUT_MS),
    });
  } catch (error) {
    // 🔴 남기는 것은 오류의 **종류**뿐이다. 열쇠에는 결재 단계 id 같은 업무
    //    식별자가 들어 있어 그것도 찍지 않는다(포털이 같은 판단을 한다).
    console.error(
      "[sso] 알림 지움을 적지 못했습니다:",
      error instanceof Error ? error.name : "unknown",
    );
    return false;
  }

  if (!response.ok) {
    // 거절 본문은 포털의 내부 사정을 설명할 수 있어 상태 코드만 남긴다
    // (묻는 쪽과 같은 판단이다).
    console.error("[sso] 알림 지움 통로 거절:", response.status);
    return false;
  }

  return true;
}

/**
 * 「이 알림들은 그만 보겠다」를 포털에 적는다. 🔴 **어떤 일이 있어도 던지지
 * 않는다** — 묻는 쪽과 같은 약속이다. 못 적으면 그 줄이 종에 남을 뿐이고,
 * 그것이 머리말이, 곧 사이트 전체가 깨지는 것보다 훨씬 낫다.
 *
 * @param subject 포털의 users.id (= ID 토큰의 sub). 이 사이트는
 *                `web_users.authSub` 로 들고 있다. 🔴 **서버가 제 세션에서
 *                가진 값**이어야 한다 — 브라우저가 보낸 값을 그대로 넘기면
 *                남의 알림을 지울 수 있는 통로가 된다.
 * @param keys    `{client_id}:{id}` 모양. 모양이 틀리거나 모르는 시스템의
 *                것은 포털이 **조용히 버린다** — 한 줄 때문에 묶음이 통째로
 *                실패하지 않는다.
 * @returns 보낸 묶음이 **전부** 적혔는가. 하나라도 거절되면 false 다.
 *
 * 🔵 몇 번을 다시 보내도 안전하다 — 같은 열쇠를 두 번 지우는 것은 한 번
 *    지우는 것과 같다(포털이 이미 있는 열쇠를 조용히 넘긴다).
 */
export async function dismissPortalNotifications(
  subject: string,
  keys: readonly string[],
): Promise<boolean> {
  if (!subject) return false;

  // 같은 열쇠가 두 번 실려 와도 한 번만 보낸다. 포털은 어느 쪽이든 같은 답을
  // 주지만, 겹친 값이 200 칸을 차지해 묶음이 괜히 늘어나지 않게 한다.
  const wanted = Array.from(
    new Set(keys.filter((key): key is string => typeof key === "string" && key !== "")),
  );

  // 🔴 보낼 것이 없으면 **아예 부르지 않는다.** 빈 keys 는 포털이 400
  //    (no_keys)으로 거절하므로, 부르는 것은 거절 한 줄을 로그에 쌓는 일뿐이다.
  if (wanted.length === 0) return false;

  // 🔴 묶음을 **차례로** 보낸다(한꺼번에 던지지 않는다). 한 사람의 ✕ 한 번에
  //    포털로 여러 연결이 동시에 열리면, 인증 실패 세는 통(분당 20번)과 포털의
  //    DB 에 쓸데없는 봉우리를 만든다. 지금 이 사이트의 ✕ 는 한 번에 한 줄이라
  //    묶음은 늘 하나다 — 상한은 저쪽 규격을 그대로 지키려고 둔다.
  let recorded = true;
  for (let at = 0; at < wanted.length; at += DISMISSALS_PER_REQUEST) {
    const chunk = wanted.slice(at, at + DISMISSALS_PER_REQUEST);
    if (!(await recordDismissalChunk(subject, chunk))) recorded = false;
  }

  return recorded;
}

/* ------------------------------------------------------------------ */
/* 「이 알림은 확인했다」 — 누른 줄을 포털에 적는다 (2026-10-22)          */
/*                                                                     */
/* 🔴 ✕(지움)과 **뜻이 다르다.** ✕ 는 「지금은 그만 보겠다」라 재로그인  */
/*    하면 돌아오고, 줄을 **누르는 것**은 「해소됐다」라 돌아오지 않는다. */
/*    포털의 표도 그래서 둘이다(dss-auth 의 site-acknowledgements.ts).    */
/*                                                                     */
/* 🔴 **무엇을 없앨지 이 사이트는 판단하지 않는다.** 나가는 것은 열쇠뿐  */
/*    이고, 포털이 제 목록에서 그 줄을 찾아 **내용 지문을 직접 계산**해   */
/*    적는다. 사이트가 지문을 정할 수 있으면 아무 값이나 넣어 그 알림을   */
/*    영영 안 보이게 만들 수 있기 때문이다. 종에서 빠지는 것은 (기록이    */
/*    있고 · 지문이 지금 내용과 같고 · 분류가 「정보 확인용」) 셋이 다     */
/*    맞을 때뿐이라, 결재 승인처럼 **동작이 필요한 줄은 확인을 적어도     */
/*    남는다.**                                                        */
/*                                                                     */
/* 🔴 **이 함수는 제 알림(「지금 내 차례인 휴가 결재」)에는 부르지      */
/*    않는다** — 부르는 쪽은 components/PortalNotificationBell.tsx 다.   */
/*    까닭 둘: ① 포털은 부른 사이트 자신의 알림을 모른다(그쪽 문서       */
/*    「빠져 있는 것」 절) — 제 줄의 열쇠를 보내도 포털 목록에 없어       */
/*    조용히 버려진다(skipped). ② 이 시스템은 알림 분류 표가 없어 포털의 */
/*    기본값(ACTION=승인용)을 받는다 — 지금은 승인용이라 보내도 안       */
/*    빠지지만, 분류가 나중에 바뀌면 그때 결재 대기가 **조용히 사라진다.** */
/*    그래서 애초에 보내지 않는 편을 골랐다(판단 자리는                  */
/*    leave/portal-notifications.ts 의 isOwnBellItem).                  */
/*                                                                     */
/* ── 🔴 왜 지움 쪽과 **나눠 쓰지 않았나** ───────────────────────────── */
/* 두 통로는 자격증명도·몸통 모양도·상한도 같아서 한 함수로 묶고 주소만  */
/* 달리 받을 수 있다. 그래도 묶지 않았다 — 묶으려면 **이미 돌고 있는     */
/* 지움 쪽 코드를 고쳐야** 하는데, 이번 조각의 요구가 「[X] 는 지금대로」 */
/* 였다(2026-10-22). 돌고 있는 길을 건드리지 않는 쪽을 골랐다.          */
/* ------------------------------------------------------------------ */

/**
 * 「이 알림은 확인했다」를 포털에 적는다. 🔴 **어떤 일이 있어도 던지지
 * 않는다** — 묻는 쪽·지움 쪽과 같은 약속이고, 여기서는 한 가지가 더 걸려
 * 있다: 이 함수는 사람이 줄을 **누른 그 순간**에 불리는데 그 누름은
 * **다른 화면으로 건너가는 일**이기도 하다. 예외가 새면 못 적는 데서 그치지
 * 않고 이동까지 흔들린다(@dss/ui 의 notifyAcknowledged 가 한 겹 더 받아
 * 주지만, 그것에 기대지 않는다).
 *
 * @param subject 포털의 users.id (= ID 토큰의 sub). 이 사이트는
 *                `web_users.authSub` 로 들고 있다. 🔴 **서버가 제 세션에서
 *                가진 값**이어야 한다 — 브라우저가 보낸 값을 그대로 넘기면
 *                남의 알림을 확인 처리하는 통로가 된다.
 * @param key     `{client_id}:{id}` 모양 **하나**. 모양이 틀리거나 모르는
 *                시스템의 것은 포털이 조용히 버린다(skipped). 🔴 **이 사이트
 *                자신의 열쇠를 넘기지 마라** — 위 머리말 참조.
 *
 * 🔴 지움과 달리 **열쇠를 하나만 받는다.** 확인은 줄을 하나 누르는 일이라
 *    열쇠가 언제나 하나다. 지움처럼 200개씩 나눠 보내는 고리를 미리 두면
 *    아무도 안 돌리는 고리가 된다 — 「확인 전부」 같은 단추가 생기는 날
 *    그때 더한다(포털의 상한은 지움과 같은 값이다).
 *
 * @returns 적혔는가. 🔵 몇 번을 다시 보내도 안전하다 — 같은 열쇠를 두 번
 *          확인하는 것은 한 번 확인하는 것과 같다.
 */
export async function acknowledgePortalNotification(
  subject: string,
  key: string,
): Promise<boolean> {
  if (!subject) return false;

  // 🔴 빈 열쇠는 아예 보내지 않는다 — 포털이 400(no_keys)으로 거절하므로
  //    부르는 것은 거절 한 줄을 로그에 쌓는 일뿐이다(지움 쪽과 같다).
  if (!key) return false;

  let response: Response;
  try {
    // 🔴 env 의 getter 는 값이 없으면 던진다 — 그래서 try **안**에서 읽는다.
    //    설정이 빠진 것 때문에 줄 한 번 누르기가 깨지면 안 된다.
    const credentials = `${encodeURIComponent(env.ssoClientId)}:${encodeURIComponent(
      env.ssoClientSecret,
    )}`;

    response = await fetch(
      `${env.ssoIssuer}/api/integration/notification-acknowledgements`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        // 🔴 칸 이름은 `keys` 다(하나여도) — 지움 통로와 **같은 모양**이고,
        //    포털도 같은 파서를 쓴다(dss-auth 의 readDismissalKeys).
        body: new URLSearchParams({ sub: subject, keys: key }).toString(),
        cache: "no-store",
        signal: AbortSignal.timeout(NOTIFICATIONS_TIMEOUT_MS),
      },
    );
  } catch (error) {
    // 🔴 남기는 것은 오류의 **종류**뿐이다. 열쇠에는 결재 단계 id 같은 업무
    //    식별자가 들어 있어 그것도 찍지 않는다(포털이 같은 판단을 한다).
    console.error(
      "[sso] 알림 확인을 적지 못했습니다:",
      error instanceof Error ? error.name : "unknown",
    );
    return false;
  }

  if (!response.ok) {
    // 거절 본문은 포털의 내부 사정을 설명할 수 있어 상태 코드만 남긴다
    // (묻는 쪽·지움 쪽과 같은 판단이다).
    console.error("[sso] 알림 확인 통로 거절:", response.status);
    return false;
  }

  return true;
}

/* ------------------------------------------------------------------ */
/* 「이 사람에게 결재가 생겼다」 — 결재 메일을 쿡 찌른다 (2026-10-24)      */
/*                                                                     */
/* 포털은 결재 메일을 **제가 주기적으로 물어** 보내고 있다. 그래서 결재가 */
/* 생긴 순간이 아니라 그 다음 바퀴에서 메일이 나간다. 쓰는 분 요구가      */
/* 「결재건이 생기자마자」라서, 결재가 생긴 **뒤에** 포털을 한 번 찔러     */
/* 그 바퀴를 앞당긴다.                                                  */
/*                                                                     */
/* 🔴 **나가는 것은 「누구에게 생겼다」 하나뿐이다.** 신청자 이름도·날짜도 */
/*    ·휴가 종류도 싣지 않는다. 포털은 이 번호를 받으면 그 사람의 결재를  */
/*    **제 통로로 다시 물어**(이 시스템의 /api/integration/approvals) 아직 */
/*    안 보낸 것에만 메일을 띄운다. 그래서 ① 이 시스템이 거짓을 보내도    */
/*    메일 내용이 흔들리지 않고 ② 포털의 「보낸 기록」이 중복을 막는다.   */
/*    몸통에 내용을 실으면 그 두 성질이 **동시에** 무너진다 — 부디 늘리지  */
/*    말 것.                                                            */
/*                                                                     */
/* 🔵 못 찔러도 메일이 안 가는 것이 아니다. 포털의 주기 작업이 다음 바퀴에 */
/*    같은 건을 줍는다 — 이 통로는 **빠르게 하는 것**이지 유일한 길이      */
/*    아니다. 그래서 실패를 통째로 삼킬 수 있다.                          */
/* ------------------------------------------------------------------ */

/**
 * 결재가 생겼음을 포털에 알린다. 🔴 **어떤 일이 있어도 던지지 않는다** —
 * 이 함수는 **휴가 신청이 이미 저장된 뒤**에 불리므로, 여기서 새는 예외는
 * 「신청은 됐는데 화면에는 실패라고 뜨는」 가장 나쁜 모양이 된다. 통로가 아직
 * 없어 404 가 오는 동안에도(다른 조각이 만드는 중이다) 똑같이 조용해야 한다.
 *
 * @param subs 결재할 사람의 **포털 번호**(= ID 토큰의 sub, `web_users.auth_sub`).
 *             여럿이면 `approverSub` 를 여러 개 실어 한 번에 보낸다 — 왕복이
 *             사람 수만큼 늘면 신청 한 번이 그만큼 느려진다.
 *
 * @returns 찔렀는가. 부르는 쪽은 이 값을 사람에게 보여 주지 않는다 —
 *          로그와 검사를 위한 값이다.
 */
export async function notifyPortalApprovalCreated(
  subs: readonly string[],
): Promise<boolean> {
  // 보낼 것이 없으면 아예 부르지 않는다 — 빈 몸통은 포털이 거절할 뿐이고,
  // 부르는 것은 거절 한 줄을 로그에 쌓는 일이다(지움 쪽과 같은 판단).
  const wanted = Array.from(
    new Set(subs.filter((sub): sub is string => typeof sub === "string" && sub !== "")),
  );
  if (wanted.length === 0) return false;

  const body = new URLSearchParams();
  // 🔴 `append` 다(`set` 이 아니다) — 결재자가 여럿일 때 같은 이름의 칸이
  //    여러 개 실려야 한다. `set` 이면 마지막 한 사람만 나가고, 빠진 사람은
  //    「메일이 조금 늦게 온다」로만 드러나 아무도 신고하지 않는다.
  for (const sub of wanted) body.append("approverSub", sub);

  let response: Response;
  try {
    // 🔴 env 의 getter 는 값이 없으면 던진다 — 그래서 try **안**에서 읽는다
    //    (이 파일의 다른 세 통로와 같은 모양).
    const credentials = `${encodeURIComponent(env.ssoClientId)}:${encodeURIComponent(
      env.ssoClientSecret,
    )}`;

    response = await fetch(`${env.ssoIssuer}/api/integration/approval-created`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      cache: "no-store",
      // 🔴 상한이 **반드시** 있어야 한다. 이 왕복은 사람이 [신청] 을 누른 뒤에
      //    붙는 시간이라, 포털이 응답 없는 주소가 되면 상한이 없는 만큼 그대로
      //    신청 화면이 멈춰 선 것처럼 보인다(알림 쪽과 같은 값, 2초).
      signal: AbortSignal.timeout(NOTIFICATIONS_TIMEOUT_MS),
    });
  } catch (error) {
    // 🔴 남기는 것은 오류의 **종류**뿐이다(TimeoutError·TypeError …).
    //    포털 번호는 사람을 가리키는 값이라 찍지 않는다.
    console.error(
      "[sso] 결재 알림을 찌르지 못했습니다:",
      error instanceof Error ? error.name : "unknown",
    );
    return false;
  }

  if (!response.ok) {
    // 🔵 통로가 아직 없는 동안에는 여기로 404 가 온다 — 고장이 아니다.
    //    상태만 남기는 것은 이 파일의 다른 통로와 같은 판단이다.
    console.error("[sso] 결재 알림 통로 거절:", response.status);
    return false;
  }

  return true;
}
