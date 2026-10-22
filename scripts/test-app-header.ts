/**
 * 머리말이 폰에서 쓸 만한가 검사.  npm run test:header
 *
 * 🔴 DB 에도 네트워크에도 닿지 않는다. 브라우저도 열지 않는다.
 *
 * ── 2026-10-22, 쓰는 분 요청 ────────────────────────────────────────────
 * 좁은 화면(768px 미만)에서 머리말이 갖춰야 할 것이 다섯으로 정해졌다:
 *   1. 알림 종이 머리말에 있다 (맨 오른쪽)
 *   2. 시스템 오가기 드롭다운이 머리말에 있다
 *   3. 시스템 이름이 **눈으로 보이게** 적혀 있다 (낭독기 전용으로 숨기는 것은 안 된다)
 *   4. ☰ 가 머리말 **왼쪽**에 있다
 *   5. 화면 메뉴들이 그 ☰ **서랍 안**에 들어가 있다
 * 아래 ① 이 그 다섯을 하나씩 못 박는다. 나머지 절은 그것을 떠받치는 것들이다.
 *
 * ── 🔴 왜 소스 글자로 재는가 ────────────────────────────────────────────
 * 이 저장소의 검사에는 **jsdom 도, 화면을 그려 재는 검사도 없다.** 머리말은 서버
 * 컴포넌트이고 로그아웃 서버 액션을 가져오므로 여기서 불러 볼 수조차 없다 —
 * test-notification-bell.ts · test-portal-notifications.ts 가 쓰는 처방을 그대로 쓴다.
 * 다만 **접을지 말지 가리는 판단**만은 진짜 DOM 없이 돌 수 있게 갈라 두었으므로
 * (HeaderMenuDismiss 의 손잡이·듣는 곳), ⑥ 에서는 가짜를 끼워 **실제로 돌려 본다.**
 *
 * ── 🔴 주석은 걷어내고 잰다 ─────────────────────────────────────────────
 * 고친 파일들의 주석에는 까닭이 일부러 길게 적혀 있다. 주석이 코드 대신 걸리면
 * 다음 사람이 **까닭이 적힌 주석을 지우는 쪽으로** 움직인다. 떼고 나서 빈 글자가
 * 아닌 것도 함께 확인한다 — 떼는 규칙이 낡으면 전부 조용히 통과한다.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  HeaderMenuDismiss,
  dismissAll,
  dismissOnPanelAction,
  dismissOutside,
  watchHeaderMenus,
  type HeaderMenuEventHost,
  type HeaderMenuHandle,
} from "../src/components/HeaderMenuDismiss";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const read = (relative: string): string =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

/** 주석을 걷어낸 코드만. */
function codeOnly(source: string): string {
  const out = source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(out.trim().length > 0, "주석을 떼고 나니 아무것도 안 남았다 — 떼는 규칙이 더는 안 맞는다");
  return out;
}

const HEADER = "src/components/AppHeader.tsx";
const DISMISS = "src/components/HeaderMenuDismiss.tsx";
const NAVLINK = "src/components/NavLink.tsx";

const code = codeOnly(read(HEADER));
const dismissCode = codeOnly(read(DISMISS));
const navCode = codeOnly(read(NAVLINK));

const count = (needle: string): number => code.split(needle).length - 1;

/** 클라이언트 지시문. 🔴 **낱말로 적지 않고 값으로 둔다** — 주석에 그대로 쓰면 글자로 세는 검사가 뒤집힌다. */
const CLIENT_DIRECTIVE = '"use client"';

/** ☰ 묶음 안쪽. 🔴 못 찾으면 멈춘다 — 빈 글자로 흘러가면 아래 단언이 전부 통과한다. */
function detailsBlock(): string {
  const start = code.indexOf("<details");
  const end = code.indexOf("</details>");
  assert.ok(start > 0 && end > start, "☰ 의 details 를 찾지 못했다 — 모양이 바뀌었으면 검사도 함께 고쳐라");
  return code.slice(start, end);
}

/** ☰ 의 여는 태그 하나. */
function detailsTag(): string {
  const start = code.indexOf("<details");
  const end = code.indexOf(">", start);
  assert.ok(start > 0 && end > start, "☰ 의 여는 태그를 읽지 못했다");
  return code.slice(start, end + 1);
}

/** 화면 링크를 쥔 조각(ScreenLinks)의 본문만. 자격 규칙을 **그 안에서** 센다. */
function screenLinks(): string {
  const start = at("function ScreenLinks(");
  const end = at("function AccountBox(");
  assert.ok(end > start, "ScreenLinks 가 AccountBox 뒤로 옮겨 갔다 — 잘라 내는 규칙을 함께 고쳐라");
  return code.slice(start, end);
}

/** 글자가 나오는 자리(없으면 멈춘다 — 못 찾은 것을 0 으로 흘려보내면 차례 비교가 거짓이 된다). */
function at(needle: string, where: string = code): number {
  const i = where.indexOf(needle);
  assert.ok(i >= 0, `${needle} 를 찾지 못했다 — 모양이 바뀌었으면 검사도 함께 고쳐라`);
  return i;
}

