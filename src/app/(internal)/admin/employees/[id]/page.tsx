import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  addAdjustmentAction,
  deleteAdjustmentAction,
  deleteEmployeeAction,
  setRoleAction,
  unlinkUserAction,
  updateEmployeeAction,
} from "@/app/actions/admin";
import { adminCancelAction, skipStepAction } from "@/app/actions/leave";
import { ActionForm } from "@/components/ActionForm";
import { KindBadge, StatusBadge, TypeChip } from "@/components/badges";
import { DoneBanner } from "@/components/DoneBanner";
import { canSeeReason, requireAdmin } from "@/lib/auth/guards";
import { formatDay, formatRange, formatTenure, todayKst, yearOf } from "@/lib/dates";
import { db } from "@/lib/db";
import { webEmployees, webLeaveAdjustments, webUsers } from "@/lib/db/schema";
import { isUuid } from "@/lib/ids";
import {
  getBalance,
  loadHolidaySet,
  loadLedgerInput,
  loadRanks,
  loadRules,
  requestsOfEmployee,
} from "@/lib/leave/data";
import { formatDays, stepLabel } from "@/lib/leave/labels";
import { allocate, annualEntitlement, leaveYearOf, monthlyInfo, tenureOn } from "@/lib/leave/rules";

const input =
  "rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none";

const ENT_NOTE = {
  OK: "",
  NOT_HIRED: "입사 전",
  UNDER_ONE_YEAR: "입사한 해 → 월차",
  NO_RULE: "근속 표에 없음",
} as const;

