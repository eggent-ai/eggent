import { SECRET_LABELS, SECRET_LINK_WORDS, wordPattern } from "@/i18n/vocabulary";

/**
 * Somebody telling the assistant a credential in words: "the password is
 * hunter2xyz", "password: Xk93mQ2z".
 *
 * A label, a link, and then something that looks like the secret itself - at
 * least eight characters with a digit and a letter among them. That last part
 * is what keeps "the password is correct" and "password: required" from being
 * taken for one; the warning this feeds interrupts the person, and an
 * interruption that is usually wrong teaches them to click through it. The
 * labels are vocabulary, since what people call a password depends on the
 * language they say it in.
 */
export const SPOKEN_CREDENTIAL = new RegExp(
  `(?:${wordPattern(SECRET_LABELS)})\\s*(?:${wordPattern(SECRET_LINK_WORDS)}|[=:\\u2014\\u2013-])\\s*(?=\\S*\\d)(?=\\S*[A-Za-z\\u0400-\\u04FF])\\S{8,}`,
  "i"
);