/* ------------------------------------------------------------------ */
/* ① 🔴 좁은 화면에서 갖춰야 할 다섯 (2026-10-22 쓰는 분 기준)           */
/* ------------------------------------------------------------------ */

check("① 1. 알림 종이 머리말 **맨 오른쪽**에 있다 — 서랍 밖이라 접어도 남는다", () => {
  assert.equal(count("{notificationBell}"), 1, "종이 사라졌거나 두 자리에 그려진다");
  assert.ok(
    at("{notificationBell}") > at("</details>"),
    "🔴 종이 ☰ 서랍 안으로 들어갔다 — 알림은 접힌 서랍에서 기다리면 안 된다",
  );
  // 🔴 「☰ 보다 오른쪽」으로는 부족하다. 종 **뒤에 아무 요소도 서지 않는가**를 본다 —
  //    하나라도 서면 그만큼 펼친 목록이 왼쪽으로 밀려 화면 밖으로 잘린다.
  const tail = code.slice(at("{notificationBell}") + "{notificationBell}".length);
  assert.ok(!/<[A-Za-z]/.test(tail), "종 오른쪽에 무언가가 더 섰다 — 폰에서 알림 목록 왼쪽이 화면 밖으로 나간다");
});

check("① 2. 시스템 오가기 드롭다운이 머리말에 있다 — ☰ 서랍 **밖**이다", () => {
  assert.equal(count("{serviceMenu}"), 1, "메뉴바가 사라졌거나 두 벌이 됐다");
  assert.ok(
    !detailsBlock().includes("{serviceMenu}"),
    "🔴 메뉴바가 ☰ 서랍 안으로 들어갔다 — 접으면 다른 시스템으로 갈 길이 함께 사라진다",
  );
});

check("① 3. 시스템 이름이 **눈으로 보이게** 적혀 있다 — 낭독기 전용으로 숨기지 않았다", () => {
  assert.equal(count("<Link "), 1, "머리말의 제목 링크가 사라졌거나 둘이 됐다");
  const 제목 = /<Link href="\/" className="([^"]*)">/.exec(code);
  assert.ok(제목, "제목 링크의 className 을 찾지 못했다");
  const classes = 제목[1].split(/\s+/).filter(Boolean);
  for (const 숨김 of ["hidden", "sr-only"]) {
    assert.ok(!classes.includes(숨김), `🔴 제목이 ${숨김} 으로 숨겨졌다 — 이름이 눈에 보여야 통과다`);
  }
  assert.ok(!classes.some((c) => c.includes(":")), `제목에 화면 폭 조건이 붙었다(${제목[1]}) — 좁은 화면에서 사라질 수 있다`);
  assert.ok(code.includes("tracking-tight text-slate-900\">휴가 관리</span>"), "제목 글자 「휴가 관리」가 사라졌다");
  assert.ok(at("tracking-tight") > at("</details>"), "제목이 ☰ 서랍 안으로 들어갔다");
});

check("① 4. ☰ 가 머리말 **맨 왼쪽**이다 — 시스템 이름보다도 앞", () => {
  const ham = at("<details");
  assert.ok(at("tracking-tight") > ham, "☰ 가 시스템 이름보다 뒤에 적혀 있다 — 맨 왼쪽이 아니다");
  assert.ok(at("{serviceMenu}") > ham, "☰ 가 메뉴바보다 뒤에 적혀 있다 — 맨 왼쪽이 아니다");
  assert.ok(at('className="ml-auto') > ham, "☰ 가 오른쪽 묶음 안에 있다");
});

check("① 5. 화면 메뉴가 ☰ **서랍 안**에 든다 — 좁은 화면 머리말에 알약으로 늘어서지 않는다", () => {
  // 가로 메뉴 줄은 768px 이상에서만 선다.
  assert.match(
    code,
    /<nav aria-label="화면" className="hidden[^"]*md:flex">/,
    "🔴 가로 메뉴 줄이 좁은 화면에서도 선다 — 알약이 늘어서고 ☰ 와 두 벌로 보인다",
  );
  // 그리고 **같은 링크**가 서랍 안에 세로로 선다.
  assert.ok(detailsBlock().includes('<ScreenLinks viewer={viewer} pendingCount={pendingCount} look="panel" />'), "서랍 안에 화면 메뉴가 없다");
  assert.equal(count("<ScreenLinks "), 2, "두 자리가 같은 조각을 쓰지 않는다");
});

/* ------------------------------------------------------------------ */
/* ② 🔴 머리말은 서버 컴포넌트로 남는다                                  */
/* ------------------------------------------------------------------ */

check("② 머리말에 클라이언트 지시문이 없다 — 경계가 깨지면 검사가 다 통과해도 build 에서만 드러난다", () => {
  assert.equal(count(CLIENT_DIRECTIVE), 0, "머리말이 클라이언트 컴포넌트가 됐다");
  assert.equal(count("'use client'"), 0, "따옴표만 바꾼 지시문이 들어왔다");
});