export default async function EmployeeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  if (!isUuid(id)) notFound();

  const [employee] = await db
    .select()
    .from(webEmployees)
    .where(and(eq(webEmployees.id, id), eq(webEmployees.isDeleted, false)))
    .limit(1);
  if (!employee) notFound();

  const today = todayKst();
  // 연차 연도 = 입사 기념일에 시작하는 1년. 사람마다 다르다
  const thisYear = leaveYearOf(employee.hireDate, today);
  const [ranks, holidays, rules, adjustments, accounts, requests] = await Promise.all([
    loadRanks(),
    loadHolidaySet(),
    loadRules(),
    db
      .select()
      .from(webLeaveAdjustments)
      .where(and(eq(webLeaveAdjustments.employeeId, id), eq(webLeaveAdjustments.isDeleted, false)))
      .orderBy(desc(webLeaveAdjustments.createdAt)),
    db.select().from(webUsers).where(and(eq(webUsers.employeeId, id), eq(webUsers.isDeleted, false))),
    requestsOfEmployee(id),
  ]);

  const balance = await getBalance(employee, { holidays, rules });
  const ledger = await loadLedgerInput(employee, holidays, rules);
  const alloc = allocate(ledger);
  const tenure = tenureOn(employee.hireDate, today);
  const monthly = monthlyInfo(employee.hireDate);
  const showMonthly = monthly.validUntil >= `${thisYear - 1}-01-01`;

  const firstYear = Math.max(yearOf(employee.hireDate), thisYear - 3);
  const years: number[] = [];
  for (let y = firstYear; y <= thisYear + 1; y += 1) years.push(y);

  return (
    <div className="space-y-6">
      <DoneBanner code={sp.done} />
      <div className="flex flex-wrap items-baseline gap-3">
        <Link href="/admin/employees" className="text-sm text-slate-500 hover:text-slate-900">
          ← 직원 관리
        </Link>
        <h1 className="text-xl font-semibold text-slate-900">{employee.name}</h1>
        <span className="text-sm text-slate-500">
          입사 {employee.hireDate} · 근속 {formatTenure(tenure.months)}
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-800">기본 정보</h2>
          <ActionForm action={updateEmployeeAction} className="grid grid-cols-2 gap-3">
            <input type="hidden" name="id" value={employee.id} />
            <label className="text-xs text-slate-600">
              이름
              <input name="name" required defaultValue={employee.name} className={`mt-1 block w-full ${input}`} />
            </label>
            <label className="text-xs text-slate-600">
              직급
              <select name="rankId" defaultValue={employee.rankId} className={`mt-1 block w-full ${input}`}>
                {ranks.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-600">
              입사일
              <input
                name="hireDate"
                type="date"
                required
                defaultValue={employee.hireDate}
                className={`mt-1 block w-full ${input}`}
              />
              <span className="mt-1 block text-[11px] text-slate-400">
                연차 연도가 시작되는 날입니다. 고치면 지난 연도의 기간과 일수도 함께 다시 계산됩니다.
              </span>
            </label>
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700">
              <input name="isActive" type="checkbox" defaultChecked={employee.isActive} />
              재직 중
            </label>
            <label className="col-span-2 text-xs text-slate-600">
              메모
              <input name="note" defaultValue={employee.note ?? ""} className={`mt-1 block w-full ${input}`} />
            </label>
            <div className="col-span-2">
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
              >
                저장
              </button>
            </div>
          </ActionForm>
          {requests.length === 0 && (
            <ActionForm
              action={deleteEmployeeAction}
              confirm={`${employee.name} 님을 명단에서 지울까요? (잘못 등록한 경우에만)`}
              className="mt-3 border-t border-slate-100 pt-3"
            >
              <input type="hidden" name="id" value={employee.id} />
              <button type="submit" className="text-xs text-red-700 underline-offset-2 hover:underline">
                잘못 등록한 직원 지우기
              </button>
            </ActionForm>
          )}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-800">로그인 계정</h2>
          {accounts.length === 0 ? (
            <p className="text-sm text-slate-400">
              연결된 계정이 없습니다. 이 사람이 처음 로그인하면 직원 관리 화면 위쪽 &lsquo;확인 대기 계정&rsquo;에 나타납니다.
            </p>
          ) : (
            <ul className="space-y-3">
              {accounts.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-slate-900">{u.displayName}</span>
                  <span className="text-xs text-slate-400">
                    {u.lastLoginAt
                      ? `마지막 로그인 ${u.lastLoginAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`
                      : ""}
                  </span>
                  <ActionForm action={setRoleAction} className="flex items-center gap-2">
                    <input type="hidden" name="userId" value={u.id} />
                    <input type="hidden" name="role" value={u.role === "LEAVE_ADMIN" ? "MEMBER" : "LEAVE_ADMIN"} />
                    <button
                      type="submit"
                      className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
                    >
                      {u.role === "LEAVE_ADMIN" ? "휴가 관리자에서 빼기" : "휴가 관리자로 지정"}
                    </button>
                  </ActionForm>
                  <ActionForm action={unlinkUserAction} confirm="이 계정과 명단의 연결을 풀까요?">
                    <input type="hidden" name="userId" value={u.id} />
                    <button type="submit" className="text-xs text-slate-500 underline-offset-2 hover:underline">
                      연결 풀기
                    </button>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-xs text-slate-500">
            누가 결재하는지는 계정도 직급도 아닌 <b>결재선</b>이 정합니다 (휴가 설정 → 승인 절차). 직급의 결재권
            ({ranks.filter((r) => r.canApprove).map((r) => r.name).join("·") || "없음"})은 휴가 사유를 볼 수 있는
            범위와 머리말의 「결재함」 메뉴에만 쓰입니다.
          </p>
        </section>
      </div>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">연차 계산 내역</h2>
        <p className="mb-3 mt-0.5 text-xs text-slate-500">
          사람마다 **자기 입사 기념일**에 그해 연차를 받습니다. 그날까지 채운 만 근속(만 12개월 = 1년)으로 근속 표를 찾고, 남은 연차는 다음 기념일 전날에 사라집니다.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr className="border-b border-slate-200">
                <th className="py-2 pr-3 font-medium">연차 연도 (입사 기념일 기준)</th>
                <th className="py-2 pr-3 font-medium">받는 날 근속</th>
                <th className="py-2 pr-3 text-right font-medium">근속 표</th>
                <th className="py-2 pr-3 text-right font-medium">조정</th>
                <th className="py-2 pr-3 text-right font-medium">합계</th>
                <th className="py-2 pr-3 text-right font-medium">사용·대기</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {years.map((y) => {
                const ent = annualEntitlement(employee.hireDate, y, rules);
                const adj = ledger.annualAdjust.get(y) ?? 0;
                const use = alloc.annual.get(y);
                return (
                  <tr key={y} className={y === thisYear ? "bg-sky-50/60" : ""}>
                    <td className="py-2 pr-3 font-medium">
                      {y}년
                      <span className="ml-1.5 text-xs font-normal text-slate-400 tabular">
                        {ent.start} ~ {ent.end}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-slate-600">
                      {ent.status === "NOT_HIRED" ? "-" : formatTenure(ent.tenureMonths)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular">
                      {ent.status === "OK" ? (
                        <>
                          <span className="mr-1 text-xs text-slate-400">
                            {ent.rule?.fromYear}~{ent.rule?.toYear}년차
                          </span>
                          {formatDays(ent.baseDays)}
                        </>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular">{adj ? `${adj > 0 ? "+" : ""}${formatDays(adj)}` : "-"}</td>
                    <td className="py-2 pr-3 text-right font-semibold tabular">{formatDays(ent.baseDays + adj)}</td>
                    <td className="py-2 pr-3 text-right tabular text-slate-600">
                      {use ? `${formatDays(use.used)}${use.pending ? ` + ${formatDays(use.pending)}` : ""}` : "-"}
                    </td>
                    <td className={`py-2 text-xs ${ent.status === "NO_RULE" ? "text-red-700" : "text-slate-500"}`}>
                      {ENT_NOTE[ent.status]}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {showMonthly && (
          <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm">
            <p className="font-medium text-slate-800">
              입사 1년 미만 월차 · {formatDay(monthly.validUntil, true)}까지 사용 (해가 바뀌어도 유지)
            </p>
            <p className="mt-1 text-xs text-slate-500">
              한 달을 채울 때마다 1일:{" "}
              {monthly.accrualDates.map((d) => (
                <span key={d} className={`mr-1.5 tabular ${d <= today ? "text-slate-800" : "text-slate-400"}`}>
                  {d.slice(5)}
                </span>
              ))}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              생긴 {formatDays(balance.monthly?.accrued ?? monthly.accrualDates.filter((d) => d <= today).length)}
              {ledger.monthlyAdjust ? ` · 조정 ${formatDays(ledger.monthlyAdjust)}` : ""} · 사용 {formatDays(alloc.monthly.used)}
              {alloc.monthly.pending ? ` · 결재 대기 ${formatDays(alloc.monthly.pending)}` : ""}
            </p>
          </div>
        )}
        {alloc.shortTotal > 0 && (
          <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            받은 일수보다 {formatDays(alloc.shortTotal)} 더 신청되어 있습니다. 조정하거나 휴가를 정정하세요.
          </p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">일수 조정</h2>
        <p className="mb-3 mt-0.5 text-xs text-slate-500">
          자동 계산이 맞지 않을 때 더하거나 뺍니다. 예: 결근으로 월차 -1, 입사 첫해 비례분 +3. 기록이 남습니다.
        </p>
        <ActionForm action={addAdjustmentAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="employeeId" value={employee.id} />
          <label className="text-xs text-slate-600">
            어디에
            <select name="bucket" defaultValue="ANNUAL" className={`mt-1 block ${input}`}>
              <option value="ANNUAL">연차</option>
              <option value="MONTHLY">월차 (1년 미만)</option>
            </select>
          </label>
          <label className="text-xs text-slate-600">
            연차 연도 (연차만)
            <input name="year" type="number" defaultValue={thisYear} className={`mt-1 block w-24 ${input}`} />
            <span className="mt-1 block text-[11px] text-slate-400">
              {thisYear}년 = {balance.annual.entitlement.start} ~ {balance.annual.entitlement.end}
            </span>
          </label>
          <label className="text-xs text-slate-600">
            일수 (빼려면 -)
            <input name="days" type="number" step="0.5" required className={`mt-1 block w-24 ${input}`} />
          </label>
          <label className="text-xs text-slate-600">
            사유
            <input name="reason" required maxLength={300} className={`mt-1 block w-64 ${input}`} />
          </label>
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            조정
          </button>
        </ActionForm>

        {adjustments.length > 0 && (
          <ul className="mt-4 divide-y divide-slate-100 text-sm">
            {adjustments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="w-28 text-slate-600">{a.bucket === "ANNUAL" ? `${a.year}년 연차` : "월차"}</span>
                <span className="w-16 text-right font-semibold tabular">
                  {a.days > 0 ? "+" : ""}
                  {formatDays(a.days)}
                </span>
                <span className="flex-1 text-slate-700">{a.reason}</span>
                <span className="text-xs text-slate-400">
                  {a.createdAt.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}
                </span>
                <ActionForm action={deleteAdjustmentAction} confirm="이 조정을 지울까요?">
                  <input type="hidden" name="id" value={a.id} />
                  <button type="submit" className="text-xs text-red-700 underline-offset-2 hover:underline">
                    지우기
                  </button>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">휴가 기록</h2>
        <p className="mb-3 mt-0.5 text-xs text-slate-500">
          잘못 들어간 휴가는 여기서 취소 처리합니다. 사유는 결재권자에게만 보입니다.
        </p>
        {requests.length === 0 ? (
          <p className="text-sm text-slate-400">기록이 없습니다.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <TypeChip type={r.leaveType} />
                <KindBadge kind={r.kind} />
                <span className="text-slate-800">{formatRange(r.startDate, r.endDate, true)}</span>
                <span className="text-slate-500">{formatDays(r.days)}</span>
                <StatusBadge status={r.status} />
                {r.reason && canSeeReason(viewer, r.employeeId) && (
                  <span className="text-xs text-slate-500">사유: {r.reason}</span>
                )}
                {r.statusNote && <span className="text-xs text-slate-400">{r.statusNote}</span>}
                {r.kind !== "CANCEL" && (r.status === "APPROVED" || r.status === "PENDING") && (
                  <ActionForm
                    action={adminCancelAction}
                    confirm="이 휴가를 관리자 정정으로 취소할까요? 결재 없이 바로 취소됩니다."
                    className="ml-auto flex items-center gap-2"
                  >
                    <input type="hidden" name="requestId" value={r.id} />
                    <input type="hidden" name="back" value={`/admin/employees/${employee.id}`} />
                    <input
                      name="reason"
                      required
                      maxLength={300}
                      placeholder="정정 사유"
                      className="w-40 rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-slate-500 focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50"
                    >
                      취소 처리
                    </button>
                  </ActionForm>
                )}
                {/*
                  🔴 막힌 결재를 푸는 유일한 출구다 (2026-09-21 사용자 결정).
                  결재선이 직급이던 때에는 같은 직급의 다른 사람이 대신 결재할 수
                  있었는데, 사람으로 고정하면서 그 안전망이 사라졌다 — 결재자가
                  퇴사하면 그 신청은 영영 대기로 남는다. 승인이 아니라 '건너뜀'이고
                  누가 왜 건너뛰었는지 감사 로그에 남는다.
                */}
                {r.status === "PENDING" && r.steps.some((s) => s.status === "PENDING") && (
                  <div className="basis-full pt-1">
                    <p className="text-[11px] text-slate-500">
                      아래 사람의 차례에서 멈춰 있습니다. 결재는 <b>한 명씩 차례로</b> 가기 때문에 이 사람이
                      막히면 뒷사람은 시작조차 못 합니다 — 퇴사했거나 오래 자리를 비웠다면 그 단계를 건너뛰세요.
                      건너뛰면 그 자리에서 다음 사람이 깨어납니다 (승인이 아니라 건너뜀으로 기록됩니다).
                    </p>
                    <div className="mt-1 flex flex-col gap-1">
                      {r.steps
                        .filter((s) => s.status === "PENDING")
                        .map((s) => (
                          <ActionForm
                            key={s.id}
                            action={skipStepAction}
                            confirm={`${stepLabel(s)} 단계를 건너뛸까요? 승인이 아니라 건너뜀으로 남습니다.`}
                            className="flex flex-wrap items-center gap-2"
                          >
                            <input type="hidden" name="stepId" value={s.id} />
                            <input
                              type="hidden"
                              name="back"
                              value={`/admin/employees/${employee.id}`}
                            />
                            <span className="w-20 text-xs text-slate-600">{stepLabel(s)}</span>
                            <input
                              name="reason"
                              required
                              maxLength={300}
                              placeholder="건너뛰는 사유 (예: 퇴사)"
                              className="w-48 rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-slate-500 focus:outline-none"
                            />
                            <button
                              type="submit"
                              className="rounded-md border border-amber-300 px-2.5 py-1 text-xs text-amber-800 hover:bg-amber-50"
                            >
                              건너뛰기
                            </button>
                          </ActionForm>
                        ))}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
