import { formatDay } from "@/lib/dates";
import { formatDays } from "@/lib/leave/labels";
import type { Balance } from "@/lib/leave/rules";

/** 남은 휴가 카드. 달력 옆(요약)과 내 휴가 화면(자세히)에서 같이 쓴다 */
export function BalanceCard({
  balance,
  title = "내 남은 휴가",
  detailed = false,
}: {
  balance: Balance;
  title?: string;
  detailed?: boolean;
}) {
  const { annual, monthly, summer } = balance;
  const ent = annual.entitlement;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
        <span className="text-xs text-slate-400" title={`${ent.start} ~ ${ent.end}`}>
          {balance.year}년 연차
        </span>
      </div>

      <p className="mt-2 flex items-baseline gap-1">
        <span className="text-4xl font-bold tracking-tight text-slate-900 tabular">
          {formatDays(balance.available).replace("일", "")}
        </span>
        <span className="text-lg font-medium text-slate-500">일</span>
        <span className="ml-2 text-xs text-slate-400">더 신청할 수 있음</span>
      </p>

      <dl className="mt-3 space-y-2 text-sm">
        <div className="rounded-md bg-slate-50 px-3 py-2">
          <dt className="flex items-center justify-between font-medium text-slate-700">
            <span>연차</span>
            <span className="tabular">{formatDays(annual.remaining)} 남음</span>
          </dt>
          <dd className="mt-0.5 text-xs text-slate-500">
            {ent.status === "UNDER_ONE_YEAR" || ent.status === "NOT_HIRED" ? (
              <>입사 1년 미만 — 1주년까지는 연차 대신 월차로 받습니다{annual.adjust ? ` (조정 ${formatDays(annual.adjust)})` : ""}</>
            ) : (
              <>
                받은 {formatDays(annual.total)} · 사용 {formatDays(annual.used)}
                {annual.pending > 0 && <> · 결재 대기 {formatDays(annual.pending)}</>}
              </>
            )}
          </dd>
          {ent.status === "NO_RULE" && (
            <dd className="mt-1 text-xs text-red-700">
              근속 표에 {ent.tenureYears}년차 일수가 없습니다. 휴가 관리자에게 알려 주세요.
            </dd>
          )}
        </div>

        {/*
          여름휴가 — 🔴 연차 **바로 아래**. 연차와 별개인 제 잔액이라
          위의 「더 신청할 수 있음」(연차+월차)에는 들어가지 않는다.
          기간은 연차와 같아 따로 적지 않고 머리말의 「○○년 연차」를 함께 쓴다.
        */}
        <div className="rounded-md bg-slate-50 px-3 py-2">
          <dt className="flex items-center justify-between font-medium text-slate-700">
            <span>여름휴가</span>
            <span className="tabular">{formatDays(Math.max(0, summer.remaining))} 남음</span>
          </dt>
          <dd className="mt-0.5 text-xs text-slate-500">
            받은 {formatDays(summer.total)} · 사용 {formatDays(summer.used)}
            {summer.pending > 0 && <> · 결재 대기 {formatDays(summer.pending)}</>}
          </dd>
          <dd className="mt-0.5 text-xs text-slate-500">연차와 따로 셉니다 (연차를 깎지 않습니다).</dd>
          {detailed && (
            <dd className="mt-0.5 text-xs text-slate-500">
              못 쓴 여름휴가는 연차와 같이 {formatDay(ent.end, true)}에 사라지고 넘어가지 않습니다.
            </dd>
          )}
        </div>

        {monthly && (
          <div className="rounded-md bg-slate-50 px-3 py-2">
            <dt className="flex items-center justify-between font-medium text-slate-700">
              <span>월차 (입사 1년 미만)</span>
              <span className="tabular">{formatDays(Math.max(0, monthly.remaining))} 남음</span>
            </dt>
            <dd className="mt-0.5 text-xs text-slate-500">
              지금까지 생긴 {formatDays(monthly.accrued + monthly.adjust)} · 사용 {formatDays(monthly.used)}
              {monthly.pending > 0 && <> · 결재 대기 {formatDays(monthly.pending)}</>}
            </dd>
            <dd className="mt-0.5 text-xs text-slate-500">
              {formatDay(monthly.info.validUntil, true)}까지 사용
              {monthly.nextAccrual && <> · 다음 1일은 {formatDay(monthly.nextAccrual)}에 생김</>}
            </dd>
          </div>
        )}
      </dl>

      {balance.shortTotal > 0 && (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          남은 휴가보다 {formatDays(balance.shortTotal)} 더 신청되어 있습니다. 휴가 관리자에게 확인을 요청하세요.
        </p>
      )}

      {detailed && ent.status === "OK" && (
        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          입사 기념일 {formatDay(ent.start, true)} 기준 근속 {ent.tenureYears}년 → 근속 표{" "}
          {ent.rule?.fromYear}~{ent.rule?.toYear}년차 {formatDays(ent.baseDays)}
          {annual.adjust !== 0 && <> + 관리자 조정 {annual.adjust > 0 ? "+" : ""}{formatDays(annual.adjust)}</>}
          . 못 쓴 연차는 {formatDay(ent.end, true)}에 사라지고 넘어가지 않습니다.
        </p>
      )}
    </section>
  );
}