check("② 여닫는 일은 **브라우저**가 한다 — 상태도 이벤트 손잡이도 쓰지 않는다", () => {
  for (const bad of ["useState", "useEffect", "useRef", "usePathname", "onClick", "onChange"]) {
    assert.equal(count(bad), 0, `머리말에 ${bad} 가 생겼다 — 그 순간 파일 전체가 클라이언트로 내려간다`);
  }
  assert.equal(count("<details"), 1, "☰ 의 details 가 없거나 둘이 됐다");
  assert.equal(count("<summary"), 1, "summary 가 없거나 둘이 됐다");
});

check("② ▶ 삼각형을 **둘 다** 끈다 — 하나만 끄면 사파리에서만 남는다", () => {
  const panel = detailsBlock();
  assert.ok(panel.includes("list-none"), "list-none 이 없다 — 크롬·파이어폭스에 ▶ 가 남는다");
  assert.ok(panel.includes("[&::-webkit-details-marker]:hidden"), "웹킷 표식을 안 껐다 — 사파리에 ▶ 가 남는다");
});

check("② 머리말이 공용 묶음을 직접 부르지 않는다 — 다 그려진 노드만 받는다", () => {
  assert.equal(code.includes("@dss/ui"), false, "머리말이 공용 묶음을 직접 가져온다");
});

/* ------------------------------------------------------------------ */
/* ③ 🔴 접는 경계는 768px 하나다                                        */
/* ------------------------------------------------------------------ */

check("③ 경계가 셋에만 쓰인다 — 늘면 넓은 화면이 예전과 달라진다", () => {
  assert.equal(count("md:hidden"), 1, "☰ 가 서는 폭이 늘거나 줄었다");
  assert.equal(count("md:flex"), 2, "가로 메뉴 줄·나가는 길 묶음이 서는 폭이 늘거나 줄었다");
  assert.match(code, /<details className="[^"]*md:hidden/, "☰ 가 넓은 화면에서도 보인다");
  assert.ok(
    code.includes('"hidden flex-wrap items-center justify-end gap-x-3 gap-y-1.5 md:flex"'),
    "나가는 길 묶음이 좁은 화면에서도 머리말에 선다 — 서랍과 두 벌로 보인다",
  );
});

check("③ 경계 값이 공용 묶음의 메뉴바와 **같은 768px** 이다 — 한쪽만 옮기면 두 단추 모양이 어긋난다", () => {
  const css = read("vendor/dss-ui/src/service-menu/service-menu.css");
  assert.match(css, /@media not all and \(min-width: 768px\)/, "공용 묶음이 이름을 감추는 폭이 768px 이 아니다 — 머리말의 md 도 함께 맞춰라");
});

check("③ ☰ 가 좁은 폭에서 깎이지 않는다 — 손가락에 안 잡히는 크기가 된다", () => {
  assert.match(detailsTag(), /\bshrink-0\b/, "☰ 에 shrink-0 이 없다");
  assert.match(detailsBlock(), /\bh-9 w-9\b/, "☰ 단추의 크기가 바뀌었다");
});

/* ------------------------------------------------------------------ */
/* ④ 🔴 메뉴·나가는 길은 **한 벌**이다 — 폰용으로 베껴 적지 않았다        */
/* ------------------------------------------------------------------ */

check("④ 화면 링크가 한 조각에서 나온다 — 두 벌이면 폰과 컴퓨터가 다른 메뉴를 그린다", () => {
  assert.equal(count("function ScreenLinks("), 1);
  const links = screenLinks();
  for (const href of ['href="/"', 'href="/leave/new"', 'href="/leave"', 'href="/approvals"', 'href="/admin/employees"', 'href="/admin/settings"']) {
    assert.equal(links.split(href).length - 1, 1, `${href} 가 두 곳에 적혀 있다 — 고칠 때 한쪽이 잊힌다`);
  }
});

check("④ 자격 규칙도 한 벌이다 — 이 조각은 자리와 모양만 바꾼다", () => {
  // 🔴 머리말 전체가 아니라 **ScreenLinks 안**에서 센다 — 나가는 길 묶음에도 같은 값으로
  //    가리는 자리가 있어(직급 배지 · 「휴가 관리자」 배지) 전체로 세면 뜻이 흐려진다.
  const links = screenLinks();
  assert.equal(links.split("{employee && (").length - 1, 1, "명단에 연결된 사람만 보는 메뉴를 가리는 자리가 늘거나 줄었다");
  assert.equal(links.split("{viewer.canOpenApprovals && (").length - 1, 1, "결재함을 가리는 자리가 늘거나 줄었다");
  assert.equal(links.split("{viewer.isAdmin && (").length - 1, 1, "관리자 메뉴를 가리는 자리가 늘거나 줄었다");
});

check("④ 나가는 길(이름·통합 로그인으로·로그아웃)도 한 조각에서 나온다", () => {
  assert.equal(count("function AccountBox("), 1);
  assert.equal(count("<AccountBox "), 2, "두 자리가 같은 조각을 쓰지 않는다");
  assert.equal(count("{portalUrl && ("), 1, "포털 단추를 가리는 자리가 둘이 됐다");
  assert.equal(count("<form action={logoutAction}>"), 1, "로그아웃 폼이 둘이 됐다");
});

