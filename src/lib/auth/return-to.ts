/**
 * 로그인을 마친 뒤 「원래 가려던 주소」로 보내도 되는지 정하는 한 곳.
 *
 * ── 왜 파일을 따로 두는가 ───────────────────────────────────────────────
 * 이 판정은 **순수 함수**여야 한다. 원래 있던 자리(auth/guards.ts)는
 * next/navigation 과 세션(→ drizzle → DB)을 끌고 들어와서, 시험이 이 판정
 * 하나를 보려고 DB 에 닿을 길을 열게 된다. `npm run test:auth` 는 DB 에도
 * 네트워크에도 닿지 않아야 한다. 그래서 여기에는 import 가 하나도 없다.
 *
 * ── 🔴 이 함수가 막는 것: 열린 전달(open redirect) ──────────────────────
 * 「가려던 주소로 보내 준다」는 잘못 만들면 **피싱 통로**가 된다.
 *
 *   http://leave.dss21.co.kr/api/auth/sso/start?returnTo=//가짜.example
 *
 * 받는 사람 눈에는 우리 회사 주소다. 진짜 통합 로그인으로 로그인까지 정상으로
 * 마친 뒤 마지막에 공격자 사이트로 떨어지고, 거기 똑같이 생긴 로그인 화면이
 * 있으면 사람은 「한 번 더 뜨네」 하고 비밀번호를 넣는다. 우리 도메인이 미끼가
 * 된 것이다.
 *
 * 그래서 **좁게 허용하고 의심스러우면 거절한다.** 거절해도 잃는 것은 첫 화면
 * 대신 한 번 더 누르는 일뿐이고, 허용을 잘못하면 잃는 것은 사람의 비밀번호다.
 *
 * ── 이웃 시스템과의 관계 ────────────────────────────────────────────────
 * 이 파일은 PO/내자(dss-po/src/lib/auth/return-to.ts)에서 **그대로 옮겨 왔다**
 * (2026-09-21). 이 저장소에도 개선요청(dss-improvements)과 같은 뿌리의
 * **네 줄짜리** 판정이 auth/guards.ts 에 있었고, 같은 구멍 둘을 갖고 있었다:
 * 제어문자를 막지 않아 "/(탭)/evil.example" 이 그대로 통과했고(브라우저가 탭을
 * 지우면 "//evil.example" 이 된다), 한글이 든 주소는 응답 머리말에 실리지 못해
 * 로그인이 500 으로 끝났다.
 *
 * A/S(RF_Service_System)에는 **같은 처리가 없다** — 그쪽 로그인은 돌아갈 주소를
 * 아예 나르지 않고 역할에 따라 정해진 화면으로만 간다. 이 시스템은 나른다:
 * 달력·결재함·내 휴가처럼 링크로 곧장 들어오는 화면이 많아서, 로그인 뒤에 첫
 * 화면으로만 떨구면 사람이 같은 링크를 다시 찾아야 한다.
 *
 * 프로토콜 쪽을 고칠 때는 dss-po·dss-improvements 의 같은 파일도 함께 본다.
 */

/**
 * 돌려주는 주소의 길이 상한(글자 수). 🔴 쿠키 크기 때문에 있다.
 *
 * 이 값은 leave_sso_tx 쿠키에 **통째로 담겨** 포털을 다녀온다. 쿠키 하나의
 * 한도는 브라우저마다 대략 4096바이트고, 넘으면 저장 자체가 조용히 실패해
 * 로그인이 이유 없이 「만료」로 끝난다.
 *
 * 셈: state 43 + nonce 43 + codeVerifier 86 + 칸 이름들 ≈ 260바이트에
 * 되돌아갈 주소 512바이트를 더해 772바이트, base64url 로 부풀어 ~1030자,
 * 서명 43자를 붙여 ~1075바이트. 한도의 4분의 1이다.
 *
 * 🔴 상한은 **정규화(퍼센트 인코딩)를 마친 뒤**의 길이에 건다. 한글 한 글자가
 * %EA%B2%B0 처럼 9자로 부푸므로, 날것의 길이에만 걸면 쿠키가 여섯 배로 커진다.
 */
export const RETURN_TO_MAX_LENGTH = 512;

/** 돌아갈 곳을 믿지 못할 때 가는 곳. 거절은 늘 이 값으로 끝난다. */
export const RETURN_TO_FALLBACK = "/";

/** 머리말(헤더)에 그대로 실을 수 있는 글자의 범위: '!' 부터 '~' 까지. */
const FIRST_HEADER_SAFE_CODE = 0x21;
const LAST_HEADER_SAFE_CODE = 0x7e;

/** 제어문자의 경계. 0x20(빈칸)은 제어문자가 아니고, 0x7f(DEL)은 맞다. */
const FIRST_PRINTABLE_CODE = 0x20;
const DELETE_CODE = 0x7f;

/**
 * 역슬래시(U+005C).
 *
 * 글자로 적지 않고 코드로 만드는 이유: 이 글자는 문자열 안에서 저를 감추는
 * 탈출 문자라, 편집기와 도구를 거치며 한 겹이 조용히 사라지는 일이 잦다.
 * 그러면 막으려던 것을 못 막으면서 코드는 멀쩡해 보인다.
 */
const BACKSLASH = String.fromCharCode(0x5c);

