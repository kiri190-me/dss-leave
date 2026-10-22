"use client";

import { useEffect } from "react";

/**
 * 머리말의 ☰ 서랍을 **저절로 접는다** (2026-10-22).
 *
 * 더해지는 것은 「접히는 때」 셋뿐이다:
 *   1. 서랍 안의 메뉴를 눌러 **화면을 옮겼을 때**
 *   2. 서랍이 열린 채 **검은 바탕을 눌렀을 때**
 *   3. **Esc** 를 눌렀을 때
 *
 * ── 🔴 이것은 「얹는 것」이지 갈아치우는 것이 아니다 ──────────────────────
 * ☰ 의 펼침·접힘은 여전히 details/summary 가, 즉 **브라우저가** 한다
 * (까닭은 AppHeader.tsx 머리말에 적혀 있다). 이 조각이 없거나 스크립트가 아직
 * 안 붙었어도 ☰ 는 눌러서 열리고 다시 눌러 접히고, 서랍의 링크는 그대로 눌린다.
 * 여기서 더해지는 것은 위 셋뿐이다 — 있으면 편하지만 없어도 메뉴를 못 쓰게 되지는
 * 않는다. (그래서 AppHeader 는 **서버 컴포넌트로 남는다.** 클라이언트 지시문은 이
 * 파일 하나에만 붙는다 — 아무것도 그리지 않는 이 조각이 그 경계다.)
 *
 * ── 🔴 그리는 것이 없다 ──────────────────────────────────────────────────
 * null 을 돌려준다. 마크업이 한 글자도 늘지 않으므로 머리말의 모양·차례가 그대로고,
 * 서버에서 그린 것과 브라우저에서 그린 것이 같아 hydration 이 어긋나지 않는다.
 * 그릴 것이 없으니 붙잡을 DOM 마디도 없다 — 그래서 아래 손잡이는 머리말이 제 ☰ 에만
 * 달아 둔 표식으로 찾는다.
 *
 * ── 🔴 서버에서 그릴 때 안전하다 ─────────────────────────────────────────
 * 화면의 물건(document)을 만지는 곳은 useEffect **안**뿐이다. 그리는 동안에는
 * 아무것도 만지지 않으므로 react-dom/server 로 그려도 터지지 않는다
 * (node 에는 document 가 아예 없어서, 만지는 순간 시험이 바로 빨개진다).
 *
 * ── 🔴 메뉴바·알림 종의 「바깥 눌러 접기」와 **다른 물건**이다 ─────────────
 * 저쪽(@dss/ui)은 제 펼친 목록만 본다. 이 조각은 머리말이 제 ☰ 에만 달아 둔 표식을
 * 보므로 둘이 서로를 건드리지 않는다. 🔴 저쪽은 **목록 안을 누른 것은 일부러 안
 * 접는다** — 거기 링크는 다른 사이트로 나가면서 화면이 통째로 바뀌기 때문이다.
 * 우리 ☰ 서랍은 반대다: 서랍의 링크는 같은 앱 안의 이동(next/link)이라 머리말이
 * 다시 그려지지 않고 **그대로 살아남는다** — 접지 않으면 옮겨 간 화면을 서랍이 덮고
 * 있어 ☰ 를 한 번 더 눌러야 한다. 그래서 **서랍 안을 눌렀을 때도 접는다.**
 * 🔴 「저쪽과 다르다」는 까닭만으로 되돌리지 마라 — 틀린 것이 아니라 쓰임이 다르다.
 */

/**
 * 지금 **펼쳐져 있는** 우리 ☰ 만 고른다.
 *
 * 🔴 열린 details 를 넓게 잡지 않는다 — 그러면 화면 어딘가의 **남의 details** 까지
 *    함께 접는다(지금은 없더라도, 생기는 날 아무 오류 없이 조용히 어긋난다).
 *    그래서 머리말이 제 ☰ 에만 달아 둔 칸(data-header-menu)으로 찾는다.
 *    🔴 두 곳이 같은 이름을 써야 돈다 — 한쪽만 바꾸면 **아무것도 안 접히는데 오류도
 *    안 난다.** 그래서 scripts/test-app-header.ts 가 두 파일을 맞대어 본다.
 * 🔵 선택자에 「펼쳐진 것」 조건을 넣어 둔 덕에 「열려 있는가」를 따로 물어볼 필요가
 *    없다. 접혀 있는 것은 애초에 손잡이로 싸지지 않는다.
 */
const OPEN_HEADER_MENUS = "details[data-header-menu][open]";

/**
 * 서랍 안에서 **눌러서 어딘가로 가는 것**. 화면 링크들과 [통합 로그인으로]·검은
 * 바탕이 a/button 이고, [로그아웃]은 form 안의 submit 단추다.
 *
 * 🔴 「서랍 안을 누르면 무조건 접는다」로 하지 않는 까닭: 서랍에는 눌러도 아무 데도
 *    가지 않는 것들이 함께 있다(이름 · 직급 배지 · 「휴가 관리자」 배지 · 빈 여백).
 *    그것을 짚은 것은 가는 것이 아니므로 그대로 둔다. 나중에 서랍에 고르개가 들어오는
 *    날에도 같은 규칙이 지켜 준다 — 고르개를 펼치려 누른 것에 접히면 고를 수가 없다.
 */
