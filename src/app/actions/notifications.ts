"use server";

import { revalidatePath } from "next/cache";

import type { NotificationBellItem } from "@dss/ui";

import { getViewer } from "@/lib/auth/guards";
import { vetDismissKeys } from "@/lib/auth/notification-keys";
import { acknowledgePortalNotification, dismissPortalNotifications } from "@/lib/auth/oidc";
import { isOwnBellItem } from "@/lib/leave/portal-notifications";

/**
 * 머리말의 알림 종에서 ✕ 를 눌렀을 때 — 그 줄을 **포털에** 지운다.
 *
 * ── 🔴 왜 서버 액션인가 (중계 통로가 아니라) ────────────────────────────
 * 종은 서버 컴포넌트다(components/PortalNotificationBell.tsx). 클라이언트
 * 경계를 건널 수 있는 함수는 **서버 액션뿐이라**, @dss/ui 의 `onDismiss` 에
 * 넘길 수 있는 것이 이것 하나다.
 *
 * 그보다 중요한 까닭이 하나 더 있다: 포털에 지움을 적는 자격은
 * `client_secret` 이다. 브라우저용 중계 통로(route handler)를 뚫으면 거기서
 * 세션을 다시 검증하고 시크릿을 다시 다뤄야 한다 — **시크릿을 다루는 자리를
 * 하나 더 만드는** 일이다. 그 판단은 종 조각 맨 위 주석(「왜 서버에서
 * 가져오나」)에 이미 적혀 있고, 여기서 깨지 않는다. 서버 액션이면 시크릿은 이
 * 프로세스 밖으로 나가지 않고, 번들로는 **이 함수의 이름표**만 나간다.
 *
 * ── 🔴 누구의 지움인지는 **서버가** 정한다 ──────────────────────────────
 * 사람 번호(`sub`)를 인자로 받지 않는다. 받으면 브라우저가 아무 번호나 실어
 * 남의 알림을 지울 수 있다. 여기서 제 세션을 다시 읽어 그 값을 쓴다 —
 * 레이아웃이 이미 `requireViewer` 를 했더라도 **서버 액션은 따로 다시
 * 검증한다**(auth/guards.ts 머리말: 클라이언트가 보낸 값으로 판정하지 않고
 * 서버에서 세션을 검증해 얻은 값만 쓴다).
 *
 * 🔴 `redirect` 하는 `requireSession`·`requireViewer` 가 아니라 `getViewer` 를
 *    쓴다. 이 함수는 사람이 ✕ 를 누른 **그 순간** 불리는데, 세션이 막 끊긴
 *    경우에 종 하나 때문에 보던 화면이 포털 로그인으로 튀어서는 안 된다.
 *    그때는 아무 일도 일어나지 않는 편이 맞다(로그아웃도 같은 까닭으로
 *    getViewer 를 쓴다 — actions/auth.ts).
 *
 * ── 🔴 던지지 않는다 ───────────────────────────────────────────────────
 * @dss/ui 의 곁들이 조각이 이 함수를 누름 처리 **한가운데서** 부른다. 여기서
 * 예외가 새면 그 누름의 나머지 처리(바깥 눌러 접기·Esc)가 통째로 멈춘다.
 * 못 지우면 그 줄이 종에 남을 뿐이다 — 묻는 쪽(auth/oidc.ts)과 같은 약속이다.
 */
