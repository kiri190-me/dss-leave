"use client";

import { useActionState, useMemo, useState } from "react";

import type { ActionState } from "@/lib/action-state";
import { formatRange } from "@/lib/dates";
import type { LeaveType } from "@/lib/db/schema";
import { formatDays } from "@/lib/leave/labels";
import { LEAVE_TYPE_INFO, computeLeaveDays } from "@/lib/leave/rules";

const DEDUCT_TYPES: LeaveType[] = ["ANNUAL", "AM_HALF", "PM_HALF"];
/** 여름휴가 — 연차와 별개인 제 잔액이라 줄을 따로 세운다 (반차 없음) */
const SUMMER_TYPES: LeaveType[] = ["SUMMER"];
const OTHER_TYPES: LeaveType[] = ["CONDOLENCE", "HEALTH_CHECK", "RESERVE", "OTHER"];

/**
 * 휴가 신청 · 날짜 변경 신청 폼.
 * 일수와 결재권자는 미리 보여 주기만 한다. 실제 계산·검사는 서버가 다시 한다.
 */
export function LeaveForm({
  action,
  holidays,
  chainNames,
  available,
  summerAvailable,
  today,
  initial,
  submitLabel,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  holidays: string[];
  chainNames: string[];
  /** 지금 더 신청할 수 있는 **연차** 일수 (변경이면 원래 휴가 일수를 더한 값) */
  available: number;
  /** 지금 더 신청할 수 있는 **여름휴가** 일수. 연차와 섞지 않는다 */
  summerAvailable: number;
  today: string;
  initial?: {
    targetId: string;
    leaveType: LeaveType;
    startDate: string;
    endDate: string;
    reason: string;
  };
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [leaveType, setLeaveType] = useState<LeaveType>(initial?.leaveType ?? "ANNUAL");
  const [startDate, setStartDate] = useState(initial?.startDate ?? today);
  const [endDate, setEndDate] = useState(initial?.endDate ?? today);

  const info = LEAVE_TYPE_INFO[leaveType];
  const holidaySet = useMemo(() => new Set(holidays), [holidays]);
  const effectiveEnd = info.halfDay ? startDate : endDate;
  const preview = useMemo(() => {
    if (!startDate || !effectiveEnd) return null;
    return computeLeaveDays(leaveType, startDate, effectiveEnd, holidaySet);
  }, [leaveType, startDate, effectiveEnd, holidaySet]);

  // 고른 종류가 어느 주머니에서 빠지는가에 따라 미리 보여 줄 잔액이 갈린다.
  // 🔴 여름휴가는 연차 잔액과 섞지 않는다 (서버도 주머니별로 따로 본다).
  const pool = info.pool;
  const poolAvailable = pool === "SUMMER" ? summerAvailable : available;
  const poolName = pool === "SUMMER" ? "여름휴가" : "휴가";
  const over = preview?.ok && pool !== null && preview.days > poolAvailable;

  return (
    <form action={formAction} className="space-y-6">
      {initial && <input type="hidden" name="targetId" value={initial.targetId} />}
      <fieldset disabled={pending} className="space-y-6">
        <div>
          <p className="mb-2 text-sm font-semibold text-slate-700">휴가 종류</p>
          <div className="flex flex-wrap gap-2">
            {DEDUCT_TYPES.map((t) => (
              <TypeOption key={t} type={t} checked={leaveType === t} onChange={setLeaveType} />
            ))}
          </div>
          <p className="mb-2 mt-4 text-xs font-medium text-slate-500">
            여름휴가(연차와 따로 · 하루 단위)
          </p>
          <div className="flex flex-wrap gap-2">
            {SUMMER_TYPES.map((t) => (
              <TypeOption key={t} type={t} checked={leaveType === t} onChange={setLeaveType} />
            ))}
          </div>
          <p className="mb-2 mt-4 text-xs font-medium text-slate-500">공가 신청(연차 차감X)</p>
          <div className="flex flex-wrap gap-2">
            {OTHER_TYPES.map((t) => (
              <TypeOption key={t} type={t} checked={leaveType === t} onChange={setLeaveType} />
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-slate-700">
              {info.halfDay ? "날짜" : "시작하는 날"}
            </span>
            <input
              type="date"
              name="startDate"
              required
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                if (!endDate || e.target.value > endDate) setEndDate(e.target.value);
              }}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            />
          </label>
          {!info.halfDay && (
            <>
              <span className="pb-2 text-slate-400">~</span>
              <label className="block">
                <span className="mb-1 block text-sm font-semibold text-slate-700">끝나는 날</span>
                <input
                  type="date"
                  name="endDate"
                  required
                  min={startDate}
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                />
              </label>
            </>
          )}
          {info.halfDay && <input type="hidden" name="endDate" value={startDate} />}
        </div>

        <label className="block">
          <span className="mb-1 block text-sm font-semibold text-slate-700">
            사유 <span className="font-normal text-slate-400">(선택 · 본인과 결재권자에게만 보입니다)</span>
          </span>
          <textarea
            name="reason"
            rows={2}
            maxLength={500}
            defaultValue={initial?.reason ?? ""}
            placeholder="예: 가족 여행, 병원 진료"
            className="w-full max-w-xl rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          />
        </label>

        <input type="hidden" name="leaveType" value={leaveType} />

        <div className="max-w-xl rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
          {preview == null ? (
            <p className="text-slate-500">날짜를 고르세요.</p>
          ) : !preview.ok ? (
            <p className="text-red-700">{preview.error}</p>
          ) : (
            <>
              <p className="font-medium text-slate-800">
                {formatRange(startDate, effectiveEnd)} ·{" "}
                {pool === "ANNUAL" ? (
                  <>
                    연차에서 <strong>{formatDays(preview.days)}</strong> 빠집니다
                  </>
                ) : pool === "SUMMER" ? (
                  <>
                    여름휴가에서 <strong>{formatDays(preview.days)}</strong> 빠집니다 (연차는 그대로)
                  </>
                ) : (
                  <>연차에서 빠지지 않습니다 ({formatDays(preview.days)})</>
                )}
              </p>
              {!info.halfDay && preview.dates.length > 0 && (
                <p className="mt-0.5 text-xs text-slate-500">주말·공휴일은 빼고 셉니다.</p>
              )}
              {pool !== null && (
                <p className={`mt-1 text-xs ${over ? "font-medium text-red-700" : "text-slate-500"}`}>
                  {over
                    ? `남은 ${poolName}(${formatDays(poolAvailable)})보다 많습니다.`
                    : `신청하면 ${formatDays(Math.round((poolAvailable - preview.days) * 10) / 10)} 남습니다.`}
                </p>
              )}
            </>
          )}
          <p className="mt-2 border-t border-slate-200 pt-2 text-xs text-slate-600">
            {chainNames.length === 0 ? (
              "결재 없이 바로 등록됩니다."
            ) : (
              <>
                결재는 <strong>{chainNames.join(" → ")}</strong> 차례로 갑니다 — 먼저{" "}
                <strong>{chainNames[0]}</strong> 님에게 가고, 앞사람이 승인해야 다음 사람에게
                넘어갑니다. {chainNames.length}명이 모두 승인하면 확정됩니다.
              </>
            )}
          </p>
        </div>

        {state?.error && (
          <p role="alert" className="text-sm text-red-700">
            {state.error}
          </p>
        )}

        <button
          type="submit"
          className="rounded-md bg-slate-900 px-5 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {pending ? "보내는 중…" : submitLabel}
        </button>
      </fieldset>
    </form>
  );
}

function TypeOption({
  type,
  checked,
  onChange,
}: {
  type: LeaveType;
  checked: boolean;
  onChange: (t: LeaveType) => void;
}) {
  const info = LEAVE_TYPE_INFO[type];
  return (
    <label
      className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm ${
        checked
          ? "border-slate-900 bg-slate-900 text-white"
          : "border-slate-300 bg-white text-slate-700 hover:border-slate-500"
      }`}
    >
      <input
        type="radio"
        name="leaveTypeChoice"
        value={type}
        checked={checked}
        onChange={() => onChange(type)}
        className="sr-only"
      />
      {info.label}
      {info.halfDay && <span className="ml-1 text-xs opacity-70">0.5일</span>}
    </label>
  );
}
