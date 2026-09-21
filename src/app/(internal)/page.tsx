import Link from "next/link";

import { BalanceCard } from "@/components/BalanceCard";
import { StatusBadge, TypeChip } from "@/components/badges";
import { requireViewer } from "@/lib/auth/guards";
import { japanHolidaysBetween } from "@/lib/jp-holidays";
import {
  calendarWeeks,
  dayOfWeek,
  formatDay,
  formatRange,
  formatYm,
  isYm,
  isYmd,
  shiftYm,
  todayKst,
  ymOf,
} from "@/lib/dates";
import {
  calendarEntries,
  getBalance,
  loadHolidays,
  pendingCountFor,
  type CalendarEntry,
} from "@/lib/leave/data";
import { TYPE_CHIP, TYPE_SHORT, formatDays } from "@/lib/leave/labels";
import { LEAVE_TYPE_INFO, workdaysBetween } from "@/lib/leave/rules";

const WEEK_HEAD = ["일", "월", "화", "수", "목", "금", "토"];
const MAX_CHIPS = 4;

/** 첫 화면: 이번 달 달력 + 내 남은 휴가 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const today = todayKst();
  const ym = typeof sp.ym === "string" && isYm(sp.ym) ? sp.ym : ymOf(today);
  const selected = typeof sp.date === "string" && isYmd(sp.date) ? sp.date : null;

  const weeks = calendarWeeks(ym);
  const from = weeks[0][0];
  const to = weeks[weeks.length - 1][6];

  const [holidays, entries, balance, pendingCount] = await Promise.all([
    loadHolidays(from, to),
    calendarEntries(from, to, viewer),
    viewer.employee ? getBalance(viewer.employee) : Promise.resolve(null),
    pendingCountFor(viewer),
  ]);

  const holidayName = new Map(holidays.map((h) => [h.day, h.name]));
  // 거래처 교산(일본)의 법정 휴일. 표시만 하고 한국 휴가 계산에는 쓰지 않는다
  const kyosan = japanHolidaysBetween(from, to);
  const holidaySet = new Set(holidayName.keys());

  // 휴가를 날짜별로 펼친다. 주말·공휴일에는 표시하지 않는다.
  const byDay = new Map<string, CalendarEntry[]>();
  for (const e of entries) {
    const days = LEAVE_TYPE_INFO[e.leaveType].halfDay
      ? [e.startDate]
      : workdaysBetween(e.startDate < from ? from : e.startDate, e.endDate > to ? to : e.endDate, holidaySet);
    for (const d of days) {
      const list = byDay.get(d) ?? [];
      list.push(e);
      byDay.set(d, list);
    }
  }

  const selectedEntries = selected ? (byDay.get(selected) ?? []) : [];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <section className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h1 className="mr-2 text-xl font-semibold text-slate-900">{formatYm(ym)}</h1>
          <Link
            href={`/?ym=${shiftYm(ym, -1)}`}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50"
            aria-label="이전 달"
          >
            ◀
          </Link>
          <Link
            href={`/?ym=${shiftYm(ym, 1)}`}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50"
            aria-label="다음 달"
          >
            ▶
          </Link>
          {ym !== ymOf(today) && (
            <Link
              href="/"
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50"
            >
              이번 달
            </Link>
          )}
          <Legend />
        </div>

        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full min-w-[720px] table-fixed border-collapse">
            <thead>
              <tr>
                {WEEK_HEAD.map((w, i) => (
                  <th
                    key={w}
                    className={`border-b border-slate-200 py-2 text-xs font-semibold ${
                      i === 0 || i === 6 ? "text-red-600" : "text-slate-500"
                    }`}
                  >
                    {w}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week) => (
                <tr key={week[0]}>
                  {week.map((d) => {
                    const inMonth = ymOf(d) === ym;
                    const holiday = holidayName.get(d);
                    const jp = kyosan.get(d);
                    const dow = dayOfWeek(d);
                    const list = byDay.get(d) ?? [];
                    const isToday = d === today;
                    const isSelected = d === selected;
                    // 빨간날: 주말(토·일)과 공휴일·회사 휴무일 (근로자의 날 등 휴일 목록에 있는 날)
                    const isRedDay = Boolean(holiday) || dow === 0 || dow === 6;
                    return (
                      <td
                        key={d}
                        className={`h-28 border-b border-r border-slate-100 align-top last:border-r-0 ${
                          isSelected
                            ? "bg-sky-50"
                            : !inMonth
                              ? "bg-slate-50/70"
                              : isRedDay
                                ? "bg-red-50/60"
                                : ""
                        }`}
                      >
                        <Link
                          href={`/?ym=${ym}&date=${d}`}
                          scroll={false}
                          className="flex h-full flex-col gap-1 p-1.5 hover:bg-slate-50"
                        >
                          <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                            <span
                              className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-semibold ${
                                isToday
                                  ? "bg-slate-900 text-white"
                                  : isRedDay
                                    ? "text-red-600"
                                    : "text-slate-700"
                              } ${inMonth ? "" : "opacity-40"}`}
                            >
                              {Number(d.slice(8))}
                            </span>
                            {jp && (
                              <span
                                title={`교산 휴무일: ${jp.ja} (${jp.ko})`}
                                className={`whitespace-nowrap text-[11px] font-medium text-red-600 ${inMonth ? "" : "opacity-40"}`}
                              >
                                (교산 휴무일)
                              </span>
                            )}
                            {holiday && (
                              <span className={`max-w-full truncate text-[11px] text-red-600 ${inMonth ? "" : "opacity-40"}`}>
                                {holiday}
                              </span>
                            )}
                          </span>
                          {list.slice(0, MAX_CHIPS).map((e) => (
                            <span
                              key={e.requestId}
                              title={`${e.employeeName} ${e.rankName} · ${LEAVE_TYPE_INFO[e.leaveType].label}${
                                e.pending ? " (결재 대기)" : ""
                              }`}
                              className={`block truncate rounded border px-1.5 py-0.5 text-xs ${TYPE_CHIP[e.leaveType]} ${
                                e.pending ? "animate-pulse border-dashed" : ""
                              } ${e.isMine ? "font-semibold" : ""}`}
                            >
                              {e.employeeName} {TYPE_SHORT[e.leaveType]}
                              {e.pending && " · 대기"}
                            </span>
                          ))}
                          {list.length > MAX_CHIPS && (
                            <span className="text-xs text-slate-500">+{list.length - MAX_CHIPS}명 더</span>
                          )}
                        </Link>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-500">날짜를 누르면 그날 휴가자를 자세히 볼 수 있습니다.</p>
      </section>

      <aside className="space-y-4">
        {viewer.employee && (
          <Link
            href="/leave/new"
            className="block rounded-lg bg-slate-900 px-4 py-3 text-center text-sm font-semibold text-white hover:bg-slate-700"
          >
            + 휴가 신청
          </Link>
        )}

        {/*
          🔴 `viewer.isApprover`(직급의 결재권)를 함께 묻지 않는다. 결재선에
          이름이 오른 사람은 직급에 결재권이 없어도 결재를 해야 하는데, 머리말의
          「결재함」 메뉴는 아직 직급으로 보이고 안 보이고가 갈린다 — 그 사람이
          자기 결재함으로 들어오는 길은 지금 이 안내뿐이다.
          `pendingCount` 는 **내 단계만** 센다(data.ts 의 pendingCountFor).
        */}
        {pendingCount > 0 && (
          <Link
            href="/approvals"
            className="block rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 hover:bg-amber-100"
          >
            결재할 휴가가 <strong>{pendingCount}건</strong> 있습니다 →
          </Link>
        )}

        {selected && (
          <section className="rounded-lg border border-sky-200 bg-white p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-slate-800">{formatDay(selected)}</h2>
              <Link href={`/?ym=${ym}`} scroll={false} className="text-xs text-slate-400 hover:text-slate-700">
                닫기
              </Link>
            </div>
            {holidayName.get(selected) && (
              <p className="mt-1 text-xs text-red-600">{holidayName.get(selected)}</p>
            )}
            {kyosan.get(selected) && (
              <p className="mt-1 text-xs text-red-600">
                교산 휴무일: {kyosan.get(selected)!.ja} ({kyosan.get(selected)!.ko})
              </p>
            )}
            {selectedEntries.length === 0 ? (
              <p className="mt-3 text-sm text-slate-400">휴가자가 없습니다.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {selectedEntries.map((e) => (
                  <li key={e.requestId} className={e.pending ? "opacity-70" : ""}>
                    <div className="flex flex-wrap items-center gap-1.5 text-sm">
                      <span className="font-medium text-slate-900">{e.employeeName}</span>
                      <span className="text-xs text-slate-500">{e.rankName}</span>
                      <TypeChip type={e.leaveType} />
                      <StatusBadge status={e.pending ? "PENDING" : "APPROVED"} />
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {formatRange(e.startDate, e.endDate)} · {formatDays(e.days)}
                      {e.kind === "CHANGE" && " · 날짜 변경분"}
                    </p>
                    {e.reason && <p className="mt-0.5 text-xs text-slate-700">사유: {e.reason}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {balance && <BalanceCard balance={balance} />}
      </aside>
    </div>
  );
}

function Legend() {
  return (
    <div className="ml-auto flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
      <span className={`rounded border px-1.5 py-0.5 ${TYPE_CHIP.ANNUAL}`}>연차</span>
      <span className={`rounded border px-1.5 py-0.5 ${TYPE_CHIP.AM_HALF}`}>반차</span>
      <span className={`rounded border px-1.5 py-0.5 ${TYPE_CHIP.HEALTH_CHECK}`}>건강검진</span>
      <span className={`rounded border px-1.5 py-0.5 ${TYPE_CHIP.CONDOLENCE}`}>경조사</span>
      <span className="animate-pulse rounded border border-dashed border-slate-300 bg-slate-100 px-1.5 py-0.5 text-slate-600">결재 대기</span>
      <span className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-red-600">빨간날 = 주말·공휴일</span>
      <span className="px-0.5">
        <span className="font-medium text-red-600">(교산 휴무일)</span> = 일본 법정 휴일
      </span>
    </div>
  );
}
