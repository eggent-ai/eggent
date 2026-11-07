"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { employeeEggSvg } from "@/lib/employees/egg";

export interface EmployeeCard {
  id: string;
  input: "url" | "channel" | "file" | "topic" | "role" | "any";
  role: string;
  pitch: string;
  ask: string;
  placeholder?: string;
  start?: string;
}

type AvailableEmployee = EmployeeCard & { skill: string };

/**
 * The home screen of a workspace that has AI employees: each one asking its
 * one question right here. One already hired gets the task in a new chat of
 * its own project; one not yet hired gets its project first. Everything it
 * draws comes with the page, so nothing appears or moves after the first paint.
 */
export function EmployeesHome({ available, hiredIds }: { available: AvailableEmployee[]; hiredIds: string[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  if (available.length === 0) return null;
  return (
    <div className="flex flex-col gap-8" data-slot="employees-home">
      <section className="flex flex-col gap-3">
        {hiredIds.length > 0 ? null : <h3 className="text-sm font-semibold">{t("employees.home.hireFirst")}</h3>}
        <div className="grid gap-3 sm:grid-cols-2">
          {available.map((employee, index) => (
            <HireCard
              key={employee.id}
              index={index}
              employee={employee}
              hired={hiredIds.includes(employee.id)}
              expanded={open === employee.id}
              onToggle={() => setOpen(open === employee.id ? null : employee.id)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

/** What every way of hiring shares: the answer to its one question, and starting the job. */
function useHire(employee: AvailableEmployee) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const payload = response ? ((await response.json().catch(() => null)) as { chatId?: string; error?: string; first?: boolean } | null) : null;
    if (response?.ok && payload?.chatId) {
      // An ordinary chat with the whole workspace around it: the focus view
      // (no sidebar, header or composer) left nothing to press, Stop included.
      window.location.assign(`/dashboard/${encodeURIComponent(payload.chatId)}`);
      return;
    }
    setBusy(false);
    setError(payload?.error || t("employees.home.failed"));
  };
  return { value, setValue, file, setFile, busy, error, hire };
}

function HireCard({ employee, index, hired, expanded, onToggle }: { employee: AvailableEmployee; index: number; hired: boolean; expanded: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const { value, setValue, file, setFile, busy, error, hire } = useHire(employee);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (expanded) inputRef.current?.focus();
  }, [expanded]);

  return (
    // The same lift, border and shadow as the skill cards, so it reads as something to press.
    <div
      className={`group flex flex-col gap-3 rounded-2xl border p-4 shadow-sm transition ${
        expanded ? "border-primary/50 bg-primary/5" : "bg-card hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md"
      }`}
    >
      <button type="button" onClick={onToggle} className="flex cursor-pointer items-start gap-3 text-left" aria-expanded={expanded}>
        <span
          className="eggent-egg-idle size-12 shrink-0"
          // Each egg hops on its own beat, the way a row of characters looks alive.
          style={{ animationDelay: `${index * 0.35}s` }}
          aria-hidden
          // Our own drawing from a fixed table: nothing from outside reaches it.
          dangerouslySetInnerHTML={{ __html: employeeEggSvg(employee.id) }}
        />
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
            {hired ? t("employees.home.assign") : t("employees.home.hire")}
          </button>
        </form>
      ) : null}
    </div>
  );
}

/**
 * The first thing a new workspace says, as a message in the chat: drawn without
 * the model, so it is on the screen with the page. Each button names a job and
 * asks that job's one question; nothing here guesses from what the person gives
 * it - anything else goes through the composer, and the agent reads it.
 */
export function WelcomeMessage({
  employees,
  appsOffered,
  onAsk,
  onSkip,
  onStep,
}: {
  employees: AvailableEmployee[];
  appsOffered: boolean;
  onAsk: (text: string) => void;
  onSkip: () => void;
  onStep: (event: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    onStep("shown");
  }, [onStep]);
  const jobs = employees.filter((employee) => employee.input !== "role" && employee.input !== "any");
  const chosen = jobs.find((employee) => employee.id === open);
  const pill = "inline-flex min-h-9 items-center rounded-full border px-3.5 py-1.5 text-left text-sm font-medium transition hover:border-primary/50 hover:bg-primary/5 aria-expanded:border-primary/50 aria-expanded:bg-primary/5";
  return (
    <div className="flex-1 overflow-y-auto px-4 md:px-6" data-slot="welcome">
      <div className="mx-auto flex max-w-3xl gap-3 py-6">
        <span
          className="eggent-egg-idle size-10 shrink-0"
          aria-hidden
          // Our own drawing from a fixed table: nothing from outside reaches it.
          dangerouslySetInnerHTML={{ __html: employeeEggSvg("first") }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <p className="text-base leading-7">{t("welcome.text")}</p>
          <div className="flex flex-wrap gap-2">
            {jobs.map((employee) => (
              <button
                key={employee.id}
                type="button"
                className={pill}
                aria-expanded={open === employee.id}
                onClick={() => {
                  if (open !== employee.id) onStep(`button:${employee.id}`);
                  setOpen(open === employee.id ? null : employee.id);
                }}
              >
                {employee.start || employee.role}
              </button>
            ))}
            {appsOffered ? (
              <button
                type="button"
                className={pill}
                onClick={() => {
                  onStep("apps");
                  onAsk(t("welcome.appsPrompt"));
                }}
              >
                {t("welcome.apps")}
              </button>
            ) : null}
          </div>
          {chosen ? <WelcomeAnswer key={chosen.id} employee={chosen} /> : null}
          <p className="text-sm leading-6 text-muted-foreground">{t("welcome.own")}</p>
          <div>
            <button type="button" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={onSkip}>
              {t("welcome.skip")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WelcomeAnswer({ employee }: { employee: AvailableEmployee }) {
  const { t } = useI18n();
  const { value, setValue, file, setFile, busy, error, hire } = useHire(employee);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <form
      className="flex max-w-xl flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void hire();
      }}
    >
      <label className="text-sm font-medium" htmlFor={`welcome-${employee.id}`}>{employee.ask}</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        {employee.input === "file" ? (
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-xl border border-dashed px-3 py-2 text-sm text-muted-foreground hover:border-primary/50">
            <Upload className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{file ? file.name : employee.placeholder || t("employees.home.chooseFile")}</span>
            <input ref={inputRef} id={`welcome-${employee.id}`} type="file" className="sr-only" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>
        ) : (
          <input
            ref={inputRef}
            id={`welcome-${employee.id}`}
            className="h-10 min-w-0 flex-1 rounded-xl border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder={employee.placeholder}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
          />
        )}
        <button type="submit" disabled={busy} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60">
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t("welcome.start")}
        </button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </form>
  );
}