check("④ 나가는 길 묶음이 서랍 **바닥**에 있다 — 화면 메뉴 뒤다", () => {
  const panel = detailsBlock();
  assert.ok(at("<AccountBox", panel) > at("</nav>", panel), "서랍 안의 차례가 어긋났다");
  assert.ok(panel.includes('look="panel"'), "서랍이 서랍용 생김새를 안 쓴다");
});

check("④ 두 단추의 생김새가 한 값에서 나온다", () => {
  assert.equal(count("const HEADER_BUTTON ="), 1);
  assert.ok(
    code.includes('"rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"'),
    "🔴 넓은 화면의 단추 글자가 2026-10-22 이전과 달라졌다 — 폰 작업이 넓은 화면을 바꾸면 안 된다",
  );
});

check("④ 넓은 화면의 메뉴 알약도 예전 글자 그대로다", () => {
  assert.ok(
    navCode.includes('active: "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"'),
    "🔴 넓은 화면에서 고른 메뉴의 생김새가 달라졌다",
  );
  assert.ok(
    navCode.includes('idle: "rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900"'),
    "🔴 넓은 화면에서 안 고른 메뉴의 생김새가 달라졌다",
  );
  // 🔵 서랍 쪽만 글자를 안 꺾는 울타리를 두른다(서랍 폭이 고정이라). 넓은 화면 쪽에는
  //    두지 않는다 — 그 줄은 이미 줄바꿈이 켜져 있어 찌그러지는 대신 줄을 바꾼다.
  const panelLook = navCode.slice(at("panel:", navCode));
  assert.ok(panelLook.includes("whitespace-nowrap"), "서랍 메뉴에 글자를 안 꺾는 울타리가 없다");
});

/* ------------------------------------------------------------------ */
/* ⑤ 🔴 서랍의 모양 — 고정·쌓임 순서·노치·바닥 붙이기                    */
/* ------------------------------------------------------------------ */

check("⑤ 머리말이 굴러도 화면 위에 남는다 — position 은 하나뿐이다", () => {
  const headerClass = /<header className="([^"]*)"/.exec(code);
  assert.ok(headerClass, "머리말의 className 을 찾지 못했다");
  const classes = headerClass[1].split(/\s+/).filter(Boolean);
  assert.ok(classes.includes("sticky") && classes.includes("top-0"), "머리말이 고정되지 않는다");
  const positions = classes.filter((c) => ["static", "relative", "absolute", "fixed", "sticky"].includes(c));
  // 🔴 position 은 한 요소에 하나다. 둘이 적히면 Tailwind 가 CSS 를 찍는 차례에 따라
  //    한쪽이 **조용히** 이긴다 — 지는 날 머리말이 안 고정되거나 서랍 기준이 어긋난다.
  assert.deepEqual(positions, ["sticky"], `머리말에 position 이 둘 이상 적혔다: ${positions.join(" ")}`);
});

check("⑤ 🔴 인쇄 — 머리말은 통째로 사라진다. 그 표를 떼는 날엔 고정도 함께 되돌려야 한다", () => {
  const headerClass = /<header className="([^"]*)"/.exec(code)![1];
  const 사라진다 = headerClass.split(/\s+/).includes("no-print");
  const 되돌린다 = headerClass.includes("print:static");
  assert.ok(
    사라진다 || 되돌린다,
    "머리말이 인쇄에서 사라지지도 않고 고정을 되돌리지도 않는다 — 쪽마다 겹쳐 찍히거나 첫 쪽 본문을 가린다",
  );
  // 서랍 안에는 인쇄 숨김을 또 적지 않는다 — 바깥 머리말 하나로 통째로 사라진다.
  assert.ok(!detailsBlock().includes("print:hidden"), "인쇄 숨김이 두 벌이 됐다");
});