/**
 * 제어문자가 섞여 있는가.
 *
 * 🔴 브라우저는 주소에서 탭·줄바꿈·복귀를 **조용히 지운다** — 줄바꿈이 든
 * "/(줄바꿈)/evil.example" 은 지우고 나면 "//evil.example" 이 된다. 눈으로 보면
 * 슬래시가 하나뿐이라 안전해 보이는 것이 이 구멍이 오래 살아남는 까닭이다.
 *
 * 정규식에 제어문자를 적지 않는 것도 일부러다 — 그런 글자는 파일에 눈에 띄지
 * 않게 박혀 읽는 사람이 무엇을 막는지 알 수 없게 된다.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < FIRST_PRINTABLE_CODE || code === DELETE_CODE) return true;
  }
  return false;
}

/**
 * 이 사이트 **밖**을 가리키거나, 브라우저가 밖으로 읽을 수 있는 형태인가.
 *
 * 허용은 「'/' 하나로 시작하고 둘째 글자가 '/' 도 역슬래시도 아닌 것」 하나뿐이다.
 */
function looksOffSite(value: string): boolean {
  // "https://evil.example/x", "javascript:...", "data:...", 역슬래시로 시작하는 값
  if (!value.startsWith("/")) return true;
  // "//evil.example" — 프로토콜 생략 형태. 브라우저가 다른 사이트로 읽는다.
  // 역슬래시가 둘째 글자인 값 — 브라우저가 '/' 처럼 다루는 경우가 있다.
  const second = value.charAt(1);
  if (second === "/" || second === BACKSLASH) return true;
  // 뒤쪽에 섞인 역슬래시도 거절한다. 이 사이트의 주소에는 쓰이지 않는 글자다.
  if (value.includes(BACKSLASH)) return true;
  if (hasControlCharacter(value)) return true;
  return false;
}

/**
 * 한 겹 푼 모습. 풀지 못하면 null(= 거절).
 *
 * 왜 한 겹만 푸는가: 우리 손에 오기 전에 이미 한 겹이 풀려 있다
 * (searchParams.get 이 푼다). 브라우저는 Location 을 따라갈 때 경로를 **더
 * 풀지 않으므로** 날것 그대로가 곧 브라우저가 보는 것이다. 여기서 한 겹을 더
 * 보는 것은 어딘가 한 번 더 푸는 층이 생겼을 때를 위한 덤이다.
 * 두 겹, 세 겹까지 풀면 "/search?q=50%25" 같은 멀쩡한 주소를 거절하게 된다.
 */
function decodedOnce(value: string): string | null {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    // "%zz" 같은 반쪽짜리 이스케이프. 무엇이 될지 모르면 거절이 맞다.
    return null;
  }
}

/**
 * 이 사이트 안이지만 **사람이 도착할 곳이 아닌** 자리인가.
 *
 * /api/auth/sso/start 를 가리키면 로그인을 마치고 다시 로그인을 시작하는
 * 무한 되돌기가 된다. 콜백·백채널 로그아웃도 사람이 볼 화면이 아니다.
 * 대소문자를 내려 견주는 것은 규칙을 글자 모양에 기대지 않기 위해서다.
 */
function isLoginPlumbing(value: string): boolean {
  const path = value.split(/[?#]/, 1)[0].toLowerCase();
  return path === "/api/auth" || path.startsWith("/api/auth/");
}

/**
 * 머리말에 실을 수 있는 형태로 고친다. 고치지 못하면 null.
 *
 * 🔴 이것이 없으면 한글이 든 주소에서 **로그인이 500 으로 끝난다.** 응답
 * 머리말의 값은 ByteString(0~255)이라, "결"(U+ACB0) 같은 글자를 그대로 넣으면
 * Response 를 만드는 자리에서 TypeError 가 난다(실측). 퍼센트로 바꾸면
 * 주소창에는 그대로 한글로 보이고 화면의 searchParams 도 그대로 읽는다 —
 * 잃는 것이 없다.
 */
function toHeaderSafe(value: string): string | null {
  let result = "";
  // 문자열의 for…of 는 서로게이트 쌍(이모지)을 한 글자로 돌려준다.
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= FIRST_HEADER_SAFE_CODE && code <= LAST_HEADER_SAFE_CODE) {
      result += character;
      continue;
    }
    try {
      result += encodeURIComponent(character);
    } catch {
      // 짝 없는 서로게이트 하나. 정상적인 주소에는 나올 수 없다.
      return null;
    }
  }
  return result;
}

/**
 * 로그인 뒤 돌아갈 주소를 정한다. 믿을 수 없으면 첫 화면("/")이다.
 *
 * 돌려주는 값은 **이 사이트 안의 경로**이고, 응답 머리말에 그대로 실을 수 있는
 * 형태다. 물음표·'#'·한글은 살아서 돌아온다(한글은 퍼센트 인코딩된 모습으로 —
 * 브라우저 주소창과 화면의 searchParams 에서는 원래 글자 그대로다).
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (typeof value !== "string" || value === "") return RETURN_TO_FALLBACK;

  // 정규화 전에 한 번 자른다 — 아주 긴 값을 인코딩하느라 품을 들이지 않는다.
  if (value.length > RETURN_TO_MAX_LENGTH) return RETURN_TO_FALLBACK;

  if (looksOffSite(value)) return RETURN_TO_FALLBACK;

  const decoded = decodedOnce(value);
  if (decoded === null || looksOffSite(decoded)) return RETURN_TO_FALLBACK;

  if (isLoginPlumbing(value) || isLoginPlumbing(decoded)) return RETURN_TO_FALLBACK;

  const canonical = toHeaderSafe(value);
  if (canonical === null) return RETURN_TO_FALLBACK;

  // 🔴 쿠키 크기의 실제 상한은 여기다(위 RETURN_TO_MAX_LENGTH 의 셈).
  if (canonical.length > RETURN_TO_MAX_LENGTH) return RETURN_TO_FALLBACK;

  return canonical;
}
