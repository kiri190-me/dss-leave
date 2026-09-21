import Link from "next/link";

import { PrintButton } from "@/components/PrintButton";
import { requireMember } from "@/lib/auth/guards";
import { TIMEZONE, formatRange, formatTenure, todayKst, yearOf } from "@/lib/dates";
import {
  getBalance,
  loadHolidaySet,
  requestsInWindow,
  type RequestView,
} from "@/lib/leave/data";
import { LEAVE_TYPE_INFO, STATUS_LABEL, formatDays, stepLabel } from "@/lib/leave/labels";
import { leaveYearOf, leaveYearWindow, tenureOn, workdaysBetween } from "@/lib/leave/rules";

/** 인쇄에 넣는 상태. 기본은 승인·결재 중, '모두'면 반려·취소·거둬들임·변경 전 기록까지 */
const DEFAULT_STATUSES = new Set(["APPROVED", "PENDING"]);

/**
 * 그 휴가 중 이 연차 연도에 든 날수.
 * 연차 연도가 입사 기념일에 바뀌므로, 기념일에 걸친 휴가는 두 해로 나뉘어 들어간다.
 * (차감도 rules.ts 의 allocate 가 날짜별로 나눠 뺀다)
 */
function daysInPeriod(
  r: RequestView,
  from: string,
  to: string,
  holidays: ReadonlySet<string>,
): number {
  if (LEAVE_TYPE_INFO[r.leaveType].halfDay) {
    return r.startDate >= from && r.startDate <= to ? 0.5 : 0;
  }
  const start = r.startDate < from ? from : r.startDate;
  const end = r.endDate > to ? to : r.endDate;
  if (start > end) return 0;
  return workdaysBetween(start, end, holidays).length;
}

function shortDate(d: Date | null): string {
  if (!d) return "";
  return new Intl.DateTimeFormat("ko-KR", { timeZone: TIMEZONE, month: "numeric", day: "numeric" }).format(d);
}

