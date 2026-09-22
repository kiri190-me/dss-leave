/**
 * 실행 환경 값을 한곳에서 읽는다.
 *
 * 규칙: 비밀값이 없으면 조용히 기본값으로 넘어가지 않고 명확히 throw 한다.
 * 인증에서 "설정이 빠졌는데 그럭저럭 동작하는" 상태가 가장 위험하기 때문이다.
 *
 * getter 로 만든 이유: 모듈을 불러오는 시점이 아니라 실제로 값을 쓰는 시점에
 * 검사하기 위해서다. `next build` 는 각 화면의 서버 모듈을 실제로 불러오는데,
 * 도커 이미지를 구울 때는 .env 가 없다(.dockerignore 가 막는다 — 그게 맞다).
 * 모듈을 읽는 순간 던지면 빌드가 되지 않는다.
 *
 * SSO_ 로 이름을 맞춘 이유: A/S(RF_Service_System) · 계측기(njlee) ·
 * 개선요청(dss-improvements) · PO/내자(dss-po)가 모두 같은 이름을 쓴다.
 * Wi-Fi 가 바뀌어 IP 가 달라지면 여러 시스템을 같은 방식으로 고쳐야 한다.
 */

import { isAutoValue, primaryLanAddress, resolveAutoUrl } from "./lan-address";

/** 포털(dss-auth)의 포트. */
const PORTAL_PORT = 3100;

/**
 * 이 사이트의 포트.
 *
 * 3700 인 이유: 이 개발 PC 에서 3000 A/S · 3100 통합 로그인 포털 · 3200 회사
 * 홈페이지 · 3300 계측기 · 3400 시너지 출석부 · 3500 개선요청 · 3600 PO/내자가
 * 이미 쓴다. 로그인 왕복을 보려면 포털과 이 사이트가 **동시에** 떠 있어야
 * 하므로 겹치면 안 된다.
 */
const OWN_PORT = Number(process.env.PORT ?? 3700);

/** 포털에 등록된 이 시스템 redirect_uri 의 경로 부분. */
const SSO_CALLBACK_PATH = "/api/auth/sso/callback";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `환경변수 ${name} 이(가) 설정되지 않았습니다. .env.local 파일을 확인하세요.`,
    );
  }
  return value.trim();
}

function flag(name: string): boolean {
  return process.env[name] === "true";
}

/**
 * redirect_uri 에서 「밖에서 이 앱에 닿는 주소」만 떼어 낸다.
 *
 * ── 왜 새 환경변수를 두지 않는가 ────────────────────────────────────────
 * SSO_REDIRECT_URI 가 이미 **그 주소**다. 포털이 로그인 끝에 브라우저를 되돌려
 * 보내는 곳이므로, 정의상 「밖에서 이 앱에 닿는 주소」와 같아야 한다. 값을 하나
 * 더 두면 둘이 어긋날 수 있고, 어긋난 쪽이 알림 링크라면 증상은 「다른 사이트의
 * 종에서 누르면 엉뚱한 데로 간다」 하나뿐이라 원인을 찾기 어렵다.
 * `auto` 도 저쪽이 이미 풀어 준다.
 *
 * 콜백 경로를 떼어 낼 수 없으면 던진다 — 조용히 넘어가면 알림 링크가
 * `…/api/auth/sso/callback/approvals` 가 된다.
 *
 * (A/S 시스템 config/sso.ts 의 getAppBaseUrl 과 같은 판정이다.)
 */
export function appBaseUrlFrom(redirectUri: string): string {
  if (!redirectUri.endsWith(SSO_CALLBACK_PATH)) {
    throw new Error(
      `SSO_REDIRECT_URI 는 ${SSO_CALLBACK_PATH} 로 끝나야 합니다 — 이 값에서 이 앱 자신의 주소도 읽습니다.`,
    );
  }
  return redirectUri.slice(0, -SSO_CALLBACK_PATH.length).replace(/\/+$/, "");
}

