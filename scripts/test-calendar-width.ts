/**
 * 첫 화면 달력이 폰에서 잘리지 않는가 검사.  npm run test:calendar
 *
 * 🔴 DB 에도 네트워크에도 닿지 않는다. 브라우저도 열지 않는다.
 *
 * ── 2026-10-22, 쓰는 분 요청 ────────────────────────────────────────────
 * 폰에서 **토요일 칸이 화면 밖으로 잘려** 나가고 아래에 가로 막대가 생겼다.
 * 요청은 「가로폭이 줄더라도 잘려 보이지 않도록」이다. 그래서 지켜야 할 것이 셋:
 *   1. 좁은 화면에서는 표에 최소폭이 **안 걸린다** (걸리면 그 폭만큼 잘린다)
 *   2. 넓은 화면(768px 이상)에서는 **예전 그대로** 720px 최소폭이 걸린다
 *   3. 일곱 칸(일~토)이 그대로이고, 칸 안의 글자가 칸 밖으로 나가지 않는다
 * ① ~ ④ 가 그 셋을 못 박는다.
 *
 * ── 🔴 왜 소스 글자로 재는가 ────────────────────────────────────────────
 * 이 저장소에는 jsdom 도, 화면을 그려 재는 검사도 없다. 첫 화면은 서버 컴포넌트라
 * 로그인·DB 없이는 불러 볼 수조차 없다 — test-app-header.ts 가 쓰는 처방을 그대로
 * 쓴다. 다만 **날짜를 주마다 가르는 셈**(calendarWeeks)만은 DB 없이 돌 수 있으므로
 * ② 에서는 진짜로 불러 본다.
 *
 * ── 🔴 주석은 걷어내고 잰다 ─────────────────────────────────────────────
 * 고친 자리에는 까닭이 주석으로 길게 적혀 있고 거기에 클래스 이름도 나온다.
 * 주석이 코드 대신 걸리면 다음 사람이 **까닭이 적힌 주석을 지우는 쪽으로** 움직인다.
 *
 * ── 🔴 이 파일에 가짜 클래스를 적지 마라 ────────────────────────────────
 * Tailwind v4 는 scripts 폴더의 글자까지 긁어 클래스 후보로 삼는다. 대괄호가 든
 * 클래스를 줄여 적거나 없는 값으로 적으면 CSS 가 통째로 깨져 **전 페이지가 500** 이
 * 된다. 그래서 여기 적힌 클래스는 전부 화면에 실제로 쓰이는 온전한 것이고,
 * 「무엇으로 시작하는가」를 볼 때는 아래 MIN_WIDTH 처럼 **토막을 이어** 쓴다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { calendarWeeks } from "../src/lib/dates";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/**
 * 🔴 `new URL(…)` 로 폴더를 이어 붙이지 않는다 — 이 저장소에는 `(internal)` 같은
 *    괄호 폴더가 있어 퍼센트로 둔갑하면 **읽기가 조용히 실패한다.**
 */
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (relative: string): string => readFileSync(join(ROOT, relative), "utf8");

/** 주석을 걷어낸 코드만. */
function codeOnly(source: string): string {
  const out = source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(out.trim().length > 0, "주석을 떼고 나니 아무것도 안 남았다 — 떼는 규칙이 더는 안 맞는다");
  return out;
}

const PAGE = "src/app/(internal)/page.tsx";
const code = codeOnly(read(PAGE));
const layout = codeOnly(read("src/app/(internal)/layout.tsx"));

const count = (needle: string): number => code.split(needle).length - 1;

/** 글자가 나오는 자리(없으면 멈춘다 — 못 찾은 것을 0 으로 흘려보내면 비교가 거짓이 된다). */
function at(needle: string, where: string = code): number {
  const i = where.indexOf(needle);
  assert.ok(i >= 0, `${needle} 를 찾지 못했다 — 모양이 바뀌었으면 검사도 함께 고쳐라`);
  return i;
}

/** 달력 묶음(감싼 상자 ~ 표 끝)만. 위쪽 달 넘기기 줄·오른쪽 기둥은 들어오지 않는다. */
function calendarBlock(): string {
  const start = at('<div className="overflow-x-auto');
  const end = at("</table>");
  assert.ok(end > start, "달력 표가 감싼 상자보다 앞에 있다 — 잘라 내는 규칙을 함께 고쳐라");
  return code.slice(start, end);
}

