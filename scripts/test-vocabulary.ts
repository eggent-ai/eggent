/**
 * Checks the vocabulary the runtime matches intent against.
 *
 * The words live in src/i18n so the rest of the source can stay identical
 * across localised branches, which means the same file has to be right in a
 * build that ships one language and in a build that ships two. These
 * expectations therefore read SUPPORTED_LOCALES rather than assuming either.
 *
 * Run with Node 22:
 *   node --experimental-strip-types --import ./scripts/alias-loader-register.mjs \
 *     scripts/test-vocabulary.ts
 */
import assert from "node:assert/strict";
import { SUPPORTED_LOCALES } from "../src/i18n/locales.ts";
import {
  AFFIRMATIVES,
  DEFAULT_CHAT_TITLES,
  INTERRUPT_VERBS,
  SLUG_EXTRA_CHARACTERS,
  STOP_PHRASES,
  wordMatcher,
  wordPattern,
} from "../src/i18n/vocabulary.ts";
import { hasScheduleIntent, hasScheduleManagementIntent } from "../src/lib/pi/schedule-intent.ts";

const shipsRussian = (SUPPORTED_LOCALES as readonly string[]).includes("ru");

let failed = 0;
let ran = 0;
function check(name: string, fn: () => void): void {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`Intent vocabulary (locales: ${SUPPORTED_LOCALES.join(", ")})\n`);

check("an ASCII word is bounded, so it does not fire from inside another word", () => {
  const re = wordMatcher(["stop", "cancel"]);
  assert.equal(re.test("stop it"), true);
  assert.equal(re.test("please cancel"), true);
  assert.equal(re.test("stopwatch"), false, "a bounded word must not match inside another");
  assert.equal(re.test("unstoppable"), false);
});

check("a build with no words for something never matches", () => {
  assert.equal(wordMatcher([]).test("anything at all"), false);
  assert.equal(wordPattern([]), "");
});

check("English intent works whatever else ships", () => {
  assert.equal(hasScheduleManagementIntent("show me the scheduled jobs"), true);
  assert.equal(hasScheduleIntent("remind me tomorrow"), true);
  assert.equal(hasScheduleIntent("what is two plus two"), false);
  assert.equal(wordMatcher(INTERRUPT_VERBS).test("stop the process"), true);
});

check("the English vocabulary is never empty", () => {
  for (const [name, words] of [
    ["stop phrases", STOP_PHRASES],
    ["affirmatives", AFFIRMATIVES],
    ["interrupt verbs", INTERRUPT_VERBS],
    ["default chat titles", DEFAULT_CHAT_TITLES],
  ] as const) {
    assert.ok(words.length > 0, `${name} must not be empty`);
    assert.ok(words.some((word) => /^[\x20-\x7e]+$/.test(word)), `${name} needs an English entry`);
  }
});

check(`Russian is understood exactly where it ships (ru: ${shipsRussian})`, () => {
  assert.equal(hasScheduleManagementIntent("покажи список задач"), shipsRussian);
  assert.equal(hasScheduleIntent("напомни мне завтра"), shipsRussian);
  assert.equal(hasScheduleIntent("через 5 минут напомни"), shipsRussian);
  assert.equal(wordMatcher(INTERRUPT_VERBS).test("останови это"), shipsRussian);
  assert.equal(DEFAULT_CHAT_TITLES.includes("Новый чат"), shipsRussian);
  assert.equal(SLUG_EXTRA_CHARACTERS.length > 0, shipsRussian);
});

check("a verb does not fire from inside a longer word in any alphabet", () => {
  // `\b` is defined on the Latin alphabet, so a build that ships another one has
  // to guard its own words; without it "останови" reads out of "остановился"
  // and the runtime concludes the user asked to kill a process.
  const re = wordMatcher(INTERRUPT_VERBS);
  for (const innocent of ["процесс остановился сам", "поезд остановился", "прервалась связь", "завершил обучение"]) {
    assert.equal(re.test(innocent), false, `must not fire on: ${innocent}`);
  }
});

check("an ordinary sentence is not a scheduling request", () => {
  for (const phrase of [
    "what is two plus two",
    "write a stop() function for the player",
    "сколько будет два плюс два",
    "напиши функцию stop() для плеера",
  ]) {
    assert.equal(hasScheduleIntent(phrase), false, `should not be scheduling: ${phrase}`);
    assert.equal(hasScheduleManagementIntent(phrase), false, `should not be management: ${phrase}`);
  }
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
