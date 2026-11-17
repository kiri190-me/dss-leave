import Link from "next/link";

import {
  createHolidayAction,
  deleteHolidayAction,
  deleteRankAction,
  deleteTenureRuleAction,
  saveLeaveSettingsAction,
  saveRankAction,
  saveTenureRuleAction,
} from "@/app/actions/admin";
import { ActionForm } from "@/components/ActionForm";
import { ApprovalRouteCard } from "@/components/ApprovalRouteCard";
import { DelegationGroup, DelegationSourceNote } from "@/components/DelegationNotice";
import { requireAdmin, requireViewer, type Viewer } from "@/lib/auth/guards";
import type { PortalDelegationView } from "@/lib/auth/portal-delegations";
import {
  loadAllUnfinishedDelegations,
  loadDelegationFoldActingFor,
  loadDelegationFoldGivenBy,
} from "@/lib/auth/portal-delegations";
import { formatDay, todayKst, yearOf } from "@/lib/dates";
import { db } from "@/lib/db";
import { webTenureRules } from "@/lib/db/schema";
import { env } from "@/lib/env";
import {
  loadApprovalRoute,
  loadHolidays,
  loadLeaveSettings,
  loadRanks,
  loadRouteCandidates,
} from "@/lib/leave/data";
import { delegationGroupEmptyNote, emptyDelegationFold } from "@/lib/leave/delegation-view";
import {
  SETTINGS_TAB_LABEL,
  SETTINGS_TAB_PARAM,
  resolveSettingsTab,
  settingsTabHref,
  settingsTabsFor,
  type SettingsTab,
} from "@/lib/leave/settings-tabs";
import { and, asc, eq } from "drizzle-orm";

const input =
  "rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none";
const saveBtn = "rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50";
const addBtn = "rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700";
const delBtn = "text-xs text-red-700 underline-offset-2 hover:underline";

/**
 * 제목 + 탭 줄.
 *
 * 🔴 **제목은 지금 선 탭의 이름이다.** 직원에게 보이는 탭은 「결재권 위임」 하나인데
 * 제목이 「휴가 설정」이면, 고칠 수도 없는 설정 화면에 들어온 것처럼 읽힌다.
 * 🔵 관리자가 기본 탭으로 들어오면 제목은 예전 그대로 「휴가 설정」이다.
 *
 * 🔴 **탭이 하나뿐이면 탭 줄을 안 그린다** — 누를 데가 없는 탭 줄은 「다른 탭이
 * 있는데 안 보인다」로 읽힌다.
 * 🔵 서버에서 그린다. 지금 선 탭을 주소로 알기 때문에 `usePathname` 같은 것이
 * 필요 없고, 클라이언트 조각을 하나도 안 늘린다.
 */
