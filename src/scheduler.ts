import type { Loop } from "./domain.js";

export function isLoopDue(loop: Loop, asOf = new Date()): boolean {
  if (!loop.enabled || loop.schedule.trim().toLowerCase() === "manual") return false;
  if (loop.schedule.startsWith("@every ")) return isIntervalDue(loop.schedule.slice(7).trim(), loop.lastScheduledAt, asOf);
  return isCronDue(loop.schedule, loop.lastScheduledAt, asOf);
}

function isIntervalDue(expression: string, lastScheduledAt: string | null, asOf: Date): boolean {
  const match = expression.match(/^(\d+)\s*([smhd])$/i);
  if (!match) throw new Error(`Invalid @every schedule: ${expression}`);
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multiplier = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  if (!lastScheduledAt) return true;
  return asOf.getTime() - Date.parse(lastScheduledAt) >= amount * multiplier;
}

function isCronDue(expression: string, lastScheduledAt: string | null, asOf: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Fleet supports five-field cron expressions or @every: ${expression}`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const currentMinute = new Date(asOf);
  currentMinute.setSeconds(0, 0);
  if (lastScheduledAt) {
    const lastMinute = new Date(lastScheduledAt);
    lastMinute.setSeconds(0, 0);
    if (lastMinute.getTime() >= currentMinute.getTime()) return false;
  }
  return matchesField(minute!, asOf.getMinutes(), 0, 59)
    && matchesField(hour!, asOf.getHours(), 0, 23)
    && matchesField(dayOfMonth!, asOf.getDate(), 1, 31)
    && matchesField(month!, asOf.getMonth() + 1, 1, 12)
    && matchesField(dayOfWeek!, asOf.getDay(), 0, 6, true);
}

function matchesField(expression: string, value: number, min: number, max: number, sundayAlias = false): boolean {
  return expression.split(",").some((segment) => {
    const [rangeExpression, stepExpression] = segment.split("/");
    const step = stepExpression ? Number(stepExpression) : 1;
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid cron step: ${segment}`);
    let start = min;
    let end = max;
    if (rangeExpression !== "*") {
      const range = rangeExpression!.split("-").map(Number);
      start = normalizeCronValue(range[0]!, sundayAlias);
      end = normalizeCronValue(range[1] ?? range[0]!, sundayAlias);
    }
    if (start < min || end > max || start > end) throw new Error(`Invalid cron range: ${segment}`);
    return value >= start && value <= end && (value - start) % step === 0;
  });
}

function normalizeCronValue(value: number, sundayAlias: boolean): number {
  return sundayAlias && value === 7 ? 0 : value;
}