export const env = {
  /** PostgreSQL 접속 주소 (이 사이트 전용 DB) */
  get databaseUrl(): string {
    return required("DATABASE_URL");
  },

  /**
   * 세션 쿠키에 secure 를 붙일지.
   * 사내망 HTTP 단계에서 true 로 켜면 쿠키가 저장되지 않아 로그인이 조용히 실패한다.
   */
  get sessionCookieSecure(): boolean {
    return flag("SESSION_COOKIE_SECURE");
  },

  /**
   * 임시 로그인 사용 여부. 기본값은 반드시 꺼짐.
   *
   * 통합 로그인이 붙은 뒤에도 **지우지 않는다** — 포털이 멈췄거나 아직 등록
   * 전일 때 들어갈 길이 하나는 있어야 한다. 두 길은 결국 세션을 만드는
   * createSession 하나로 모이므로 나란히 설 수 있다.
   */
  get devFakeLoginEnabled(): boolean {
    return flag("DEV_FAKE_LOGIN_ENABLED");
  },

  /** 세션 수명(시간). dss-auth SSO 세션의 절대 만료 12시간을 넘기지 않는다. */
  get sessionHours(): number {
    const raw = process.env.SESSION_HOURS;
    const n = raw ? Number(raw) : 12;
    if (!Number.isFinite(n) || n <= 0 || n > 12) return 12;
    return n;
  },

  /* ---------------------------------------------------------------- */
  /* DSS 통합 로그인 (dss-auth 포털)                                    */
  /* ---------------------------------------------------------------- */

  /**
   * 통합 로그인을 쓸 수 있게 설정돼 있는가. **던지지 않는** 유일한 검사다.
   *
   * 화면이 「포털로 들어가기」 버튼을 그릴지, 문지기가 포털로 곧장 보낼지,
   * 로그아웃이 포털까지 갈지를 정한다. 던지지 않아야 하는 이유: 아직 포털에
   * 등록하기 전(2026-09-21 현재)에도 임시 로그인으로 화면이 떠야 한다.
   *
   * 값의 **모양**까지 보지는 않는다. 틀린 값은 실제로 쓰는 자리에서 걸려야
   * 원인이 드러난다 — 여기서 조용히 false 로 만들면 "설정했는데 버튼이 없다"
   * 가 되어 찾기 더 어려워진다.
   */
  get ssoConfigured(): boolean {
    return Boolean(
      process.env.SSO_ISSUER?.trim() &&
        process.env.SSO_CLIENT_ID?.trim() &&
        process.env.SSO_CLIENT_SECRET?.trim() &&
        process.env.SSO_REDIRECT_URI?.trim() &&
        process.env.SSO_TX_SECRET?.trim(),
    );
  },

  /**
   * 포털 주소. ID 토큰의 iss 클레임과 문자 단위로 같아야 한다.
   *
   * 끝의 슬래시를 떼는 이유: "http://x/" 와 "http://x" 가 섞이면 iss 대조가
   * 실패하는데, 원인을 찾기가 가장 어려운 종류의 버그다.
   */
  get ssoIssuer(): string {
    // auto 면 이 기계의 사내망 주소로 푼다 — 개발 중에는 포털도 같은 PC 에 있다.
    const raw = required("SSO_ISSUER");
    const resolved = isAutoValue(raw)
      ? resolveAutoUrl(raw, PORTAL_PORT, primaryLanAddress())
      : raw;
    return resolved.replace(/\/+$/, "");
  },

  /** 포털에 등록된 이 시스템의 식별자. ID 토큰의 aud 이기도 하다. */
  get ssoClientId(): string {
    return required("SSO_CLIENT_ID");
  },

  /** 토큰 교환에만 쓴다. 브라우저에 절대 내보내지 않는다. */
  get ssoClientSecret(): string {
    return required("SSO_CLIENT_SECRET");
  },

  /**
   * 포털에 등록한 값과 문자 단위로 같아야 한다.
   *
   * 🔴 요청(request.url)에서 만들어 쓰지 않고 환경변수로 두는 이유: LAN 으로
   * 들어온 요청인데도 서버 자신의 바인딩 주소(localhost)가 보이는 경우가
   * A/S 시스템에서 실측되었다. redirect_uri 는 /authorize 와 /token 양쪽에서
   * 문자 단위로 대조되므로, 만들어 쓰면 "어떤 망에서는 되고 어떤 망에서는
   * 안 되는" 형태로 실패한다.
   *
   * auto 는 요청에서 만들어 쓰는 것과 다르다 — 이 기계의 네트워크 인터페이스를
   * 읽으므로 누가 부르든 같은 문자열이 나온다.
   */
  get ssoRedirectUri(): string {
    const raw = required("SSO_REDIRECT_URI");
    if (!isAutoValue(raw)) return raw;
    return `${resolveAutoUrl(raw, OWN_PORT, primaryLanAddress())}${SSO_CALLBACK_PATH}`;
  },

  /**
   * 밖에서 이 앱에 닿는 주소(스킴 + 호스트 + 포트). 뒤에 슬래시를 남기지 않는다.
   *
   * 다른 사이트의 종에 실릴 알림 링크를 절대 주소로 만드는 데 쓴다
   * (api/integration/notifications).
   *
   * 🔴 **요청의 Host 머리말에서 얻지 않는다.** 그 값은 부르는 쪽이 마음대로
   * 적는다(호스트 머리말 주입). 알림 링크는 **다른 사이트의 화면에 그려져 사람이
   * 누르는** 주소라, 부르는 쪽이 고른 호스트가 거기 실리면 그대로 피싱 링크가
   * 된다. ssoRedirectUri 가 request.url 을 쓰지 않는 것과 같은 판단이고,
   * 여기서는 이유가 하나 더 무겁다.
   */
  get appBaseUrl(): string {
    return appBaseUrlFrom(env.ssoRedirectUri);
  },

  /**
   * 로그인 왕복 동안 state·nonce·PKCE 검증값을 나르는 쿠키(leave_sso_tx)의 서명 키.
   *
   * 이 서명이 곧 PKCE 다 — 서명이 없으면 브라우저가 code_verifier 를 제 손으로
   * 바꿔 끼울 수 있어 PKCE 가 무의미해진다.
   */
  get ssoTxSecret(): string {
    const secret = required("SSO_TX_SECRET");
    if (secret.length < 32) {
      throw new Error("SSO_TX_SECRET 은 32자 이상이어야 합니다.");
    }
    return secret;
  },
};