const PANEL_ACTIONS = "a, button";

/**
 * 붙였다 떼는 방식.
 *
 * capture 로 듣는 이유: 중간의 누군가가 stopPropagation 을 부르면 버블 단계의 리스너는
 * 사건을 못 듣는다(머리말 안에 앉는 조각이라 실제로 남의 손이 닿는 자리다). 우리는
 * 듣기만 하고 preventDefault 도 stopPropagation 도 하지 않으므로, 먼저 듣는다고 해서
 * 사이트 쪽 동작을 가로채지 않는다.
 *
 * 🔴 떼어낼 때도 **같은 옵션**을 넘겨야 한다 — capture 가 다르면 브라우저는 다른
 *    리스너로 보고 떼지 않는다. 그래서 값을 한 곳에 두고 양쪽이 같이 쓴다.
 */
const LISTEN = { capture: true } as const;

/**
 * 접을 수 있는 ☰ 하나. **진짜 DOM 이 아니라 이 최소한의 모양**만 받는다 — 덕분에
 * 브라우저 없이 시험할 수 있다(이 저장소의 검사에는 jsdom 이 없다. 화면을 그려 재는
 * 검사가 아예 없어서, scripts/test-app-header.ts 는 소스 글자와 가짜로 잰다).
 */
export type HeaderMenuHandle = {
  /** 누른 자리가 이 ☰ 묶음 **안**인가 (☰ 단추와 서랍 전부). */
  contains(node: EventTarget | null): boolean;
  /** 누른 자리가 **서랍 안의 「눌러서 가는 것」**(링크·단추)인가. ☰ 단추 자신은 아니다. */
  activatesInPanel(node: EventTarget | null): boolean;
  /** 접는다. 초점이 안에 있었으면 ☰ 단추로 돌려준다. */
  close(): void;
};

/** 사건을 듣는 곳(실제로는 document). 시험에서는 가짜를 넣는다. */
export type HeaderMenuEventHost = {
  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: boolean | EventListenerOptions,
  ): void;
};

/**
 * 누른 자리가 **바깥**인 ☰ 만 접는다 (바깥 누르기).
 *
 * 🔴 서랍 안도, ☰ 단추도 「바깥」이 아니다 — 여기서는 접지 않는다. 서랍 안은 아래
 *    `dismissOnPanelAction` 이 **나중에 오는 click 으로** 접는다(까닭은 watchHeaderMenus).
 */
export function dismissOutside(
  handles: readonly HeaderMenuHandle[],
  target: EventTarget | null,
): void {
  for (const handle of handles) {
    if (handle.contains(target)) continue;
    handle.close();
  }
}

/**
 * 서랍 안의 **링크·단추를 누른** ☰ 를 접는다 (화면을 옮기면 접기 · 검은 바탕 누르기).
 *
 * 🔴 ☰ 단추(summary)를 누른 것은 여기 들지 않는다 — 접는 일은 그때 브라우저가 하고
 *    있고, 우리가 함께 접어 봐야 그 누름이 다시 펼쳐 **접히지 않는 단추**가 된다.
 */
export function dismissOnPanelAction(
  handles: readonly HeaderMenuHandle[],
  target: EventTarget | null,
): void {
  for (const handle of handles) {
    if (!handle.activatesInPanel(target)) continue;
    handle.close();
  }
}

/** 펼쳐진 것을 전부 접는다(Esc). */
export function dismissAll(handles: readonly HeaderMenuHandle[]): void {
  for (const handle of handles) {
    handle.close();
  }
}

/**
 * 진짜 화면에서 **지금** 펼쳐져 있는 ☰ 를 집어 손잡이로 싼다.
 *
 * 사건이 올 때마다 다시 찾는다(한 번 찾아 두고 쓰지 않는다). 머리말은 화면마다 다시
 * 그려질 수 있고, 붙잡아 둔 마디는 그때 이미 화면에서 떨어져 나간 것이 된다.
 */
