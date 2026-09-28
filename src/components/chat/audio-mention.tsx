"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { useI18n } from "@/i18n/provider";

/**
 * A recording the agent made, played where the answer names it.
 *
 * Someone asked for four takes of one line in four moods and got a table of
 * paths: nothing in the chat could play them, and the file screen refused an
 * .mp3 as a binary it could not preview. Comparing takes is the whole job, so
 * the control sits on the path itself and starting one take stops the other.
 *
 * Deliberately small - play, time, and the file's own screen one click away,
 * which has the browser's full player and the download. Seeking and volume live
 * there rather than in a pill inside a sentence or a table cell.
 */

// One recording at a time, across every message on the page.
let playing: HTMLAudioElement | null = null;

function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function AudioMention({ src, href, name, fallback, children }: {
  /** Where the audio loads from: the file, served as audio. */
  src: string;
  /** The file's own screen. */
  href: string;
  /** What the control announces, the path as the answer wrote it. */
  name: string;
  /** What to show when this browser cannot play the file. */
  fallback: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [position, setPosition] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      if (playing === audio) playing = null;
    };
  }, []);

  if (failed) return <>{fallback}</>;

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (playing && playing !== audio) playing.pause();
    playing = audio;
    void audio.play().catch((error: unknown) => {
      // Only a file that cannot be decoded is a failure. A pause that lands
      // before playback starts rejects this promise too, and that is not one.
      if (error instanceof DOMException && error.name === "NotSupportedError") setFailed(true);
    });
  };

  const readDuration = () => {
    const value = audioRef.current?.duration;
    setDuration(typeof value === "number" && Number.isFinite(value) ? value : null);
  };

  // The time beside the button: how long the take is until it starts, then
  // how far into it, so the width does not change under the pointer.
  const time = formatTime(isPlaying || position > 0 ? position : duration);
  const progress = duration ? Math.min(1, position / duration) : 0;

  return (
    // One line: a take's path broken across two in a table cell reads as two
    // files. A path longer than the column ends in an ellipsis instead.
    <span className="relative inline-flex max-w-full items-center overflow-hidden whitespace-nowrap rounded bg-muted align-middle font-mono text-sm">
      <button
        type="button"
        onClick={toggle}
        aria-label={t(isPlaying ? "chat.audio.pause" : "chat.audio.play", { name })}
        className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center gap-1 px-1.5 outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {isPlaying ? (
          <Pause className="size-3 shrink-0 fill-current" aria-hidden />
        ) : (
          <Play className="size-3 shrink-0 fill-current" aria-hidden />
        )}
        {time ? <span className="text-xs tabular-nums">{time}</span> : null}
      </button>
      {/* Centred rather than inline: under a coarse pointer every link is
          made 44px tall, and inline text would sit at the top of that. */}
      <a
        href={href}
        title={t("files.open")}
        className="flex min-w-0 items-center self-stretch pl-0.5 pr-1.5 outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="truncate underline decoration-dotted underline-offset-2">{children}</span>
      </a>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left bg-foreground/60 transition-transform duration-200 ease-linear"
        style={{ transform: `scaleX(${progress})` }}
      />
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={readDuration}
        onDurationChange={readDuration}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          setPosition(0);
        }}
        onError={() => setFailed(true)}
      />
    </span>
  );
}