function SettingsTabs({ tab, isAdmin }: { tab: SettingsTab; isAdmin: boolean }) {
  const tabs = settingsTabsFor(isAdmin);
  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-900">{SETTINGS_TAB_LABEL[tab]}</h1>
      {tabs.length > 1 && (
        <nav aria-label="설정 탭" className="mt-3 flex flex-wrap items-center gap-1">
          {tabs.map((one) => (
            <Link
              key={one}
              href={settingsTabHref(one)}
              aria-current={one === tab ? "page" : undefined}
              className={
                one === tab
                  ? "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
                  : "rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }
            >
              {SETTINGS_TAB_LABEL[one]}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}

/**
 * [결재권 위임] 탭 — 🔴 **읽기 전용이고 직원도 들어온다**(lib/leave/settings-tabs.ts).
 *
 * 🔴 **맡기는 자리도 거두는 자리도 없다.** 지정·철회는 통합 승인함에서만 한다
 * (설계 B-2·B-9). 이 집에 지정 화면을 만들면 **같은 위임이 두 곳에 생기고**, 어느
 * 쪽에 적힌 것인지 사람이 가릴 수 없게 된다(설계 D-2 가 그 대가를 적어 두었다).
 *
 * 🔴 **열쇠는 명단 번호다**(`web_employees.id`). 계정은 있는데 명단에 안 이어진
 * 사람은 위임이 **걸릴 수조차 없다** — 그때 빈 목록만 보이면 「전파가 안 됐다」로
 * 읽히므로 그 사실을 따로 적는다.
 */
async function DelegationTab({ viewer }: { viewer: Viewer }) {
  // 🔵 한 번 찍어 **모든 조회와 모든 문장이 같은 순간**을 본다. 따로 찍으면 「진행
  //    중」과 「시작 전」이 같은 화면 안에서 갈릴 수 있고, 접기가 생긴 뒤로는
  //    **같은 줄이 펴진 쪽과 접힌 쪽에 동시에 뜨거나 양쪽에서 빠질 수도** 있다.
  const now = new Date();
  const employeeId = viewer.employee?.id ?? null;
  const [received, given, all] = await Promise.all([
    // 🔵 **끝난 줄까지 함께 온다**(2026-11-17). 펴 둘 줄은 `.live`, 접을 줄은
    //    `.finished` 다 — 가르는 일도 상한도 조회가 한다(그 함수 머리말).
    employeeId
      ? loadDelegationFoldActingFor(employeeId, now)
      : emptyDelegationFold<PortalDelegationView>(),
    employeeId
      ? loadDelegationFoldGivenBy(employeeId, now)
      : emptyDelegationFold<PortalDelegationView>(),
    // 🔴 권한은 **조회 함수 자신이** 묻는다 — 관리자가 아니면 null 이고 DB 에
    //    묻지도 않는다(화면에서 가리는 것으로는 아무것도 못 막는다).
    loadAllUnfinishedDelegations({ isAdmin: viewer.isAdmin, now }),
  ]);

  return (
    <div className="space-y-6">
      <SettingsTabs tab="delegation" isAdmin={viewer.isAdmin} />

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        {/* 🔴 2026-11-17 까지 여기 「끝났거나 거둬들인 위임은 이 목록에서 사라집니다」
            라고 적혀 있었다. 접기가 생긴 날 그 글이 **거짓말**이 됐다 — 끝난 위임은
            이제 사라지지 않고 아래 접기 안으로 들어간다. 🔵 결재함 맨 위 안내에서는
            여전히 사라지므로, 어디서 사라지는지를 **자리까지 적는다.** */}
        <p className="text-sm text-slate-600">
          통합 승인함에서 맡긴 결재권은 <b>이 시스템에도 그대로 적용됩니다.</b> 기간이 시작되면 맡긴 사람
          차례의 휴가 결재가 <b>대리인의 결재함에 함께</b> 뜨고, 기간이 끝나면 저절로 닫힙니다.
          끝났거나 거둬들인 위임은 <b>결재함 안내에서는 사라지고</b>, 이 화면에서는 아래 [끝난 위임 보기]
          안에 접혀 있습니다.
        </p>
        <DelegationSourceNote approvalsUrl={env.approvalsBaseUrl} className="mt-2" />
      </section>

      {!employeeId && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          이 계정은 아직 직원 명단에 이어져 있지 않습니다. 결재권 위임은 명단의 사람에게 걸리므로, 이어지기
          전까지는 내 위임이 보이지 않습니다.
        </p>
      )}

      {/* 🔴 **접기는 묶음마다 하나씩이다** — 한쪽을 펴도 다른 쪽은 접힌 채로 남는다
          (`<details>` 라 상태를 나눠 쓸 일이 아예 없다).
          🔴 빈 글자가 **접힌 줄의 수로 갈린다**: 끝난 줄이 바로 아래 접혀 있는
          사람에게 「없습니다」만 적으면 거짓말이고, 그 글을 믿으면 접기를 열어 볼
          생각을 못 한다(`delegationGroupEmptyNote`). */}
      <DelegationGroup
        title="내가 대신하고 있는 것"
        side="RECEIVED"
        rows={received.live}
        fold={received}
        now={now}
        empty={delegationGroupEmptyNote("RECEIVED", received.finished.length)}
      />
      <DelegationGroup
        title="내가 맡긴 것"
        side="GIVEN"
        rows={given.live}
        fold={given}
        now={now}
        empty={delegationGroupEmptyNote("GIVEN", given.finished.length)}
      />
      {/* 🔴 자료가 없으면(관리자가 아니면) 묶음 자체가 없다 — 감추는 것이 아니다. */}
      {all && (
        <DelegationGroup
          title="모두의 결재권 위임"
          side="ALL"
          rows={all}
          now={now}
          empty="지금 걸려 있는 결재권 위임이 없습니다."
        />
      )}
    </div>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // 🔴 문지기가 **탭마다 다르다**(lib/leave/settings-tabs.ts 머리말). 여기서는
  //    사내 화면의 공통 문(로그인 + 명단/관리자)만 묻고, 관리자 전용 갈래는 아래에서
  //    `requireAdmin()` 으로 다시 막는다.
  const viewer = await requireViewer();
  const sp = await searchParams;
  const tab = resolveSettingsTab(sp[SETTINGS_TAB_PARAM], viewer.isAdmin);
  if (tab === "delegation") return <DelegationTab viewer={viewer} />;

  // ── 🔴 여기서부터는 관리자 전용이다 ─────────────────────────────────────
  // 위 `resolveSettingsTab` 이 직원에게 이 탭을 돌려주지 않지만, **자료를 읽기
  // 전에** 서버가 한 번 더 막는다. 서버 컴포넌트가 읽은 값은 그리지 않아도 HTML 에
  // 실려 나가므로, 탭 고르기 한 줄이 느슨해지는 날 근속 표·직급·결재선이 통째로
  // 새어 나간다.
  await requireAdmin();
  const thisYear = yearOf(todayKst());
  const yearParam = typeof sp.year === "string" ? Number(sp.year) : NaN;
  const year = Number.isInteger(yearParam) && yearParam >= 2000 && yearParam <= 2100 ? yearParam : thisYear;

  const [rules, ranks, holidays, route, routeCandidates, settings] = await Promise.all([
    db
      .select()
      .from(webTenureRules)
      .where(and(eq(webTenureRules.isDeleted, false)))
      .orderBy(asc(webTenureRules.fromYear)),
    loadRanks(),
    loadHolidays(`${year}-01-01`, `${year}-12-31`),
    loadApprovalRoute(),
    loadRouteCandidates(),
    loadLeaveSettings(),
  ]);

  return (
    <div className="space-y-8">
      {/* 🔵 카드 다섯은 자리만 탭 안으로 들어왔다 — 동작도 글자도 그대로다. */}
      <SettingsTabs tab="settings" isAdmin={viewer.isAdmin} />

      {/* 근속 연차별 일수 */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">근속 연차별 연차 일수</h2>
        <p className="mb-3 mt-0.5 text-xs text-slate-500">
          사람마다 자기 입사 기념일에, 그날까지 채운 만 근속으로 이 표를 찾아 그해 연차를 줍니다. 만 12개월 = 1년.
          1년이 안 된 직원은 이 표 대신 한 달마다 1일(월차)을 받습니다.
        </p>
        <div className="space-y-2">
          {rules.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2">
              <ActionForm action={saveTenureRuleAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="id" value={r.id} />
                <input name="fromYear" type="number" min={1} defaultValue={r.fromYear} className={`w-16 ${input}`} />
                <span className="text-sm text-slate-500">~</span>
                <input name="toYear" type="number" min={1} defaultValue={r.toYear} className={`w-16 ${input}`} />
                <span className="text-sm text-slate-500">년차 →</span>
                <input name="days" type="number" step="0.5" defaultValue={r.days} className={`w-20 ${input}`} />
                <span className="text-sm text-slate-500">일</span>
                <button type="submit" className={saveBtn}>
                  저장
                </button>
              </ActionForm>
              <ActionForm action={deleteTenureRuleAction} confirm="이 줄을 지울까요?">
                <input type="hidden" name="id" value={r.id} />
                <button type="submit" className={delBtn}>
                  지우기
                </button>
              </ActionForm>
            </div>
          ))}
          {rules.length === 0 && <p className="text-sm text-slate-400">아직 없습니다.</p>}
        </div>
        <ActionForm action={saveTenureRuleAction} className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          <input name="fromYear" type="number" min={1} required placeholder="1" className={`w-16 ${input}`} />
          <span className="text-sm text-slate-500">~</span>
          <input name="toYear" type="number" min={1} required placeholder="2" className={`w-16 ${input}`} />
          <span className="text-sm text-slate-500">년차 →</span>
          <input name="days" type="number" step="0.5" required placeholder="10" className={`w-20 ${input}`} />
          <span className="text-sm text-slate-500">일</span>
          <button type="submit" className={addBtn}>
            줄 추가
          </button>
        </ActionForm>
      </section>

      {/* 여름휴가 — 회사 전체 하나. 사람마다·해마다 다르지 않다 */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">여름휴가</h2>
        <p className="mb-3 mt-0.5 text-xs text-slate-500">
          모든 직원이 해마다 받는 일수입니다. <b>연차와 따로 셉니다</b> — 여름휴가를 써도 연차는
          줄지 않습니다. 하루 단위로만 쓰고(반차 없음), 못 쓴 날은 넘어가지 않습니다.
          세는 기간은 <b>연차와 같습니다</b> (사람마다 자기 입사 기념일 ~ 다음 기념일 전날).
          값을 바꾸면 <b>모든 직원의 올해 남은 여름휴가가 함께 바뀝니다.</b>
        </p>
        <ActionForm action={saveLeaveSettingsAction} className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-500">직원 1명당 연</span>
          <input
            name="summerDays"
            type="number"
            min={0}
            max={60}
            step={1}
            required
            defaultValue={settings.summerDays}
            className={`w-20 ${input}`}
          />
          <span className="text-sm text-slate-500">일</span>
          <button type="submit" className={saveBtn}>
            저장
          </button>
        </ActionForm>
      </section>

      {/* 승인 절차 — 결재선(사람 순서 목록). 결재를 정하는 곳은 여기 하나다 */}
      <ApprovalRouteCard route={route} candidates={routeCandidates} />

      {/* 직급 */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">직급</h2>
        <p className="mb-3 mt-0.5 text-xs text-slate-500">
          🔴 <b>누가 결재하는지는 직급이 아니라 위 「승인 절차」의 사람 목록이 정합니다</b> (2026-09-21 변경).
          여기 &lsquo;결재&rsquo; 체크는 이제 <b>휴가 사유를 볼 수 있는 직급</b>과 머리말에 「결재함」 메뉴가 보이는
          직급만 정합니다. 새로 더한 직급은 <b>목록 맨 아래</b>에 섭니다 (직원 목록도 이 차례로 늘어놓습니다).
        </p>
        <div className="space-y-2">
          {ranks.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2">
              <ActionForm action={saveRankAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="id" value={r.id} />
                <input name="name" required defaultValue={r.name} className={`w-24 ${input}`} />
                <label className="flex items-center gap-1 text-sm text-slate-700">
                  <input name="canApprove" type="checkbox" defaultChecked={r.canApprove} />
                  결재
                </label>
                <button type="submit" className={saveBtn}>
                  저장
                </button>
              </ActionForm>
              <ActionForm action={deleteRankAction} confirm={`'${r.name}' 직급을 지울까요?`}>
                <input type="hidden" name="id" value={r.id} />
                <button type="submit" className={delBtn}>
                  지우기
                </button>
              </ActionForm>
            </div>
          ))}
        </div>
        <ActionForm action={saveRankAction} className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          <input name="name" required placeholder="예: 차장" className={`w-24 ${input}`} />
          <label className="flex items-center gap-1 text-sm text-slate-700">
            <input name="canApprove" type="checkbox" />
            결재
          </label>
          <button type="submit" className={addBtn}>
            직급 추가
          </button>
        </ActionForm>
      </section>

      {/* 공휴일 */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-800">공휴일 · 회사 휴무일</h2>
          <span className="ml-auto flex items-center gap-1 text-sm">
            <Link href={`/admin/settings?year=${year - 1}`} className="rounded px-2 py-0.5 text-slate-500 hover:bg-slate-100">
              ◀
            </Link>
            <span className="font-medium">{year}년</span>
            <Link href={`/admin/settings?year=${year + 1}`} className="rounded px-2 py-0.5 text-slate-500 hover:bg-slate-100">
              ▶
            </Link>
          </span>
        </div>
        <p className="mb-3 mt-0.5 text-xs text-slate-500">
          여러 날 휴가의 일수를 셀 때 이 날들은 뺍니다. 미리 넣어 둔 공휴일은 확인이 필요합니다 (임시공휴일·대체공휴일은 정부 발표 후 추가).
        </p>
        {holidays.length === 0 ? (
          <p className="text-sm text-slate-400">{year}년 휴일이 없습니다.</p>
        ) : (
          <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {holidays.map((h) => (
              <li key={h.id} className="flex items-center gap-2 py-1 text-sm">
                <span className="w-32 tabular text-slate-600">{formatDay(h.day)}</span>
                <span className="flex-1 text-slate-800">
                  {h.name}
                  {h.kind === "COMPANY" && <span className="ml-1 text-xs text-indigo-700">회사</span>}
                </span>
                <ActionForm action={deleteHolidayAction} confirm={`${h.day} ${h.name}을(를) 지울까요?`}>
                  <input type="hidden" name="id" value={h.id} />
                  <button type="submit" className={delBtn}>
                    지우기
                  </button>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
        <ActionForm action={createHolidayAction} className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          <input name="day" type="date" required className={input} />
          <input name="name" required maxLength={40} placeholder="이름 (예: 창립기념일)" className={`w-48 ${input}`} />
          <select name="kind" defaultValue="COMPANY" className={input}>
            <option value="COMPANY">회사 휴무일</option>
            <option value="PUBLIC">공휴일</option>
          </select>
          <button type="submit" className={addBtn}>
            추가
          </button>
        </ActionForm>
      </section>
    </div>
  );
}