check("⑤ 서랍은 화면에 매달려 왼쪽에서 나온다 — 열어도 본문이 밀리지 않는다", () => {
  const panel = detailsBlock();
  // 🔵 z 값 자체는 여기서 못 박지 않는다 — 아래 「펼친 목록보다 위인가」가 **재서** 가른다.
  //    여기 숫자를 적어 두면 값을 낮춰도 이 줄이 먼저 빨개져, 정작 재는 검사가 영영 안 돈다.
  assert.match(panel, /<div className="fixed inset-0 z-\[\d+\] flex">/, "서랍 바깥이 화면을 꽉 채우지 않는다 — 검은 바탕이 화면 일부만 덮는다");
  assert.match(panel, /className="relative z-50 flex min-h-0 w-64 flex-col overflow-y-auto overscroll-contain/, "서랍 본체가 왼쪽에 선 고정폭 기둥이 아니거나, 길어질 때 구르지 않는다");
});

check("⑤ 🔴 머리말의 z 가 본문 쪽 최대보다 **위**다 (src 전체 실측)", () => {
  const headerZ = /<header className="[^"]*\bz-(\d+)\b/.exec(code);
  assert.ok(headerZ, "머리말의 z 를 찾지 못했다");

  const files = srcFiles();
  // 🔵 훑는 규칙이 낡으면 **아무것도 못 찾아 조용히 통과한다** — 그래서 먼저 센다.
  assert.ok(files.length > 40, `src 를 제대로 훑지 못했다(${files.length}개) — 찾은 것이 없으면 그냥 통과하는 검사다`);
  assert.ok(files.some((f) => f.endsWith("AppHeader.tsx")), "머리말 파일에 닿지 못했다");

  const top = { z: 0, file: "(없음)" };
  for (const file of files) {
    if (file.endsWith("AppHeader.tsx")) continue; // 머리말 **안**의 z 는 제 맥락 안에서만 겨룬다
    const body = codeOnly(readFileSync(file, "utf8"));
    for (const hit of body.matchAll(/\bz-(?:\[(\d+)\]|(\d+))\b/g)) {
      const z = Number(hit[1] ?? hit[2]);
      if (z > top.z) {
        top.z = z;
        top.file = file;
      }
    }
  }

  assert.ok(
    top.z < Number(headerZ[1]),
    `머리말(z-${headerZ[1]})보다 크거나 같은 z 가 본문에 있다 — ${top.file} 의 z-${top.z}. 머리말의 z 도 함께 올려라`,
  );
});

check("⑤ 🔴 서랍이 메뉴바·종의 펼친 목록보다 위다 (공용 묶음 CSS 실측)", () => {
  const 서랍 = /<div className="fixed inset-0 z-\[(\d+)\] flex">/.exec(detailsBlock());
  assert.ok(서랍, "서랍의 z 를 찾지 못했다");

  let 목록최대 = 0;
  for (const css of [
    "vendor/dss-ui/src/service-menu/service-menu.css",
    "vendor/dss-ui/src/notification-bell/notification-bell.css",
  ]) {
    const body = read(css);
    for (const hit of body.matchAll(/z-index:\s*(\d+)/g)) 목록최대 = Math.max(목록최대, Number(hit[1]));
  }
  assert.ok(목록최대 > 0, "공용 묶음 CSS 에서 z 를 하나도 못 찾았다 — 못 찾으면 그냥 통과하는 검사다");
  assert.ok(
    Number(서랍[1]) > 목록최대,
    `서랍(z-${서랍[1]})이 펼친 목록(z-index ${목록최대})보다 아래다 — 서랍을 열면 목록이 그 위에 뜬다`,
  );
});

check("⑤ 노치 인셋 둘 — 위는 머리말, 아래는 서랍. 패딩과 **한 클래스 안에서** 더한다", () => {
  // 🔴 따로 걸면 같은 padding 을 두 클래스가 다투고, 지는 날 아이폰에서 인셋이 조용히 사라진다.
  assert.ok(code.includes("pt-[calc(0.625rem+env(safe-area-inset-top))]"), "머리말 위 인셋이 없다");
  assert.ok(!/<div className="mx-auto flex[^"]*\bpy-2\.5\b/.test(code), "머리말 줄에 위아래를 한꺼번에 주는 패딩이 남아 있다");
  assert.ok(detailsBlock().includes("pb-[calc(0.75rem+env(safe-area-inset-bottom))]"), "서랍 아래 인셋이 없다 — 맨 아래 칸이 홈 인디케이터에 겹쳐 안 눌린다");
  assert.ok(!/className="relative z-50[^"]*\bpy-3\b/.test(detailsBlock()), "서랍에 위아래를 한꺼번에 주는 패딩이 남아 있다");
});

check("⑤ 🔴 나가는 길 묶음을 서랍 바닥에 붙이는 **빈 칸막이**가 있다 — 빈 칸이라고 지우지 마라", () => {
  const panel = detailsBlock();
  const nav = at("</nav>", panel);
  const 묶음 = at("<AccountBox", panel);
  const 사이 = panel.slice(nav, 묶음);
  const 칸막이 = /<div ([^>]*)\/>/.exec(사이);
  assert.ok(칸막이, "화면 메뉴와 나가는 길 **사이**에 빈 칸막이가 없다 — 받치는 것이 그 칸 하나다");
  const classes = (/className="([^"]*)"/.exec(칸막이[1])?.[1] ?? "").split(/\s+/).filter(Boolean);
  assert.ok(classes.includes("grow"), `칸막이가 남는 자리를 안 먹는다(class: ${classes.join(" ") || "(없음)"})`);
  assert.match(칸막이[1], /aria-hidden="true"/, "칸막이가 화면 낭독기에 읽힌다");
  // 🔴 margin-top:auto 는 **남는 자리가 있을 때만** 내려 준다. 메뉴가 서랍보다 길어지는
  //    순간 0 으로 풀려 구분선이 마지막 링크에 바짝 달라붙는다 — 간격이 가장 필요한 때다.
  assert.ok(!panel.includes("mt-auto"), "서랍에 mt-auto 가 들어왔다 — 메뉴가 길어지면 구분선 위 간격이 사라진다");
  assert.ok(code.includes('"mt-3 flex flex-col items-stretch gap-2 border-t border-slate-200 pt-3"'), "구분선 위 간격이 사라졌다");
});

