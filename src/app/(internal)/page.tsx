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

        {/*
          🔴 2026-10-22, 쓰는 분 요청: 폰에서 **토요일 칸이 화면 밖으로 잘렸다.**
          「가로폭이 줄더라도 잘려 보이지 않도록」이 요청이라, 최소폭을 768px 이상
          에서만 건다. 넓은 화면은 예전 그대로이고(아래 md 조건), 폰에서는 표가
          `w-full` 을 따라 줄어들어 일곱 칸이 다 들어온다.

          🔴 감싼 상자의 `overflow-x-auto` 는 **지우지 않는다.** 1024px 부터는
          오른쪽에 300px 짜리 기둥이 서므로(이 화면 맨 위 grid) 달력 자리가
          720px 보다 좁아지는 구간이 있다 — 그때 가로로 미는 길이 필요하다.
          폰에서는 최소폭이 안 걸리니 넘칠 것이 없어 막대가 생기지 않는다.
        */}
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full table-fixed border-collapse md:min-w-[720px]">
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
                        {/*
                          🔵 폰에서 한 칸은 46px 남짓이다(360px - 본문 좌우 여백
                          32px - 상자 테두리 2px, 그것을 일곱으로 나눈 값). 안쪽
                          여백을 6px 에서 4px 로 줄여 글자 자리를 넓힌다 —
                          768px 부터는 md 쪽이 예전 값을 그대로 되돌린다.
                        */}
                        <Link
                          href={`/?ym=${ym}&date=${d}`}
                          scroll={false}
                          className="flex h-full flex-col gap-0.5 p-1 hover:bg-slate-50 md:gap-1 md:p-1.5"
                        >
                          <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                            {/*
                              🔴 날짜 숫자는 좁은 화면에서도 **줄이지 않는다.** 칸에서 가장
                              중요한 정보다. 동그라미는 24px 고정이라(h-6 min-w-6) 폰 칸의
                              글자 자리 38px 안에 들어간다 — 칸을 밀어내지 않는다.
                              test-calendar-width.ts 의 ③ 이 이 예산을 숫자로 지킨다.
                            */}
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
                              // 🔴 폰에서 이 글자가 칸 밖으로 삐져나오던 자리다. 「(교산 휴무일)」은
                              //    11px 로도 60px 이 넘어 46px 칸에 안 들어가는데, 글자를 안 꺾는
                              //    울타리만 있고 빠져나갈 길이 없어 옆 칸 위에 그대로 덧그려졌다.
                              //    바로 아래 공휴일 이름이 쓰던 처방(칸 폭으로 자르고 말줄임)을
                              //    그대로 쓴다 — truncate 가 글자 안 꺾기를 이미 품고 있으므로
                              //    넓은 화면에서는 자를 것이 없어 예전과 같은 글자가 나온다.
                              //    잘려도 그 칸을 누르면 오른쪽에 일본어 이름까지 다 나온다.
                              <span
                                title={`교산 휴무일: ${jp.ja} (${jp.ko})`}
                                className={`max-w-full truncate text-[11px] font-medium text-red-600 ${inMonth ? "" : "opacity-40"}`}
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
                                e.pending ? ` (결재 중${e.turnLabel ? ` — ${e.turnLabel}` : ""})` : ""
                              }`}
                              className={`block truncate rounded border px-1 py-0.5 text-[11px] md:px-1.5 md:text-xs ${TYPE_CHIP[e.leaveType]} ${
                                e.pending ? "animate-pulse border-dashed" : ""
                              } ${e.isMine ? "font-semibold" : ""}`}
                            >
                              {e.employeeName} {TYPE_SHORT[e.leaveType]}
                              {e.pending && " · 대기"}
                            </span>
                          ))}
                          {list.length > MAX_CHIPS && (
                            // 딱지와 같은 처방. 「+12명 더」는 폰 칸에서도 겨우 들어가는 길이라
                            // 자를 길을 함께 둔다.
                            <span className="truncate text-[11px] text-slate-500 md:text-xs">+{list.length - MAX_CHIPS}명 더</span>
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
          이름이 오른 사람은 직급에 결재권이 없어도 결재를 해야 한다.
          `pendingCount` 는 **내 단계만** 센다(data.ts 의 pendingCountFor).

          (2026-09-22: 머리말의 「결재함」 메뉴도 이제 같은 사람에게 보인다 —
          `canOpenApprovals`. 그래도 이 안내는 남긴다: 저쪽은 들어갈 길이고
          이쪽은 **몇 건 밀려 있는지**를 첫 화면에서 알려 주는 것이다.)
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
                    {/* 한 명씩 차례로 결재하므로 「결재 중」만으로는 누구 차례인지 알 수 없다 */}
                    {e.turnLabel && (
                      <p className="mt-0.5 text-xs text-amber-800">{e.turnLabel}</p>
                    )}
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
      <span className={`rounded border px-1.5 py-0.5 ${TYPE_CHIP.SUMMER}`}>여름휴가</span>
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
