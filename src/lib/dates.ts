/**
 * 날짜 도우미. 날짜는 전부 'YYYY-MM-DD' 글자로 다룬다.
 *
 * Date 객체를 그대로 쓰면 서버의 시간대(NAS 컨테이너는 UTC 일 수 있다)에 따라
 * 하루씩 밀린다. 계산할 때만 UTC 자정으로 바꿨다가 곧바로 글자로 되돌린다.
 */

export const TIMEZONE = "Asia/Seoul";

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const YM = /^(\d{4})-(\d{2})$/;

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toUtc(day: string): Date {
  const m = YMD.exec(day);
  if (!m) throw new Error(`날짜 형식이 아닙니다: ${day}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function fromUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 한국 시간 기준 오늘 */
export function todayKst(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 달력에 실제로 있는 날짜인가 (2027-02-30 같은 값을 거른다) */
export function isYmd(value: string): boolean {
  const m = YMD.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function isYm(value: string): boolean {
  const m = YM.exec(value);
  if (!m) return false;
  const mo = Number(m[2]);
  return Number(m[1]) >= 2000 && Number(m[1]) <= 2100 && mo >= 1 && mo <= 12;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(day: string, n: number): string {
  const d = toUtc(day);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

/**
 * n 개월 뒤. 그 달에 같은 날이 없으면 말일로 맞춘다.
 * 예: 1월 31일 + 1개월 → 2월 28일(윤년 29일)
 */
export function addMonths(day: string, n: number): string {
  const m = YMD.exec(day);
  if (!m) throw new Error(`날짜 형식이 아닙니다: ${day}`);
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  const y = Math.floor(total / 12);
  const mo = (total % 12) + 1;
  const d = Math.min(Number(m[3]), daysInMonth(y, mo));
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** from 부터 to 까지 채운 개월 수 (만). to 가 더 이르면 0 */
export function fullMonths(from: string, to: string): number {
  if (to < from) return 0;
  const a = YMD.exec(from)!;
  const b = YMD.exec(to)!;
  let months =
    (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2]));
  if (addMonths(from, months) > to) months -= 1;
  return Math.max(0, months);
}

/** 0 = 일요일 … 6 = 토요일 */
export function dayOfWeek(day: string): number {
  return toUtc(day).getUTCDay();
}

export function isWeekend(day: string): boolean {
  const w = dayOfWeek(day);
  return w === 0 || w === 6;
}

/** start 부터 end 까지 모든 날짜 (양 끝 포함) */
export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export function yearOf(day: string): number {
  return Number(day.slice(0, 4));
}

export function ymOf(day: string): string {
  return day.slice(0, 7);
}

export function monthStart(ym: string): string {
  return `${ym}-01`;
}

export function monthEnd(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${pad(daysInMonth(y, m))}`;
}

export function shiftYm(ym: string, n: number): string {
  return addMonths(`${ym}-01`, n).slice(0, 7);
}

/** 달력 칸: 그 달을 덮는 일요일 시작 주 단위 날짜들 */
export function calendarWeeks(ym: string): string[][] {
  const first = monthStart(ym);
  const last = monthEnd(ym);
  const start = addDays(first, -dayOfWeek(first));
  const end = addDays(last, 6 - dayOfWeek(last));
  const all = eachDay(start, end);
  const weeks: string[][] = [];
  for (let i = 0; i < all.length; i += 7) weeks.push(all.slice(i, i + 7));
  return weeks;
}

export function weekdayLabel(day: string): string {
  return WEEKDAYS[dayOfWeek(day)];
}

/** 2027-05-03 → 5월 3일 (월) */
export function formatDay(day: string, withYear = false): string {
  const [y, m, d] = day.split("-").map(Number);
  const base = `${m}월 ${d}일 (${weekdayLabel(day)})`;
  return withYear ? `${y}년 ${base}` : base;
}

/** 기간 표시. 같은 날이면 하루만 */
export function formatRange(start: string, end: string, withYear = false): string {
  if (start === end) return formatDay(start, withYear);
  return `${formatDay(start, withYear)} ~ ${formatDay(end, withYear && yearOf(start) !== yearOf(end))}`;
}

/**
 * 한 **시각**(timestamptz)을 한국 시간으로 — "5월 3일 (월) 09:00".
 *
 * 🔴 이 파일의 다른 함수들과 다루는 것이 다르다. 나머지는 'YYYY-MM-DD' **글자**를
 * 다루지만 이것은 DB 의 `timestamp with time zone` 에서 온 `Date` 를 받는다 —
 * 결재권 위임의 기간처럼 **시·분까지** 뜻이 있는 값이 그 꼴이다.
 *
 * 🔴 `at.toLocaleString("ko-KR")` 을 시간대 없이 부르면 **NAS 컨테이너(UTC)에서
 * 아홉 시간 어긋난다.** 개발 PC(KST)에서는 맞게 나오므로 눈으로는 영영 안
 * 드러나고, 「09:00 부터인데 00:00 로 적혀 있다」로만 나타난다.
 *
 * 🔴 시각은 `hourCycle: "h23"` 이다. `hour12: false` 로 적으면 ICU 판에 따라
 * 자정이 **24:00** 으로 나온다 — 같은 날 맨 앞을 「다음 날」처럼 읽게 만든다.
 */
const KST_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatKstTime(at: Date): string {
  return KST_TIME.format(at);
}

export function formatKstDateTime(at: Date, withYear = false): string {
  // todayKst 는 「그 시각의 한국 날짜」를 'YYYY-MM-DD' 로 준다 — 날짜 쪽 시간대
  // 변환이 이미 한 곳에 있으므로 여기서 다시 세지 않는다.
  return `${formatDay(todayKst(at), withYear)} ${formatKstTime(at)}`;
}

/** 2027-05 → 2027년 5월 */
export function formatYm(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${y}년 ${m}월`;
}

/** 만 N년 M개월 */
export function formatTenure(months: number): string {
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m}개월`;
  if (m === 0) return `만 ${y}년`;
  return `만 ${y}년 ${m}개월`;
}
