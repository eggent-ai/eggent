"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Loader2, Upload } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { useAppStore } from "@/store/app-store";

interface AvailableEmployee {
  skill: string;
  id: string;
  input: "url" | "channel" | "file" | "topic" | "role";
  role: string;
  pitch: string;
  ask: string;
  placeholder?: string;
}

interface HiredEmployee {
  projectId: string;
  name: string;
  employee: string;
  createdAt: string;
}

interface ScheduledJob {
  projectId?: string | null;
  nextRun?: string;
  enabled?: boolean;
}

/**
 * The home screen of a workspace that has AI employees: the ones already
 * hired, with what each is up to, and the ones that can be hired - each asking
 * its one question right here. Renders nothing where the deployment offers no
 * employees, so the plain new-chat screen stays as it was.
 */
export function EmployeesHome({ onReady }: { onReady?: (present: boolean) => void }) {
  const { t, locale } = useI18n();
  const [available, setAvailable] = useState<AvailableEmployee[] | null>(null);
  const [hired, setHired] = useState<HiredEmployee[]>([]);
  const [nextRuns, setNextRuns] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const setActiveProjectId = useAppStore((state) => state.setActiveProjectId);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch("/api/employees").catch(() => null);
      const payload = response?.ok ? ((await response.json().catch(() => null)) as { available?: AvailableEmployee[]; hired?: HiredEmployee[] } | null) : null;
      if (cancelled) return;
      setAvailable(payload?.available ?? []);
      setHired(payload?.hired ?? []);
      onReady?.(Boolean(payload?.available?.length));
      if (payload?.hired?.length) {
        const schedules = await fetch("/api/pi-schedules").then((r) => (r.ok ? r.json() : null)).catch(() => null) as { schedules?: ScheduledJob[] } | null;
        const soonest: Record<string, string> = {};
        for (const job of schedules?.schedules ?? []) {
          if (!job.projectId || job.enabled === false || !job.nextRun) continue;
          if (!soonest[job.projectId] || job.nextRun < soonest[job.projectId]) soonest[job.projectId] = job.nextRun;
        }
        if (!cancelled) setNextRuns(soonest);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onReady]);

  if (!available || available.length === 0) return null;
  const formatter = new Intl.DateTimeFormat(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex flex-col gap-8" data-slot="employees-home">
      {hired.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">{t("employees.home.hired")}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {hired.map((person) => (
              <button
                key={person.projectId}
                type="button"
                onClick={() => setActiveProjectId(person.projectId)}
                className="group flex items-center gap-3 rounded-2xl border bg-card p-4 text-left shadow-xs transition-colors hover:border-primary/50"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground font-semibold" aria-hidden>
                  {person.name.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium leading-5">{person.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {nextRuns[person.projectId]
                      ? t("employees.home.nextRun", { when: formatter.format(new Date(nextRuns[person.projectId])) })
                      : t("employees.home.noSchedule")}
                  </span>
                </span>
                <ArrowRight className="size-4 text-muted-foreground transition group-hover:translate-x-0.5" aria-hidden />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">{hired.length > 0 ? t("employees.home.hireMore") : t("employees.home.hireFirst")}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {available.map((employee) => (
            <HireCard key={employee.id} employee={employee} expanded={open === employee.id} onToggle={() => setOpen(open === employee.id ? null : employee.id)} />
          ))}
        </div>
      </section>
    </div>
  );
}

function HireCard({ employee, expanded, onToggle }: { employee: AvailableEmployee; expanded: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (expanded) inputRef.current?.focus();
  }, [expanded]);

  const hire = async () => {
    if (busy) return;
    if (employee.input === "file" ? !file : value.trim().length < 3) {
      setError(t("employees.home.needInput"));
      return;
    }
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("skill", employee.skill);
    if (value.trim()) form.set("input", value.trim());
    if (file) form.set("file", file);
    const response = await fetch("/api/employees/hire", { method: "POST", body: form }).catch(() => null);
    const payload = response ? ((await response.json().catch(() => null)) as { chatId?: string; error?: string } | null) : null;
    if (response?.ok && payload?.chatId) {
      window.location.assign(`/dashboard/${encodeURIComponent(payload.chatId)}`);
      return;
    }
    setBusy(false);
    setError(payload?.error || t("employees.home.failed"));
  };

  return (
    <div className={`flex flex-col gap-3 rounded-2xl border p-4 transition-colors ${expanded ? "border-primary/50 bg-primary/5" : "bg-card"}`}>
      <button type="button" onClick={onToggle} className="flex items-start gap-3 text-left" aria-expanded={expanded}>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary font-semibold" aria-hidden>
          {employee.role.slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium leading-5">{employee.role}</span>
          <span className="mt-1 block text-sm leading-5 text-muted-foreground">{employee.pitch}</span>
        </span>
      </button>
      {expanded ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void hire();
          }}
        >
          <label className="text-sm font-medium" htmlFor={`hire-${employee.id}`}>{employee.ask}</label>
          {employee.input === "file" ? (
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed px-3 py-3 text-sm text-muted-foreground hover:border-primary/50">
              <Upload className="size-4" aria-hidden />
              <span className="truncate">{file ? file.name : employee.placeholder || t("employees.home.chooseFile")}</span>
              <input
                ref={inputRef}
                id={`hire-${employee.id}`}
                type="file"
                className="sr-only"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
          ) : (
            <input
              ref={inputRef}
              id={`hire-${employee.id}`}
              className="h-10 rounded-xl border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder={employee.placeholder}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
            />
          )}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <button
            type="submit"
            disabled={busy}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {t("employees.home.hire")}
          </button>
        </form>
      ) : null}
    </div>
  );
}
