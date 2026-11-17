/**
 * ============================================================================
 * [휴가 설정] 화면의 탭 — **누가 어느 탭을 보는가** (2026-11-17, 조각 3c)
 * ============================================================================
 * 그전까지 이 화면은 카드 다섯이 한 장에 늘어선 **관리자 전용** 화면이었다
 * (`requireAdmin()` 하나로 통째로 막혀 있었다). 거기에 「결재권 위임」 탭이
 * 붙으면서 **문이 탭마다 달라졌다.**
 *
 *   · 휴가 설정   — 지금까지 그대로 **휴가 관리자만**
 *   · 결재권 위임 — 🔴 **직원도 들어온다**
 *
 * ── 🔴 왜 직원도 들어오나 ────────────────────────────────────────────────
 * 위임을 **받은 사람**이 관리자가 아닌 것이 보통이다. 관리자만 보게 두면 대리인이
 * 「내가 누구를 대신하는지」를 **이 시스템 안에서는 영영 못 본다** — 결재함에 남의
 * 건이 갑자기 나타나는데 까닭을 알 길이 없다. A/S 가 같은 자리에서 같은 선택을
 * 했다(`auth/users-area-access.ts` — 결재선에 이름이 오른 사람은 `users.view` 가
 * 꺼져 있어도 그 탭 하나만 열린다).
 *
 * ── 🔴 화면에서 가리는 것으로는 아무것도 못 막는다 ────────────────────────
 * 서버 컴포넌트가 **읽은 값은 그리지 않아도 HTML 에 실려 나간다.** 그래서 탭을
 * 안 그리는 것만으로는 새어 나가고, 막는 자리는 **자료를 읽기 전**이어야 한다:
 *   ① 아래 `resolveSettingsTab` 이 **직원에게는 관리자 탭을 아예 안 돌려준다**
 *      (`?tab=settings` 라고 손으로 쳐도 결재권 위임 탭이 나온다).
 *   ② 그래도 화면은 관리자 갈래에서 `requireAdmin()` 을 **다시** 부른다.
 *      ①이 어느 날 느슨해져도 자료는 안 나가게 하는 두 번째 울타리다.
 *
 * ── 🔵 기본값을 안 바꿨다 ────────────────────────────────────────────────
 * 관리자가 `tab` 없이 `/admin/settings` 로 들어오면 **예전과 똑같이 휴가 설정**
 * 이다. 머리말 메뉴·공휴일 연도 넘기기(`?year=…`)가 전부 그 주소라, 기본값을
 * 바꾸면 **고친 적 없는 링크들이 엉뚱한 탭으로** 간다.
 * ============================================================================
 */

export const SETTINGS_TABS = ["settings", "delegation"] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const SETTINGS_TAB_LABEL: Record<SettingsTab, string> = {
  settings: "휴가 설정",
  delegation: "결재권 위임",
};

/** 주소에 실리는 이름. 🔴 글자를 바꾸면 밖에서 들어오는 링크가 조용히 기본 탭으로 간다. */
export const SETTINGS_TAB_PARAM = "tab";

/**
 * 그 탭으로 가는 주소. 🔴 **주소를 화면마다 적지 않는다** — 결재함 안내도 이 함수를
 * 부른다. 두 벌로 적으면 경로를 옮기는 날 한쪽이 404 로 남는다.
 *
 * 🔵 기본 탭에는 `?tab=` 을 안 붙인다 — 예전부터 쓰던 주소 그대로다.
 */
export function settingsTabHref(tab: SettingsTab): string {
  return tab === "settings" ? "/admin/settings" : `/admin/settings?${SETTINGS_TAB_PARAM}=${tab}`;
}

/** 이 사람에게 보일 탭들. 🔴 직원에게는 하나뿐이다. */
export function settingsTabsFor(isAdmin: boolean): SettingsTab[] {
  return isAdmin ? [...SETTINGS_TABS] : ["delegation"];
}

/**
 * 주소의 `?tab=` 을 **이 사람이 실제로 볼 수 있는 탭**으로 푼다.
 *
 * 🔴 직원이 `?tab=settings` 를 쳐도 돌려주는 값은 `delegation` 이다 — 내쫓지
 * 않고(쫓으면 위임을 보러 온 사람이 홈으로 튕긴다) **볼 수 있는 탭**을 준다.
 * 🔵 모르는 값·여러 번 적힌 값(`?tab=a&tab=b` 는 배열로 온다)은 기본값으로 본다.
 */
export function resolveSettingsTab(
  raw: string | string[] | undefined,
  isAdmin: boolean,
): SettingsTab {
  const allowed = settingsTabsFor(isAdmin);
  const asked = typeof raw === "string" ? raw : undefined;
  const found = allowed.find((tab) => tab === asked);
  return found ?? allowed[0];
}