export async function dismissNotificationAction(
  item: NotificationBellItem,
): Promise<void> {
  try {
    const viewer = await getViewer();
    if (!viewer) return;

    // 🔴 열쇠는 브라우저에서 온 글자다. 포털이 모양이 틀리거나 모르는 시스템의
    //    열쇠를 조용히 버리므로 여기서 더 가릴 것은 없지만, 빈 값은 아예
    //    보내지 않는다(그 묶음은 포털이 400 으로 거절한다).
    //    🔵 이 값으로 **지워지는 것은 그 사람 자신의 알림뿐이다** — 누구의
    //    지움인지는 바로 위에서 서버가 정했다.
    const key = typeof item?.key === "string" ? item.key : "";
    if (key === "") return;

    const recorded = await dismissPortalNotifications(viewer.user.authSub, [key]);

    // 🔴 적히지 않았으면 다시 그리지 않는다. 포털이 거절했으면 다음 렌더의
    //    목록도 똑같고, 그때 하는 일이라고는 사이트 전체의 캐시를 쓸데없이
    //    버리는 것뿐이다. 그 줄은 종에 남는다 — 알고 받아들인 모습이다.
    if (!recorded) return;

    // ── 🔴 왜 `revalidatePath("/", "layout")` 인가 ────────────────────────
    // 종은 **사내 구간 레이아웃**이 그린다((internal)/layout.tsx). 라우트
    // 그룹이라 주소에 나타나지 않으므로 경로는 `/` 다. 지금 보고 있는 화면이
    // 무엇이든 그 레이아웃이 다시 그려져야 목록이 줄어든다 — 화면 하나만
    // 되살리면 레이아웃은 그대로라 ✕ 를 눌러도 줄이 남는다. 이 저장소의 다른
    // 서버 액션(actions/leave.ts · actions/admin.ts)이 쓰는 그 한 줄이다.
    //
    // 🔵 **누른 그 자리에서 즉시 사라지지는 않는다** — 줄은 다음 렌더에서
    //    빠진다. 알고 받아들인 값이다(즉시 지우려면 종을 클라이언트 조각으로
    //    바꾸고 목록 상태를 브라우저에 들어야 하는데, 그것이 위에서 피한
    //    길이다). 대신 이 한 줄이 있어 **그 다음 렌더가 실제로 줄어든다.**
    //
    // 🔵 포털의 30초 캐시에 걸리지 않는다 — 포털은 캐시에서 꺼낸 목록에도
    //    지움을 그 자리에서 다시 입힌다. 휴가 자신의 줄은 애초에 캐시를 거치지
    //    않고 매 요청 DB 에서 다시 센다(leave/data.ts).
    revalidatePath("/", "layout");
  } catch (error) {
    // 🔴 오류의 **종류**만 남긴다 — 열쇠에는 결재 단계 id 가 들어 있다.
    console.error("[bell] 알림 지움 처리에서 넘어졌습니다:", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * 머리말의 알림 종에서 **줄을 눌렀을 때** — 「확인했다」를 포털에 적는다.
 * (2026-10-22)
 *
 * 🔵 위 `dismissNotificationAction` 과 **같은 약속 위에 있다.** 서버 액션인
 *    까닭도, 사람 번호를 제 세션에서 읽는 것도, 던지지 않는 것도, 열쇠를
 *    로그에 안 찍는 것도, 되살리는 자리가 사내 구간 레이아웃인 것도 같다 —
 *    까닭은 거기 적혀 있다. 여기서는 **다른 점**만 적는다.
 *
 * ── 🔴 ① ✕ 와 **다른 일**이다 ──────────────────────────────────────────
 * ✕ 는 「지금은 그만 보겠다」라 재로그인하면 돌아오고, 누름은 「해소됐다」라
 * 돌아오지 않는다. 포털의 표도 둘이고 통로도 둘이다. 🔴 **두 단추를 한쪽으로
 * 합치지 말 것** — 쓰는 분이 「[X] 는 지금대로」라고 못 박았다(2026-10-22).
 *
 * ── 🔴 ② **제 줄(이 사이트 자신의 결재 대기)이면 포털을 부르지 않는다** ──
 * 이 사이트의 종은 「지금 내 차례인 휴가 결재」를 **제 손으로 계산해 앞에
 * 이어 붙인다**(components/PortalNotificationBell.tsx · 머리말 참조). 그
 * 줄을 포털에 보내면 두 가지 사정이 겹친다 — 포털은 부른 사이트 자신의
 * 알림을 모르므로 제 줄의 열쇠는 포털 목록에 없어 **조용히 버려지고**
 * (skipped), 이 시스템은 알림 분류 표가 없어 포털의 기본값(ACTION=승인용)을
 * 받는다 — 지금은 승인용이라 보내도 빠지지 않지만, 분류가 나중에 바뀌는 날
 * **결재 대기가 조용히 사라지는** 길이 열린다. 그래서 **애초에 보내지
 * 않는다**(아무 일도 하지 않는 것이 제 줄에 대한 정답이다 — 결재를 하면
 * 다음 화면에서 그 줄이 저절로 사라진다). 가르는 자리는
 * `leave/portal-notifications.ts` 의 `isOwnBellItem` 하나다.
 *
 * ── 🔴 ③ 무엇을 없앨지 **이 사이트는 판단하지 않는다**(포털 줄에 한해) ───
 * 보내는 것은 열쇠뿐이다. 「그때 본 내용과 같은가(지문)」도, 「동작이 필요한
 * 알림인가」도 포털이 제 목록을 보고 정한다. 결재 승인·부품 요청처럼 동작이
 * 필요한 줄은 확인을 적어도 **종에 남는다.**
 *
 * ── 🔴 ④ 이 함수는 **화면이 넘어가는 한가운데서** 불린다 ────────────────
 * 줄을 누르면 평범한 <a href> 가 그 화면으로 건너간다. 확인을 적는 일은 그
 * 옆에서 따로 일어나므로, 여기서 느려지거나 실패해도 **이동을 막으면
 * 안 된다.** @dss/ui 가 이 함수를 try 로 감싸 던져도 밖으로 내보내지 않고
 * (BellBehavior.tsx 의 notifyAcknowledged), 여기서도 제 손으로 한 번 더
 * 삼킨다 — 그 성질에 기대지 않는다.
 *
 * 🔵 되살리기는 ✕ 한 줄짜리와 같은 셈이다(적혔을 때만, 그리고 포털을 부른
 *    때만 — 제 줄이면 애초에 아무것도 안 바뀌었으므로 되살리지 않는다).
 */
export async function acknowledgeNotificationAction(
  item: NotificationBellItem,
): Promise<void> {
  try {
    const viewer = await getViewer();
    if (!viewer) return;

    // 🔴 **제 줄이면 여기서 멈춘다.** 포털을 부르지 않고, 되살리지도 않는다 —
    //    위 머리말 ② 참조. 이 검사가 이 조각에서 가장 중요한 한 줄이다.
    if (isOwnBellItem(item)) return;

    const key = typeof item?.key === "string" ? item.key : "";
    if (key === "") return;

    const recorded = await acknowledgePortalNotification(viewer.user.authSub, key);

    // 🔴 적히지 않았으면 다시 그리지 않는다 — 목록이 똑같을 것이므로 하는
    //    일이라고는 사이트 전체의 캐시를 버리는 것뿐이다(✕ 와 같은 셈).
    if (!recorded) return;

    revalidatePath("/", "layout");
  } catch (error) {
    // 🔴 오류의 **종류**만 남긴다 — 열쇠에는 결재 단계 id 가 들어 있다.
    console.error("[bell] 알림 확인 처리에서 넘어졌습니다:", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * 머리말의 알림 종에서 「**보이는 알림 지우기 n건**」을 눌렀을 때 —
 * 지금 그려져 있는 줄을 **한꺼번에** 포털에 지운다.
 *
 * 🔵 위 `dismissNotificationAction` 과 **같은 약속 위에 있다.** 세션에서 사람
 *    번호를 읽는 것도, 던지지 않는 것도, 열쇠를 로그에 안 찍는 것도, 되살리는
 *    자리가 사내 구간 **레이아웃**인 것도 같다 — 까닭은 거기 적혀 있다.
 *    여기서는 **다른 점 셋**만 적는다.
 *
 * ── 🔴 ① 인자를 **미리 묶어** 받는다 ───────────────────────────────────
 * @dss/ui 가 내준 자리는 `onDismissAll?: () => void` 로 **인자를 안 받는다.**
 * 그런데 지울 열쇠 목록을 아는 것은 사이트다(종에 무엇을 그릴지 사이트가
 * 정한다 — 이 사이트는 **제 줄까지** 얹는다). 종은 서버 컴포넌트라
 * `onDismissAll={() => 지운다(열쇠들)}` 처럼 평범한 화살표 함수를 클라이언트
 * 경계로 넘길 수 없다 — 건널 수 있는 것은 서버 액션뿐이다.
 *
 * 그래서 **값을 미리 묶은 서버 액션**을 넘긴다(`…bind(null, 열쇠들)`). 묶은
 * 함수도 여전히 서버 액션이고(React 가 `bind` 를 따로 손봐 둔다), 묶인 값은
 * RSC 응답에 실려 내려갔다가 누를 때 되돌아온다.
 *
 * ── 🔴 ② 그래서 받은 값을 **믿지 않는다** ───────────────────────────────
 * 인자가 브라우저를 한 번 거친다는 뜻이다. 🔵 이것은 새 위험이 아니다 —
 * 줄마다 서는 ✕ 도 이미 브라우저가 보낸 `item.key` 를 쓴다. **누구의 지움인지
 * (`sub`)는 여기서도 서버가 제 세션에서 읽는다.** 열쇠로 할 수 있는 일은
 * 「내 종에서 이 줄을 그만 보기」뿐이다.
 *
 * 모양과 수를 가리는 자리는 `vetDismissKeys` 다(lib/auth/notification-keys.ts).
 * 배열이 아니면·울타리를 넘으면 **아무 일도 하지 않는다.**
 *
 * ── 🔴 ③ 거절당해도 되살린다 — 위와 **반대**다 ──────────────────────────
 * 위 함수는 「적히지 않았으면 되살리지 않는다」가 맞다. 한 줄짜리라 거절은 곧
 * 「아무것도 안 바뀌었다」이고, 그때 되살리면 사이트 전체 캐시만 버린다.
 *
 * 여기서는 그 셈이 뒤집힌다. 열쇠가 200개를 넘으면 포털로 **여러 묶음**이
 * 나가고(oidc.ts 의 DISMISSALS_PER_REQUEST), 돌아오는 값은 「**전부** 적혔는가」
 * 다 — 가운데 하나가 거절돼도 나머지는 적혔다. 그때 안 되살리면 **이미 지워진
 * 줄이 종에 그대로 남아** 사람은 「눌렀는데 아무 일도 없다」고 읽고, 다음 화면
 * 이동까지 어긋난 목록을 본다.
 *
 * 🔴 이 사이트에서는 **한 묶음일 때도** 되살려야 한다. 제 줄을 거르는 일은
 *    포털이 돌려주는 `dismissed` 를 받아 **우리가** 하는데
 *    (leave/portal-notifications.ts 의 bellFeedWithOwnFirst), 그 값은 다음
 *    왕복에서야 온다. 되살리지 않으면 방금 지운 제 줄이 그대로 남는다.
 *
 * 한 묶음이 통째로 거절된 때만 쓸데없이 캐시를 버리는데, 그것은 사람이 단추를
 * **방금 누른** 직후라 다시 그리는 것이 손해가 아니다(한 번 누름에 한 번뿐이다).
 */
export async function dismissAllNotificationsAction(keys: readonly string[]): Promise<void> {
  try {
    const viewer = await getViewer();
    if (!viewer) return;

    // 🔴 타입이 `readonly string[]` 라고 해서 그 모양으로 오지 않는다 —
    //    서버 액션의 인자는 tsc 가 지키는 범위 밖이다(위 ②).
    const wanted = vetDismissKeys(keys);
    if (wanted === null) return;
    if (wanted.length === 0) return;

    // 🔴 돌려받는 「전부 적혔는가」를 **보지 않는다.** 일부만 적힌 경우가
    //    있고, 그때 되살리지 않으면 지워진 줄이 종에 남는다(위 ③).
    await dismissPortalNotifications(viewer.user.authSub, wanted);
    revalidatePath("/", "layout");
  } catch (error) {
    // 🔴 여기도 오류의 **종류**만 남긴다 — 몇 건이었는지도 적지 않는다.
    console.error("[bell] 보이는 알림 지움 처리에서 넘어졌습니다:", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
}
