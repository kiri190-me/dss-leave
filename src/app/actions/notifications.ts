"use server";

import { revalidatePath } from "next/cache";

import type { NotificationBellItem } from "@dss/ui";

import { getViewer } from "@/lib/auth/guards";
import { dismissPortalNotifications } from "@/lib/auth/oidc";

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