check("⑤ 접혀도 **할 일이 있다는 것**은 보인다 — 세는 값은 하나", () => {
  assert.equal(count("const hasPending ="), 1, "☰ 의 점이 제 셈을 따로 갖는다");
  assert.equal(count("hasPending"), 3, "☰ 의 점과 이름이 같은 값을 보지 않는다(값 하나 + 쓰는 자리 둘)");
  assert.ok(code.includes("viewer.canOpenApprovals && pendingCount > 0"), "점을 가리는 조건이 결재함 메뉴와 다르다 — 문이 안 열리는 사람에게 점만 찍힌다");
  const panel = detailsBlock();
  assert.match(panel, /aria-label=\{hasPending \?/, "☰ 의 이름이 대기 건수에 따라 달라지지 않는다");
  assert.match(panel, /bg-amber-500/, "점이 결재함 배지와 다른 색이다 — 같은 일을 가리키는 두 표시는 같은 색이어야 한다");
  assert.match(panel, /aria-hidden="true"/, "눈에만 보이는 ☰ 글자·점이 낭독기에 두 번 읽힌다");
});

/* ------------------------------------------------------------------ */
/* ⑥ 🔴 저절로 접히는가 — 가짜를 끼워 **실제로 돌려 본다**               */
/* ------------------------------------------------------------------ */

/** 누른 자리 — 진짜 DOM 마디가 아니어도 된다. 견주기만 한다. */
const 자리 = (): EventTarget => ({}) as EventTarget;

/** 접을 수 있는 가짜 ☰ 하나. */
function 가짜메뉴(안쪽: readonly EventTarget[] = [], 가는것: readonly EventTarget[] = []) {
  let 접힌횟수 = 0;
  const handle: HeaderMenuHandle = {
    contains: (node) => node !== null && 안쪽.includes(node),
    activatesInPanel: (node) => node !== null && 가는것.includes(node),
    close: () => {
      접힌횟수 += 1;
    },
  };
  return { handle, 접힌횟수: () => 접힌횟수 };
}

type 등록 = { type: string; listener: (event: Event) => void; options?: boolean | AddEventListenerOptions };

/** 사건을 듣는 가짜 곳. 무엇을 붙였고 무엇을 뗐는지 그대로 적어 둔다. */
function 가짜듣는곳() {
  const 붙인것: 등록[] = [];
  const 뗀것: 등록[] = [];
  const host: HeaderMenuEventHost = {
    addEventListener: (type, listener, options) => {
      붙인것.push({ type, listener, options });
    },
    removeEventListener: (type, listener, options) => {
      뗀것.push({ type, listener, options });
    },
  };
  /** 아직 붙어 있는 리스너에게만 사건을 넘긴다 — 뗀 것은 부르지 않는다. */
  const 일으킨다 = (type: string, event: { target?: EventTarget | null; key?: string }) => {
    for (const 하나 of 붙인것) {
      if (하나.type !== type) continue;
      if (뗀것.some((x) => x.type === type && x.listener === 하나.listener)) continue;
      하나.listener(event as unknown as Event);
    }
  };
  return { host, 붙인것, 뗀것, 일으킨다 };
}

check("⑥ 바깥을 누르면 접힌다 — 누른 자리를 모르면 바깥으로 친다", () => {
  const 메뉴 = 가짜메뉴([자리()]);
  dismissOutside([메뉴.handle], 자리());
  assert.equal(메뉴.접힌횟수(), 1);

  const 둘 = 가짜메뉴([자리()]);
  dismissOutside([둘.handle], null);
  assert.equal(둘.접힌횟수(), 1);
});

check("⑥ 🔴 ☰ 묶음 **안**을 누른 것은 바깥이 아니다 — 그때 접으면 안 닫히는 단추가 된다", () => {
  const 안 = 자리();
  const 메뉴 = 가짜메뉴([안]);
  dismissOutside([메뉴.handle], 안);
  assert.equal(메뉴.접힌횟수(), 0, "그 누름이 다시 펼쳐 「안 닫히는 단추」가 된다");
});

check("⑥ 🔴 서랍의 링크·단추를 누르면 접힌다 — 같은 앱 안의 이동이라 머리말이 살아남는다", () => {
  const 링크 = 자리();
  const 메뉴 = 가짜메뉴([링크], [링크]);
  dismissOnPanelAction([메뉴.handle], 링크);
  assert.equal(메뉴.접힌횟수(), 1, "접지 않으면 옮겨 간 화면을 서랍이 덮는다");
});

check("⑥ 🔴 서랍 안이어도 **가는 것이 아니면** 안 접는다 — 이름·배지를 짚은 것", () => {
  const 글자 = 자리();
  const 메뉴 = 가짜메뉴([글자], []);
  dismissOnPanelAction([메뉴.handle], 글자);
  assert.equal(메뉴.접힌횟수(), 0);
});

check("⑥ 듣는 사건은 셋 — 바깥 pointerdown · 안 click · Esc keydown, 모두 capture", () => {
  const 듣는곳 = 가짜듣는곳();
  watchHeaderMenus(듣는곳.host, () => []);
  assert.deepEqual(듣는곳.붙인것.map((하나) => 하나.type).sort(), ["click", "keydown", "pointerdown"]);
  for (const 하나 of 듣는곳.붙인것) {
    assert.deepEqual(하나.options, { capture: true }, `${하나.type} 를 capture 로 안 듣는다`);
  }
});

check("⑥ 🔴 서랍 안은 **눌리고 난 뒤**(click)에 접힌다 — 누르는 순간 접으면 링크가 안 눌린다", () => {
  const 링크 = 자리();
  const 메뉴 = 가짜메뉴([링크], [링크]);
  const 듣는곳 = 가짜듣는곳();
  watchHeaderMenus(듣는곳.host, () => [메뉴.handle]);

  듣는곳.일으킨다("pointerdown", { target: 링크 });
  assert.equal(메뉴.접힌횟수(), 0, "누르는 순간 접으면 링크가 사라져 click 이 안 나고, 화면이 안 옮겨 간다");

  듣는곳.일으킨다("click", { target: 링크 });
  assert.equal(메뉴.접힌횟수(), 1, "눌리고 난 뒤에는 접어도 그 누름이 취소되지 않는다");
});

check("⑥ 바깥은 반대로 **누르는 순간**(pointerdown) 접힌다 — iOS 는 빈 바탕의 click 을 안 올려 보낸다", () => {
  const 메뉴 = 가짜메뉴();
  const 듣는곳 = 가짜듣는곳();
  watchHeaderMenus(듣는곳.host, () => [메뉴.handle]);
  듣는곳.일으킨다("pointerdown", { target: 자리() });
  assert.equal(메뉴.접힌횟수(), 1);
});

check("⑥ Esc 는 펼쳐진 것을 전부 접고, 다른 키는 아무 일도 하지 않는다", () => {
  const 하나 = 가짜메뉴();
  const 둘 = 가짜메뉴([자리()]);
  dismissAll([하나.handle, 둘.handle]);
  assert.equal(하나.접힌횟수(), 1);
  assert.equal(둘.접힌횟수(), 1);

  const 메뉴 = 가짜메뉴();
  const 듣는곳 = 가짜듣는곳();
  watchHeaderMenus(듣는곳.host, () => [메뉴.handle]);
  for (const key of ["Enter", "Tab", "e", "Esc", " "]) 듣는곳.일으킨다("keydown", { key });
  assert.equal(메뉴.접힌횟수(), 0, "글자를 치다 메뉴가 접히면 안 된다");
});

check("⑥ 🔴 사건이 올 때마다 다시 찾고, 붙인 것을 **전부** 떼어낸다", () => {
  let 찾은횟수 = 0;
  const 듣는곳 = 가짜듣는곳();
  const 뒷정리 = watchHeaderMenus(듣는곳.host, () => {
    찾은횟수 += 1;
    return [];
  });
  assert.equal(찾은횟수, 0, "붙이는 것만으로 화면을 뒤지지 않는다");

  듣는곳.일으킨다("pointerdown", { target: 자리() });
  듣는곳.일으킨다("click", { target: 자리() });
  듣는곳.일으킨다("keydown", { key: "Escape" });
  assert.equal(찾은횟수, 3, "머리말은 화면마다 다시 그려질 수 있다 — 그때마다 새로 찾아야 한다");

  뒷정리();
  // 옵션(capture)이 다르면 브라우저는 다른 리스너로 보고 떼지 않는다 — 그래서 옵션까지 대조한다.
  assert.deepEqual(듣는곳.뗀것, 듣는곳.붙인것, "리스너가 화면에 남는다 — 화면을 오갈수록 쌓인다");
});

/* ------------------------------------------------------------------ */
/* ⑦ 🔴 경계는 **새 파일 하나**이고, 표식이 두 파일에서 맞는가           */
/* ------------------------------------------------------------------ */

check("⑦ 접는 조각이 **클라이언트**다 — 지시문이 맨 앞 한 줄이다", () => {
  assert.ok(dismissCode.trimStart().startsWith(CLIENT_DIRECTIVE), "지시문이 맨 앞에 없다 — 아래에 적으면 조용히 안 먹는다");
  assert.equal(dismissCode.split(CLIENT_DIRECTIVE).length - 1, 1, "지시문이 둘이 됐다");
});

check("⑦ 조각은 **듣기만 한다** — 누름을 가로채면 로그아웃이 안 눌린다", () => {
  assert.ok(!dismissCode.includes("preventDefault"), "누름을 취소하고 있다");
  assert.ok(!dismissCode.includes("stopPropagation"), "사건을 가로채고 있다 — 사이트 쪽 동작이 함께 죽는다");
});

check("⑦ 🔴 조각이 찾는 표식이 머리말의 details 에 **실제로** 붙어 있다", () => {
  const 선택자 = /const OPEN_HEADER_MENUS = "([^"]+)"/.exec(dismissCode);
  assert.ok(선택자, "선택자를 못 찾았다 — 이름이 바뀌었으면 이 검사도 함께 고쳐라");
  const 표식 = /\[(data-[a-z-]+)\]/.exec(선택자[1]);
  assert.ok(표식, `선택자(${선택자[1]})에 data 표식이 없다 — 무엇으로 「우리 ☰」만 고르는지 알 수 없다`);
  // 🔴 includes 로 재지 마라 — 뒤에 글자가 더 붙은 이름도 **그 글자를 품고 있어** 통과한다.
  assert.match(detailsTag(), new RegExp(`\\s${표식[1]}(?=[=\\s>])`), `머리말의 details 에 ${표식[1]} 이 없다 — 서랍이 저절로 안 접히는데 오류도 안 난다`);
  assert.ok(선택자[1].includes("[open]"), "펼쳐진 것만 고르지 않는다 — 접혀 있는 것까지 헛되이 싼다");
  assert.ok(!dismissCode.includes('"details[open]"'), "선택자가 화면의 모든 details 를 집는다 — 남의 것까지 접는다");
});

