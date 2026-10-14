"use client";

import { useEffect, useRef } from "react";

/**
 * Rings around the dictation button that move with the voice.
 *
 * The only thing that tells a person the microphone is hearing them while they
 * talk. The level is read off the live stream every frame and written to one
 * CSS variable on this element, so speaking re-renders nothing; the rings scale
 * from it in CSS. Silence still breathes slowly, or a pause reads as "it
 * stopped listening" - under reduced motion the breath slows rather than stops,
 * like the app's spinner, while the level itself stays: it is feedback, not
 * decoration.
 */
export function MicLevelRings({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const AudioContextCtor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    const context = new AudioContextCtor();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    let level = 0;
    let frame = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const rms = Math.sqrt(sum / samples.length);
      // Speech sits around 0.02-0.2 RMS; a square root lifts quiet talk into
      // view without letting a shout run off the scale.
      const target = Math.min(1, Math.sqrt(Math.max(0, rms - 0.008) * 6));
      // Rise quickly, fall slowly: a word lands at once and fades like a sound.
      level += (target - level) * (target > level ? 0.45 : 0.12);
      element.style.setProperty("--mic-level", level.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      void context.close().catch(() => undefined);
    };
  }, [stream]);

  return (
    <span ref={ref} aria-hidden className="pointer-events-none absolute inset-0 -z-10 rounded-[inherit]">
      <span className="mic-level-ring mic-level-ring-1" />
      <span className="mic-level-ring mic-level-ring-2" />
      <span className="mic-level-ring mic-level-ring-3" />
    </span>
  );
}