/** 내 휴가 사용 내역 — A4 한 장에 맞춘 인쇄 화면 */
export default async function PrintMyLeavePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requireMember();
  const sp = await searchParams;
  const today = todayKst();
  // 연차 연도는 사람마다 다르다 — 입사 기념일에 시작해 다음 기념일 전날에 끝난다
  const hireDate = member.employee.hireDate;
  const hireYear = yearOf(hireDate);
  const thisYear = leaveYearOf(hireDate, today);

  const yearParam = typeof sp.year === "string" ? Number(sp.year) : NaN;
  const year =
    Number.isInteger(yearParam) && yearParam >= hireYear && yearParam <= thisYear + 1 ? yearParam : thisYear;
  const showAll = sp.all === "1";
  const period = leaveYearWindow(hireDate, year);

  // 이번 연도는 오늘 기준, 지난 연도는 그 연도 마지막 날 기준 잔여
  const asOf = year === thisYear ? today : year < thisYear ? period.end : period.start;
  const [balance, all, holidays] = await Promise.all([
    getBalance(member.employee, undefined, asOf),
    requestsInWindow(member.employee.id, period.start, period.end),
    loadHolidaySet(),
  ]);
  const rows = (showAll ? all : all.filter((r) => DEFAULT_STATUSES.has(r.status))).map((r) => ({
    r,
    inPeriod: daysInPeriod(r, period.start, period.end, holidays),
  }));
  const approvedDeducted = rows
    .filter(({ r }) => r.status === "APPROVED" && r.deducts)
    .reduce((sum, { inPeriod }) => Math.round((sum + inPeriod) * 10) / 10, 0);

  const years: number[] = [];
  for (let y = thisYear + 1; y >= hireYear && y >= thisYear - 4; y -= 1) years.push(y);
  const query = (y: number, a: boolean) => `/leave/print?year=${y}${a ? "&all=1" : ""}`;

  const ent = balance.annual.entitlement;

  return (
    <div className="space-y-4">
      {/* 화면에서만 보이는 조작 줄 */}
      <div className="no-print flex flex-wrap items-center gap-2">
        <Link href="/leave" className="text-sm text-slate-500 hover:text-slate-900">
          ← 내 휴가
        </Link>
        <span className="ml-2 text-sm text-slate-500">연차 연도</span>
        {years.map((y) => (
          <Link
            key={y}
            href={query(y, showAll)}
            className={
              y === year
                ? "rounded-md bg-slate-900 px-2.5 py-1 text-sm text-white"
                : "rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50"
            }
          >
            {y}
          </Link>
        ))}
        <Link
          href={query(year, !showAll)}
          className="ml-2 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50"
        >
          {showAll ? "✓ 반려·취소 기록 포함" : "반려·취소 기록도 넣기"}
        </Link>
        <span className="ml-auto">
          <PrintButton />
        </span>
      </div>

      {/* 종이에 찍히는 부분 */}
      <article className="print-sheet mx-auto max-w-[210mm] rounded-lg border border-slate-200 bg-white p-8 text-slate-900">
        <header className="flex items-end justify-between border-b-2 border-slate-900 pb-3">
          <div>
            <p className="text-xs text-slate-500">DSS</p>
            <h1 className="text-2xl font-bold tracking-tight">휴가 사용 내역 · {year}년 연차</h1>
            <p className="mt-0.5 text-xs text-slate-500">
              {period.start} ~ {period.end} (입사일 기준)
            </p>
          </div>
          <p className="text-xs text-slate-500">출력일 {today}</p>
        </header>

        <table className="mt-4 w-full border-collapse text-sm">
          <tbody>
            <tr>
              <th className="w-20 border border-slate-300 bg-slate-50 px-2 py-1.5 text-left font-medium">이름</th>
              <td className="border border-slate-300 px-2 py-1.5">{member.employee.name}</td>
              <th className="w-20 border border-slate-300 bg-slate-50 px-2 py-1.5 text-left font-medium">직급</th>
              <td className="border border-slate-300 px-2 py-1.5">{member.employee.rank.name}</td>
            </tr>
            <tr>
              <th className="border border-slate-300 bg-slate-50 px-2 py-1.5 text-left font-medium">입사일</th>
              <td className="border border-slate-300 px-2 py-1.5">{member.employee.hireDate}</td>
              <th className="border border-slate-300 bg-slate-50 px-2 py-1.5 text-left font-medium">근속</th>
              <td className="border border-slate-300 px-2 py-1.5">
                {formatTenure(tenureOn(member.employee.hireDate, asOf).months)} ({asOf} 기준)
              </td>
            </tr>
          </tbody>
        </table>

        <h2 className="mt-6 text-sm font-semibold">요약 ({asOf} 기준)</h2>
        <table className="mt-2 w-full border-collapse text-sm">
          <thead>
            <tr className="bg-slate-50">
              <th className="border border-slate-300 px-2 py-1.5 text-left font-medium">구분</th>
              <th className="border border-slate-300 px-2 py-1.5 text-right font-medium">받은 일수</th>
              <th className="border border-slate-300 px-2 py-1.5 text-right font-medium">사용</th>
              <th className="border border-slate-300 px-2 py-1.5 text-right font-medium">결재 대기</th>
              <th className="border border-slate-300 px-2 py-1.5 text-right font-medium">남음</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-slate-300 px-2 py-1.5">
                {year}년 연차
                {ent.status === "OK" && (
                  <span className="ml-1 text-xs text-slate-500">
                    (근속 {ent.tenureYears}년 · {ent.rule?.fromYear}~{ent.rule?.toYear}년차
                    {balance.annual.adjust ? ` · 조정 ${balance.annual.adjust > 0 ? "+" : ""}${formatDays(balance.annual.adjust)}` : ""})
                  </span>
                )}
                {(ent.status === "UNDER_ONE_YEAR" || ent.status === "NOT_HIRED") && (
                  <span className="ml-1 text-xs text-slate-500">(입사 1년 미만 — 월차로 받음)</span>
                )}
              </td>
              <td className="border border-slate-300 px-2 py-1.5 text-right tabular">{formatDays(balance.annual.total)}</td>
              <td className="border border-slate-300 px-2 py-1.5 text-right tabular">{formatDays(balance.annual.used)}</td>
              <td className="border border-slate-300 px-2 py-1.5 text-right tabular">{formatDays(balance.annual.pending)}</td>
              <td className="border border-slate-300 px-2 py-1.5 text-right font-semibold tabular">
                {formatDays(balance.annual.remaining)}
              </td>
            </tr>
            {balance.monthly && (
              <tr>
                <td className="border border-slate-300 px-2 py-1.5">
                  월차 <span className="text-xs text-slate-500">({balance.monthly.info.validUntil}까지 사용)</span>
                </td>
                <td className="border border-slate-300 px-2 py-1.5 text-right tabular">
                  {formatDays(balance.monthly.accrued + balance.monthly.adjust)}
                </td>
                <td className="border border-slate-300 px-2 py-1.5 text-right tabular">{formatDays(balance.monthly.used)}</td>
                <td className="border border-slate-300 px-2 py-1.5 text-right tabular">{formatDays(balance.monthly.pending)}</td>
                <td className="border border-slate-300 px-2 py-1.5 text-right font-semibold tabular">
                  {formatDays(Math.max(0, balance.monthly.remaining))}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <h2 className="mt-6 text-sm font-semibold">
          휴가 내역 {showAll ? "(반려·취소 기록 포함)" : "(승인 · 결재 중)"}
        </h2>
        {rows.length === 0 ? (
          <p className="mt-2 border border-slate-300 px-3 py-6 text-center text-sm text-slate-500">
            이 기간에 휴가 기록이 없습니다.
          </p>
        ) : (
          <table className="mt-2 w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50 text-left">
                <th className="w-8 border border-slate-300 px-1.5 py-1.5 text-center font-medium">번</th>
                <th className="border border-slate-300 px-2 py-1.5 font-medium">종류</th>
                <th className="border border-slate-300 px-2 py-1.5 font-medium">기간</th>
                <th className="border border-slate-300 px-2 py-1.5 text-right font-medium">일수</th>
                <th className="border border-slate-300 px-2 py-1.5 font-medium">상태</th>
                <th className="border border-slate-300 px-2 py-1.5 font-medium">결재</th>
                <th className="border border-slate-300 px-2 py-1.5 font-medium">사유</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ r, inPeriod }, i) => (
                <PrintRow key={r.id} r={r} no={i + 1} inPeriod={inPeriod} />
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} className="border border-slate-300 px-2 py-1.5 text-right font-medium">
                  승인된 휴가 중 연차에서 뺀 일수
                </td>
                <td className="border border-slate-300 px-2 py-1.5 text-right font-semibold tabular">
                  {formatDays(approvedDeducted)}
                </td>
                <td colSpan={3} className="border border-slate-300 px-2 py-1.5 text-xs text-slate-500">
                  경조사·건강검진·예비군 등은 연차에서 빠지지 않습니다
                </td>
              </tr>
            </tfoot>
          </table>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
          * 일수는 주말·공휴일을 뺀 날수이며 반차는 0.5일입니다. 못 쓴 연차는 다음 입사 기념일 전날에 사라지고 넘어가지 않습니다.
          <br />* DSS 휴가 관리 시스템에서 출력했습니다.
        </p>
      </article>
    </div>
  );
}

function PrintRow({ r, no, inPeriod }: { r: RequestView; no: number; inPeriod: number }) {
  const info = LEAVE_TYPE_INFO[r.leaveType];
  return (
    <tr className="align-top">
      <td className="border border-slate-300 px-1.5 py-1.5 text-center tabular">{no}</td>
      <td className="border border-slate-300 px-2 py-1.5 whitespace-nowrap">
        {info.label}
        {r.kind === "CHANGE" && <span className="block text-[11px] text-slate-500">날짜 변경분</span>}
      </td>
      <td className="border border-slate-300 px-2 py-1.5">{formatRange(r.startDate, r.endDate, true)}</td>
      <td className="border border-slate-300 px-2 py-1.5 text-right tabular whitespace-nowrap">
        {formatDays(inPeriod)}
        {inPeriod !== r.days && (
          <span className="block text-[11px] text-slate-500">전체 {formatDays(r.days)} 중</span>
        )}
        {!r.deducts && <span className="block text-[11px] text-slate-500">차감 없음</span>}
      </td>
      <td className="border border-slate-300 px-2 py-1.5 whitespace-nowrap">
        {STATUS_LABEL[r.status]}
        {r.status === "REJECTED" && r.statusNote && (
          <span className="block text-[11px] text-slate-500">{r.statusNote}</span>
        )}
      </td>
      <td className="border border-slate-300 px-2 py-1.5 text-xs">
        {r.steps.length === 0 ? (
          <span className="text-slate-500">결재 없이 등록</span>
        ) : (
          r.steps.map((s) => (
            <span key={s.id} className="mr-2 inline-block whitespace-nowrap">
              {stepLabel(s)}
              {s.decidedByName && s.decidedByName !== stepLabel(s) ? ` ${s.decidedByName}` : ""}{" "}
              {s.status === "APPROVED"
                ? `✓ ${shortDate(s.decidedAt)}`
                : s.status === "REJECTED"
                  ? `✕ ${shortDate(s.decidedAt)}`
                  : s.status === "PENDING"
                    ? "대기"
                    : "-"}
            </span>
          ))
        )}
      </td>
      <td className="border border-slate-300 px-2 py-1.5 text-xs">{r.reason ?? ""}</td>
    </tr>
  );
}