check("⑦ 조각이 ☰ 의 details **안**에 한 번 놓인다 — 밖에 두면 영영 안 돌아도 모른다", () => {
  assert.equal(count("<HeaderMenuDismiss"), 1, "조각이 없거나 두 번 놓였다");
  assert.ok(code.includes("HeaderMenuDismiss } from"), "머리말이 조각을 가져오지 않는다");
  assert.ok(detailsBlock().includes("<HeaderMenuDismiss"), "조각이 ☰ 의 details 밖에 있다");
});

check("⑦ 🔴 검은 바탕이 **닫기로 이어진다** — 규칙이 두 파일에 흩어져 있다", () => {
  const LABEL = 'aria-label="메뉴 닫기"';
  assert.equal(count(LABEL), 1, "검은 바탕이 없거나 둘이다 — 서랍을 눌러 닫을 길이 사라졌다");
  assert.ok(detailsBlock().includes(LABEL), "검은 바탕이 ☰ 밖에 있다 — 아래 단언이 재는 전제가 통째로 달라진다");

  const 시작 = code.lastIndexOf("<", at(LABEL));
  const 태그 = code.slice(시작, code.indexOf(">", at(LABEL)) + 1);
  const 이름 = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(태그);
  assert.ok(이름, "검은 바탕의 태그 이름을 읽지 못했다");

  const 규칙 = /const PANEL_ACTIONS = "([^"]+)"/.exec(dismissCode);
  assert.ok(규칙, "PANEL_ACTIONS 를 못 찾았다 — 이름이 바뀌었으면 이 검사도 함께 고쳐라");
  const 걸리는것 = 규칙[1].split(",").map((하나) => 하나.trim());
  assert.ok(
    걸리는것.includes(이름[1]),
    `검은 바탕이 <${이름[1]}> 인데 PANEL_ACTIONS("${규칙[1]}") 에 그것이 없다 — 눌러도 서랍이 안 닫히는데 오류도 안 난다`,
  );
  // 🔴 빠지면 기본값이 submit 이다. 같은 서랍 안에 로그아웃 폼이 있다.
  assert.match(태그, /\stype="button"/, '검은 바탕에 type="button" 이 없다 — 마크업을 조금만 손대면 누를 때마다 로그아웃된다');
  assert.match(태그, /className="absolute inset-0 /, "검은 바탕이 서랍 바깥을 다 덮지 않는다");
});