/** 그 글자를 품은 요소의 className 자리(= className= 부터 그 글자 직전까지). */
function classAttrOf(anchor: string): string {
  const i = at(anchor);
  const j = code.lastIndexOf("className=", i);
  assert.ok(j >= 0 && i - j < 500, `${anchor} 앞에서 className 을 찾지 못했다 — 모양이 바뀌었으면 검사도 함께 고쳐라`);
  return code.slice(j, i);
}

/**
 * 묶음 안의 글자를 낱말로 쪼갠 것.
 * 🔴 `includes` 로 재지 마라 — `p-1` 은 `md:p-1.5` 안에도 들어 있어 **늘 통과한다.**
 */
function tokensIn(where: string): Set<string> {
  return new Set(where.split(/[\s"`{}]+/).filter(Boolean));
}

/** 큰따옴표로 적힌 className 을 낱말로. */
function classesOf(openTag: string, where: string = code): string[] {
  const i = at(openTag, where);
  const m = /className="([^"]*)"/.exec(where.slice(i, i + 300));
  assert.ok(m, `${openTag} 의 className 을 읽지 못했다 — 모양이 바뀌었으면 검사도 함께 고쳐라`);
  return m[1].split(/\s+/).filter(Boolean);
}

/** 🔴 한 토막으로 적지 않는다 — 위 머리말의 「가짜 클래스를 적지 마라」 참조. */
const MIN_WIDTH = `min-w${"-"}`;
/** 클라이언트 지시문. 낱말로 적으면 글자로 세는 검사가 뒤집힌다. */
const CLIENT_DIRECTIVE = '"use client"';

/* ------------------------------------------------------------------ */
/* ① 🔴 좁은 화면에서는 최소폭이 안 걸린다 — 잘리던 그 자리                */
/* ------------------------------------------------------------------ */

const table = classesOf("<table ", calendarBlock());

check("① 표에 **조건 없는** 최소폭이 없다 — 그것이 폰에서 토요일 칸을 잘라 내던 것", () => {
  const 조건없음 = table.filter((c) => !c.includes(":") && c.startsWith(MIN_WIDTH));
  assert.deepEqual(
    조건없음,
    [],
    `표에 늘 걸리는 최소폭이 있다(${조건없음.join(" ")}) — 폰에서 그 폭만큼 잘리고 가로 막대가 생긴다`,
  );
});

check("① 폭이 줄면 칸도 함께 줄어든다 — w-full · table-fixed 가 그 둘을 맡는다", () => {
  assert.ok(table.includes("w-full"), "표가 제 폭을 가진 글자 너비로 눕는다");
  assert.ok(table.includes("table-fixed"), "칸 폭을 글자가 정한다 — 긴 이름 한 칸이 표를 넓혀 다시 잘린다");
});

check("① 🔴 넓은 화면에서는 720px 최소폭이 **그대로** 걸린다", () => {
  assert.ok(
    table.includes("md:min-w-[720px]"),
    "넓은 화면의 최소폭이 사라졌다 — 720px 이 주던 여유는 그대로 둔다는 것이 이 조각의 전제다",
  );
});

check("① 감싼 상자의 가로 밀기를 지우지 않았다 — 1024px 부터 달력 자리가 720px 보다 좁아진다", () => {
  // 오른쪽 기둥(300px)이 서는 구간 이야기다. 폰에서는 최소폭이 안 걸려 넘칠 것이
  // 없으므로 이 클래스가 있어도 막대가 생기지 않는다.
  assert.ok(classesOf('<div className="overflow-x-auto').includes("overflow-x-auto"), "가로로 밀 길이 사라졌다");
  assert.ok(code.includes("lg:grid-cols-[minmax(0,1fr)_300px]"), "오른쪽 기둥이 서는 조건이 바뀌었다 — 위 까닭을 다시 재라");
});

/* ------------------------------------------------------------------ */
/* ② 🔴 일곱 칸이다                                                     */
/* ------------------------------------------------------------------ */

check("② 요일 머리글이 일곱이다 (일~토)", () => {
  const start = at("const WEEK_HEAD = ");
  const line = code.slice(start, code.indexOf("\n", start));
  const 요일 = line.split('"').filter((_, i) => i % 2 === 1);
  assert.deepEqual(요일, ["일", "월", "화", "수", "목", "금", "토"]);
});

check("② 한 주가 **실제로** 일곱 날이다 — 날짜 셈을 불러 본다", () => {
  for (const ym of ["2026-02", "2026-10", "2027-01", "2027-05"]) {
    const weeks = calendarWeeks(ym);
    assert.ok(weeks.length >= 4, `${ym} 의 주 수가 이상하다(${weeks.length})`);
    for (const week of weeks) assert.equal(week.length, 7, `${ym} 에 일곱 날이 아닌 주가 있다`);
  }
});

/* ------------------------------------------------------------------ */
/* ③ 🔴 360px 예산 — 날짜 숫자가 들어가는가                              */
/* ------------------------------------------------------------------ */

/** Tailwind 의 한 칸 = 0.25rem = 4px */
const STEP = 4;
/** 쓰는 분이 찍어 보내 주신 폭. 요즘 폰의 좁은 쪽 끝이다. */
const PHONE = 360;

/** 폰에서 달력이 실제로 받는 폭. 본문 좌우 여백과 상자 테두리를 뺀 값이다. */
function 달력폭(): number {
  const main = classesOf("<main ", layout);
  assert.ok(main.includes("px-4"), `본문 좌우 여백이 바뀌었다(${main.join(" ")}) — 아래 셈을 다시 맞춰라`);
  const 여백 = 4 * STEP; // px-4
  const 테두리 = 1; // 감싼 상자의 border 한 쪽
  return PHONE - 2 * 여백 - 2 * 테두리;
}

check("③ 🔴 예전 최소폭(720px)은 폰 화면보다 **배 이상 넓었다** — 그래서 잘렸다", () => {
  const 폭 = 달력폭();
  assert.equal(폭, 326, "폰에서 달력이 받는 폭 계산이 달라졌다 — 아래 단언들의 전제다");
  const 토요일시작 = Math.floor((6 * 720) / 7);
  assert.ok(
    토요일시작 > 폭,
    `토요일 칸이 ${토요일시작}px 에서 시작하는데 보이는 폭은 ${폭}px 다 — 이 셈이 뒤집히면 이 조각의 까닭이 사라진 것이다`,
  );
});

check("③ 🔴 날짜 동그라미가 폰 칸에 들어간다 — 칸을 밀어내지 않는다", () => {
  const 칸 = Math.floor(달력폭() / 7);
  const 칸선 = 1; // border-r
  const 안쪽여백 = 1 * STEP; // p-1 (좁은 화면)
  const 글자자리 = 칸 - 칸선 - 2 * 안쪽여백;

  const 날짜 = classAttrOf("{Number(d.slice(8))}");
  assert.ok(날짜.includes("h-6 min-w-6"), "날짜 동그라미의 크기 지정이 바뀌었다 — 예산을 다시 재라");
  const 동그라미 = 6 * STEP; // min-w-6

  assert.ok(칸 >= 40, `한 칸이 ${칸}px 밖에 안 된다 — 글자가 들어갈 자리가 아니다`);
  assert.ok(
    글자자리 >= 동그라미,
    `글자 자리 ${글자자리}px 에 날짜 동그라미 ${동그라미}px 가 안 들어간다 — 날짜가 칸을 밀어낸다`,
  );
});

check("③ 🔴 날짜 숫자는 좁은 화면에서도 **안 줄인다** — 칸에서 가장 중요한 정보다", () => {
  const 날짜 = classAttrOf("{Number(d.slice(8))}");
  assert.ok(날짜.includes("text-xs"), "날짜 글자 크기가 바뀌었다");
  assert.ok(!날짜.includes("md:"), "날짜에 화면 폭 조건이 붙었다 — 좁은 화면에서 작아진다는 뜻이다");
  assert.ok(!날짜.includes("hidden"), "날짜가 어떤 폭에서 사라진다");
});

check("③ 요일 머리글도 좁은 화면에서 줄이지 않았다 — 한 글자라 46px 칸에 그냥 들어간다", () => {
  // 🔴 `{w}` 로 짚지 않는다 — `key={w}` 가 className 보다 **앞**에 있어, 거슬러
  //    올라가면 엉뚱하게 표의 className 이 잡힌다(그러면 아래 md 단언이 거짓이 된다).
  const 머리글 = classAttrOf("</th>");
  assert.ok(머리글.includes("text-xs"), "요일 글자 크기가 바뀌었다");
  assert.ok(!머리글.includes("md:"), "요일 머리글에 화면 폭 조건이 붙었다 — 넓은 화면이 달라지지 않는지 다시 봐라");
});

/* ------------------------------------------------------------------ */
/* ④ 🔴 칸 안의 글자가 칸 밖으로 안 나간다                               */
/* ------------------------------------------------------------------ */

check("④ 🔴 「(교산 휴무일)」이 칸 폭에서 잘린다 — 옆 칸 위로 삐져나오던 자리", () => {
  const 교산 = classAttrOf("(교산 휴무일)");
  assert.ok(교산.includes("truncate"), "말줄임이 없다 — 11px 로도 60px 이 넘어 46px 칸 밖으로 나간다");
  assert.ok(교산.includes("max-w-full"), "칸 폭 울타리가 없다 — flex 칸에서는 max-width 가 있어야 줄어든다");
  assert.ok(
    !교산.includes("whitespace-nowrap"),
    "글자 안 꺾기만 걸려 있다 — truncate 가 그것을 이미 품고 있고, 홀로 걸면 빠져나갈 길이 없다",
  );
});

check("④ 공휴일 이름도 같은 처방 그대로다 (예전부터 그랬다)", () => {
  assert.ok(
    code.includes("max-w-full truncate text-[11px] text-red-600"),
    "공휴일 이름의 말줄임이 사라졌다 — 긴 이름이 옆 칸으로 넘친다",
  );
});

check("④ 🔴 휴가 딱지가 칸 밖으로 안 나간다 — 이름은 잘려도 된다(누르면 자세히 나온다)", () => {
  const 딱지 = classAttrOf("{e.employeeName} {TYPE_SHORT");
  assert.ok(딱지.includes("truncate"), "딱지의 말줄임이 사라졌다 — 이름이 칸 밖으로 나간다");
  assert.ok(딱지.includes("block"), "딱지가 칸 폭을 꽉 채우지 않는다");
  assert.ok(code.includes("날짜를 누르면 그날 휴가자를 자세히 볼 수 있습니다"), "잘린 이름을 펴 볼 길의 안내가 사라졌다");
});

check("④ 「+n명 더」도 잘린다 — 폰 칸에서 겨우 들어가는 길이다", () => {
  const 더 = classAttrOf("명 더</span>");
  assert.ok(더.includes("truncate"), "말줄임이 없다");
});

/* ------------------------------------------------------------------ */
/* ⑤ 🔴 넓은 화면은 한 글자도 안 달라진다                                */
/* ------------------------------------------------------------------ */

check("⑤ 🔴 좁은 화면 전용 줄임에는 **md 짝이 반드시** 있다 — 짝이 없으면 넓은 화면이 함께 줄어든 것", () => {
  const 낱말 = tokensIn(calendarBlock());
  for (const [좁게, 되돌림] of [
    ["gap-0.5", "md:gap-1"],
    ["p-1", "md:p-1.5"],
    ["px-1", "md:px-1.5"],
    ["text-[11px]", "md:text-xs"],
  ] as const) {
    assert.ok(낱말.has(좁게), `좁은 화면 값 ${좁게} 가 사라졌다`);
    assert.ok(낱말.has(되돌림), `🔴 ${좁게} 를 되돌리는 ${되돌림} 이 없다 — 넓은 화면이 2026-10-22 이전과 달라진다`);
  }
});

check("⑤ 🔴 달력이 쓰는 화면 폭 조건은 **md 뿐**이고, 그 목록이 이것뿐이다", () => {
  // 🔴 늘어나면 넓은 화면이 그만큼 달라졌다는 뜻이다. 늘릴 때는 그 값이 예전 값과
  //    같은지 눈으로 보고 이 목록도 함께 고쳐라.
  const 조건 = [...tokensIn(calendarBlock())].filter((t) => /^(?:sm|md|lg|xl|2xl):/.test(t)).sort();
  assert.deepEqual(조건, ["md:gap-1", "md:min-w-[720px]", "md:p-1.5", "md:px-1.5", "md:text-xs"]);
});

check("⑤ 넓은 화면 값이 2026-10-22 이전 글자 그대로다", () => {
  assert.ok(
    code.includes('className="flex h-full flex-col gap-0.5 p-1 hover:bg-slate-50 md:gap-1 md:p-1.5"'),
    "🔴 칸 안쪽의 여백·간격이 달라졌다 — md 쪽은 예전 값(gap-1 · p-1.5)이어야 한다",
  );
  assert.ok(
    code.includes("block truncate rounded border px-1 py-0.5 text-[11px] md:px-1.5 md:text-xs"),
    "🔴 딱지의 생김새가 달라졌다 — md 쪽은 예전 값(px-1.5 · text-xs)이어야 한다",
  );
  assert.ok(
    code.includes("h-28 border-b border-r border-slate-100 align-top last:border-r-0"),
    "칸 높이·테두리가 달라졌다 — 이 조각은 폭과 글자 크기만 바꾼다",
  );
});

/* ------------------------------------------------------------------ */
/* ⑥ 🔴 인쇄를 안 깨뜨렸다                                               */
/* ------------------------------------------------------------------ */

check("⑥ 🔴 달력에는 인쇄 단추가 없다 — 인쇄물은 /leave/print 한 장뿐이다", () => {
  assert.ok(!code.includes("PrintButton"), "달력에 인쇄 단추가 생겼다 — 종이 폭에서의 모양을 여기서 함께 정해야 한다");
  assert.ok(read("src/app/(internal)/leave/print/page.tsx").includes("PrintButton"), "인쇄 화면이 옮겨 갔다 — 위 전제를 다시 재라");
});

check("⑥ 🔴 인쇄 CSS 가 최소폭을 되살리지 않는다 — A4 세로는 약 703px 이라 720px 이 걸리면 오른쪽이 잘린다", () => {
  const css = read("src/app/globals.css");
  const printCss = css.slice(at("@media print", css));
  assert.ok(printCss.includes("A4 portrait"), "종이 방향이 바뀌었다 — 달력을 찍을 일이 생기면 폭을 다시 재라");
  assert.ok(!printCss.includes("min-width"), "인쇄에서 최소폭을 다시 건다 — 종이 폭을 넘어 잘린다");
  assert.ok(!calendarBlock().includes("print:"), "달력에 인쇄 전용 조건이 붙었다 — 종이는 폭 그대로 좁은 쪽 규칙을 타게 둔다");
});

/* ------------------------------------------------------------------ */
/* ⑦ 🔴 첫 화면은 서버 컴포넌트 그대로다                                 */
/* ------------------------------------------------------------------ */

check("⑦ 첫 화면에 클라이언트 지시문이 없다 — 경계가 깨지면 검사가 다 통과해도 build 에서만 드러난다", () => {
  assert.equal(count(CLIENT_DIRECTIVE), 0, "첫 화면이 클라이언트 컴포넌트가 됐다");
  assert.equal(count("'use client'"), 0, "따옴표만 바꾼 지시문이 들어왔다");
  for (const bad of ["useState", "useEffect", "onClick"]) {
    assert.equal(count(bad), 0, `첫 화면에 ${bad} 가 생겼다 — 그 순간 파일 전체가 클라이언트로 내려간다`);
  }
});

check("⑦ 달력이 무엇을 보여 주는지는 안 바뀌었다 — 이 조각은 폭과 글자 크기만 손댄다", () => {
  assert.equal(count("const MAX_CHIPS = 4"), 1, "한 칸에 보이는 딱지 수가 바뀌었다");
  assert.equal(count("workdaysBetween("), 1, "휴가를 날짜별로 펴는 셈이 바뀌었다");
  assert.equal(count("calendarEntries("), 1, "달력이 읽어 오는 것이 바뀌었다");
});

/* ------------------------------------------------------------------ */

console.log(`\n${passed}개 통과`);
