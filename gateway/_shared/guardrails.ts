/**
 * @fileoverview Content guardrail scanning functions for topic blocking,
 * competitor mention detection, and profanity filtering.
 * All use keyword/regex matching for sub-millisecond latency.
 * @module invoke/_shared/guardrails
 */

// ============================================================================
// Built-in Profanity Word List (~150 common terms)
// ============================================================================

const BUILTIN_PROFANITY: string[] = [
  "ass",
  "asshole",
  "bastard",
  "bitch",
  "bollocks",
  "bullshit",
  "cock",
  "crap",
  "cunt",
  "damn",
  "dick",
  "douchebag",
  "fag",
  "faggot",
  "fuck",
  "fucking",
  "goddamn",
  "hell",
  "jackass",
  "jerk",
  "motherfucker",
  "nigga",
  "nigger",
  "piss",
  "prick",
  "pussy",
  "shit",
  "slut",
  "twat",
  "whore",
  "wanker",
  "retard",
  "retarded",
  "spic",
  "chink",
  "gook",
  "kike",
  "wetback",
  "beaner",
  "tranny",
  "dyke",
  "coon",
  "cracker",
  "honky",
  "gringo",
  "skank",
  "hoe",
  "thot",
  "dipshit",
  "shithead",
  "asshat",
  "dumbass",
  "fatass",
  "smartass",
  "badass",
  "kickass",
  "horseshit",
  "apeshit",
  "batshit",
  "clusterfuck",
  "mindfuck",
  "brainfuck",
  "fuckwit",
  "fuckface",
  "shitfaced",
  "cocksucker",
  "dickhead",
  "asswipe",
  "shitstain",
  "fucktard",
  "dirtbag",
  "scumbag",
  "sleazebag",
  "douche",
  "pissed",
  "bitchy",
  "slutty",
  "trashy",
  "skanky",
  "fugly",
  "stfu",
  "gtfo",
  "lmfao",
  "wtf",
  "omfg",
  "fml",
  "smfh",
  "arse",
  "arsehole",
  "bellend",
  "bloody",
  "bugger",
  "minger",
  "pillock",
  "plonker",
  "sod",
  "tosser",
  "git",
  "naff",
  "numpty",
  "prat",
  "slag",
  "tit",
  "twit",
  "blimey",
  "crikey",
  "cor",
  "flipping",
  "frigging",
  "blooming",
];

// ============================================================================
// Scan Result Types
// ============================================================================

export interface GuardrailMatch {
  keyword: string;
  count: number;
}

export interface GuardrailScanResult {
  matched: boolean;
  matches: GuardrailMatch[];
  eventType: string;
}

// ============================================================================
// Scanning Functions
// ============================================================================

/**
 * Scan text for blocked topics using case-insensitive word boundary matching.
 */
export function scanForTopics(
  text: string,
  blockedTopics: string[],
): GuardrailScanResult {
  const matches: GuardrailMatch[] = [];
  const lowerText = text.toLowerCase();

  for (const topic of blockedTopics) {
    const trimmed = topic.trim().toLowerCase();
    if (!trimmed) continue;
    // Use word boundary matching for multi-word topics
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "gi");
    const found = text.match(re);
    if (found && found.length > 0) {
      matches.push({ keyword: trimmed, count: found.length });
    }
  }

  return {
    matched: matches.length > 0,
    matches,
    eventType: "topic_blocked",
  };
}

/**
 * Scan text for competitor mentions using case-insensitive word boundary matching.
 */
export function scanForCompetitors(
  text: string,
  competitorNames: string[],
): GuardrailScanResult {
  const matches: GuardrailMatch[] = [];

  for (const name of competitorNames) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "gi");
    const found = text.match(re);
    if (found && found.length > 0) {
      matches.push({ keyword: trimmed.toLowerCase(), count: found.length });
    }
  }

  return {
    matched: matches.length > 0,
    matches,
    eventType: "competitor_detected",
  };
}

/**
 * Scan text for profanity using built-in list + optional custom words.
 */
export function scanForProfanity(
  text: string,
  customWords?: string[],
): GuardrailScanResult {
  const allWords = [...BUILTIN_PROFANITY];
  if (customWords) {
    for (const w of customWords) {
      const trimmed = w.trim().toLowerCase();
      if (trimmed && !allWords.includes(trimmed)) allWords.push(trimmed);
    }
  }

  const matches: GuardrailMatch[] = [];

  for (const word of allWords) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "gi");
    const found = text.match(re);
    if (found && found.length > 0) {
      matches.push({ keyword: word, count: found.length });
    }
  }

  return {
    matched: matches.length > 0,
    matches,
    eventType: "profanity_detected",
  };
}

/**
 * Redact matched keywords from text, replacing with [BLOCKED].
 */
export function redactGuardrailMatches(
  text: string,
  matches: GuardrailMatch[],
): string {
  let result = text;
  for (const m of matches) {
    const escaped = m.keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "gi");
    result = result.replace(re, "[BLOCKED]");
  }
  return result;
}