check("⑦ 조각은 아무것도 그리지 않고, 서버에서 그려도 터지지 않는다", () => {
  // node 에는 document 가 아예 없다. 그리는 동안 그것을 만지는 코드가 한 줄이라도
  // 있으면 이 검사가 바로 빨개진다.
  assert.equal(typeof globalThis.document, "undefined", "이 검사의 전제가 깨졌다");
  assert.equal(renderToStaticMarkup(React.createElement(HeaderMenuDismiss)), "");
});

/* ------------------------------------------------------------------ */

/**
 * src 아래의 소스 파일 전부(절대 경로).
 *
 * 🔴 `new URL(…)` 로 폴더를 이어 붙이지 않는다 — 이 저장소에는 `(internal)`·`[id]` 같은
 *    폴더가 있어 괄호·대괄호가 퍼센트로 둔갑하면 **읽기가 조용히 실패한다**. 경로는
 *    문자열로 잇는다.
 * 🔵 `readdirSync` 의 recursive 옵션도 쓰지 않는다 — Node 판에 따라 없다(개발 24 ·
 *    운영 22). 손으로 내려간다.
 */
function srcFiles(dir = join(fileURLToPath(new URL("../", import.meta.url)), "src")): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...srcFiles(child));
    else if (/\.(tsx?|css)$/.test(entry.name)) out.push(child);
  }
  return out;
}

console.log(`\n${passed}개 통과`);