export function openHeaderMenus(root: Document): HeaderMenuHandle[] {
  const handles: HeaderMenuHandle[] = [];

  root.querySelectorAll<HTMLDetailsElement>(OPEN_HEADER_MENUS).forEach((menu) => {
    // 이 ☰ 의 summary 는 하나뿐이다(AppHeader 가 그렇게 그리고, 그 검사가 1 로 못 박는다).
    const toggle = menu.querySelector("summary");

    // node 가 아닌 것(창 자체 같은)이 오면 contains 가 던진다 — 그런 것은 어차피 이 ☰
    // 안이 아니므로 「바깥」으로 친다.
    const inside = (node: EventTarget | null): boolean =>
      node instanceof Node && menu.contains(node);

    handles.push({
      contains: inside,
      activatesInPanel: (node) => {
        if (!inside(node)) return false;
        // 🔴 ☰ 단추 안은 무엇을 눌렀든 아니다 (위 dismissOnPanelAction 의 까닭).
        if (toggle !== null && node instanceof Node && toggle.contains(node)) return false;
        if (!(node instanceof Element)) return false;
        const action = node.closest(PANEL_ACTIONS);
        // 🔴 찾은 것이 **이 서랍 안**인지까지 본다 — closest 는 머리말 위로도 올라간다.
        return action !== null && menu.contains(action);
      },
      close: () => {
        // 🔴 접기 **전에** 본다. 접으면 안에 있던 것이 화면에서 사라져, 거기 있던 초점이
        //    갈 곳을 잃는다(문서 맨 처음으로 튄다). 키보드로 서랍을 훑다가 Esc 를 누른
        //    사람은 ☰ 로 돌아와야 바로 다시 펼치거나 다음 칸으로 나아갈 수 있다.
        const heldFocus = menu.contains(root.activeElement);
        menu.open = false;
        if (heldFocus) {
          toggle?.focus();
        }
      },
    });
  });

  return handles;
}

/**
 * 듣기 시작하고, **떼어내는 함수**를 돌려준다.
 *
 * 🔴 뒷정리가 이 함수의 절반이다. 화면이 사라질 때 떼지 않으면 리스너가 쌓여, 화면을
 *    오갈수록 누를 때마다 하는 일이 늘어난다. 돌려준 함수를 useEffect 가 그대로
 *    뒷정리로 쓴다.
 *
 * ── 🔴 바깥은 pointerdown, 안은 click — 듣는 사건이 왜 둘인가 ─────────────
 *   - **바깥**은 pointerdown 으로 듣는다. 마우스 · **손가락** · 펜을 한 번에 받는다.
 *     click 으로 듣지 않는 이유가 폰이다: iOS 는 누를 것이 아닌 곳(빈 바탕 등)에서
 *     click 을 문서까지 올려 보내지 않아, **폰에서만** 바깥 누르기가 안 먹는 일이
 *     생긴다(mousedown 도 손가락을 안 내는 기기가 있어 부족하다). 지금 고치는 것이
 *     바로 폰 화면이므로 이 선택이 핵심이다.
 *   - **서랍 안**은 반대로 click 이라야 한다. 🔴 pointerdown 에 접으면 눌린 링크·
 *     단추가 **손을 떼기 전에** 화면에서 사라져(접힌 details 의 안쪽은 그려지지
 *     않는다) **click 이 아예 안 난다** — 서랍만 닫히고 화면은 안 옮겨 가고
 *     [로그아웃]도 안 눌린다. click 은 이미 눌리고 난 **뒤에** 오는 사건이라, 그때
 *     접어도 그 누름이 취소되지 않는다(사건이 지나갈 길은 터질 때 이미 정해져 있어,
 *     중간 마디가 숨어도 링크의 손잡이와 단추의 기본 동작은 그대로 돈다).
 *   - keydown 의 Esc — 펼친 것에서 사람들이 기대하는 동작이고, 바깥을 누를 수 없는
 *     키보드 사용자에게는 **접을 유일한 길**이다. preventDefault 를 하지 않으므로
 *     사이트의 다른 Esc 처리를 가로채지 않고, 펼쳐진 ☰ 가 없으면 아무 일도 하지 않는다.
 *
 * 🔴 셋 어디서도 preventDefault·stopPropagation 을 부르지 않는다 — 듣기만 한다.
 *    [로그아웃]은 서버 액션을 부르는 form 의 submit 단추라, 누름을 취소하면
 *    **로그아웃이 안 된다.**
 */
export function watchHeaderMenus(
  host: HeaderMenuEventHost,
  openHandles: () => readonly HeaderMenuHandle[],
): () => void {
  const onPointerDown = (event: Event) => {
    dismissOutside(openHandles(), event.target);
  };

  const onClick = (event: Event) => {
    dismissOnPanelAction(openHandles(), event.target);
  };

  const onKeyDown = (event: Event) => {
    // "keydown" 으로 받은 것이라 KeyboardEvent 다.
    if ((event as KeyboardEvent).key !== "Escape") return;
    dismissAll(openHandles());
  };

  host.addEventListener("pointerdown", onPointerDown, LISTEN);
  host.addEventListener("click", onClick, LISTEN);
  host.addEventListener("keydown", onKeyDown, LISTEN);

  return () => {
    host.removeEventListener("pointerdown", onPointerDown, LISTEN);
    host.removeEventListener("click", onClick, LISTEN);
    host.removeEventListener("keydown", onKeyDown, LISTEN);
  };
}

/**
 * ☰ 안에 곁들이는 조각. **아무것도 그리지 않는다.**
 *
 * AppHeader 의 details 안에 하나 둔다 — 머리말 자체는 서버 컴포넌트로 남는다.
 */
export function HeaderMenuDismiss(): null {
  useEffect(() => watchHeaderMenus(document, () => openHeaderMenus(document)), []);

  return null;
}
