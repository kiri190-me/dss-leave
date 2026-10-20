import { isSafeNotificationHref, type NotificationBellItem } from "@dss/ui";

/**
 * 「보이는 알림 지우기」가 다루는 **열쇠 목록** — 모으는 쪽과 가리는 쪽.
 *
 * ── 왜 조각으로 뺐나 ────────────────────────────────────────────────────
 * 이 둘은 서버 액션 파일(app/actions/notifications.ts)에 둘 수 없다. 그 파일은
 * `"use server"` 라 **내보내는 것이 전부 async 함수**여야 해서, 평범한 함수를
 * 내보내면 Next 가 거절한다. 그렇다고 함수 안에 숨겨 두면 시험이 글자로만
 * 확인하게 되는데(그 파일의 다른 시험들이 그렇다) 여기 있는 것은 **브라우저가
 * 보낸 값을 가리는 판단**이라 실제로 불러 봐야 한다. 그래서 순수 함수로 빼고,
 * 시험이 그대로 불러 본다(`npm run test:bell`).
 *
 * 🔴 포털과 이야기하지 않는다. 이 파일은 글자만 다룬다 — 자격증명도 주소도
 *    모른다(그것은 oidc.ts 한 곳뿐이라는 약속).
 */

/**
 * 한 번에 지울 수 있는 열쇠의 **상한**.
 *
 * ── 🔴 왜 울타리가 필요한가 ─────────────────────────────────────────────
 * 이 목록은 서버 액션에 **미리 묶여**(bind) 브라우저로 내려갔다가, 단추를 누를
 * 때 브라우저가 **되돌려 보내는** 값이다. 곧 줄마다 서는 ✕ 와 똑같이 브라우저를
 * 한 번 거친 글자다(누구의 지움인지는 여전히 서버가 제 세션에서 읽는다 —
 * 그 선은 그대로다). 모양을 안 가리면 아무 수의 열쇠나 실려 올 수 있고,
 * 포털에 적는 쪽은 **200개씩 나눠 차례로** 보내므로(oidc.ts 의
 * DISMISSALS_PER_REQUEST) 열쇠 수가 곧 포털로 나가는 왕복 수가 된다 — 한 번
 * 누름이 수백 번 왕복이 되는 길이다.
 *
 * ── 왜 하필 2000 인가 ───────────────────────────────────────────────────
 * 종에 그려지는 줄은 두 갈래다.
 *
 *  · **받은 줄** — 포털은 **한 시스템당 200줄**에서 자른다(dss-auth 의 merge.ts
 *    의 `MAX_ITEMS_PER_SOURCE`). 사내 시스템이 일곱이고 포털은 부른 사이트
 *    자신에게는 묻지 않으므로, 아무리 많아도 여섯 × 200 = **1200** 이다.
 *  · **제 줄** — 「지금 내 차례인 휴가 결재」다. 🔴 이쪽에는 DB 상한이 없다
 *    (data.ts 의 pendingApprovalNotifications 에 LIMIT 이 없다). 다만 한 사람이
 *    동시에 들고 있는 결재 대기라 실측은 한 자릿수이고, 1200 위에 남겨 둔
 *    **800 칸**이 그 몫이다.
 *
 * 2000 은 그 둘의 합 위에 있다 — **정직한 누름은 여기 닿지 않고**, 닿았다면
 * 종에서 온 값이 아니다.
 *
 * 🔴 넘으면 **잘라 보내지 않고 통째로 거절한다.** 잘라 보내면 단추에 적힌
 *    「n건」과 실제로 지워진 수가 달라진다 — 사람에게 거짓말을 하는 것보다
 *    아무 일도 일어나지 않는 편이 낫다(그 줄들은 종에 남을 뿐이고, 이 통로가
 *    실패했을 때 이미 받아들인 모습이다 — actions/notifications.ts 의 ✕ 와 같다).
 */
export const MAX_DISMISS_KEYS_AT_ONCE = 2000;

/**
 * **지금 종에 그려지는 줄**의 열쇠를 모은다.
 *
 * 🔴 **합쳐진 뒤의 목록**을 받아야 한다(leave/portal-notifications.ts 의
 *    `bellFeedWithOwnFirst` 가 돌려주는 `items`). 이 사이트에는 **제 알림이
 *    있고**(「지금 내 차례인 휴가 결재」) 그것은 포털이 주지 않는다 — 받은
 *    목록만 넘기면 「전부 지우기를 눌렀는데 내 알림만 남는다」가 된다.
 *    제 줄도 그 함수가 이미 `{client_id}:{id}` 모양의 열쇠를 달아 둔
 *    상태라(toOwnBellItem), 여기서 열쇠를 다시 조립할 일은 없다.
 *
 * 🔴 `isSafeNotificationHref` 로 한 번 거르는 까닭: @dss/ui 는 그릴 수 없는
 *    주소(`javascript:` 같은 것)의 줄을 **안 그리고**, 단추에 적는 수도 그렇게
 *    남은 줄의 수다(그쪽 NotificationBell 의 `drawable`). 여기서 거르지 않으면
 *    「보이는 알림 지우기 3건」을 눌렀는데 4건이 지워진다 — 보이지도 않은 줄이
 *    말없이 사라지는 것이다. 거르는 함수를 **묶음에서 가져다 쓴다**(직접 적지
 *    않는다). 둘이 어긋날 수 없게.
 */
export function visibleNotificationKeys(items: readonly NotificationBellItem[]): string[] {
  const keys: string[] = [];
  for (const item of items) {
    if (!isSafeNotificationHref(item.href)) continue;
    if (item.key === "") continue;
    keys.push(item.key);
  }
  return keys;
}

/**
 * 브라우저에서 돌아온 열쇠 목록을 가린다.
 *
 * @returns 보낼 열쇠들. 🔴 **거절할 때는 `null`** 이다 — 「보낼 것이 없다(빈
 *          배열)」와 「믿을 수 없는 값이다(null)」를 가른다. 부르는 쪽은 둘 다
 *          아무 일도 하지 않지만, 가려 두면 나중에 한쪽만 로그에 남길 수 있다.
 *
 * 🔴 타입이 `unknown` 인 까닭: 부르는 쪽의 인자가 `readonly string[]` 로 적혀
 *    있어도 **그 약속은 브라우저가 지켜 주지 않는다.** 서버 액션으로 들어오는
 *    값은 tsc 가 지키는 범위 밖이다.
 */
export function vetDismissKeys(value: unknown): string[] | null {
  // 배열이 아니면 종에서 온 값이 아니다. 글자 하나·객체·없음 모두 여기서 멈춘다.
  if (!Array.isArray(value)) return null;

  // 🔴 울타리는 **가리기 전에** 잰다. 거른 뒤에 재면 쓰레기 10만 개를 거르는
  //    일 자체는 이미 한 뒤다.
  if (value.length > MAX_DISMISS_KEYS_AT_ONCE) return null;

  // 모양이 틀린 칸은 **그 칸만** 버린다 — 한 칸 때문에 나머지를 못 지우면
  // 사람은 단추가 고장 났다고 읽는다. (포털도 모르는 열쇠를 조용히 버린다.)
  return value.filter((key): key is string => typeof key === "string" && key !== "");
}
