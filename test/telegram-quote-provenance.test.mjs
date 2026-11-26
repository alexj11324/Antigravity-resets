import assert from "node:assert/strict";
import test from "node:test";
import { judgeResetTweet } from "../src/joint-judge.mjs";
import { formatConfirmedTelegramHtml, formatExpectedTelegramHtml } from "../src/x-webhook.mjs";

const tweet = {
  tweetId: "2130000000000000999",
  timestamp: "2026-11-26T18:00:00Z",
  authorHandle: "@_mohansolo",
  authorName: "Varun Mohan",
  text: "We've reset Gemini quota for all Antigravity users. Enjoy!",
  url: "https://x.com/_mohansolo/status/2130000000000000999",
};
const summary = { en: "AI interpretation of the official announcement." };
const watchedHandles = new Set(["_mohansolo"]);
const decisions = {
  answers: {
    is_quota_reset: { noul: 0.99 },
    is_active_now: { noul: 0.99 },
    needs_context_review: { noul: 0.01 },
    reset_type: { choice: "regular", confidence: 0.99 },
  },
};
const flash = {
  is_reset: true, reset_stage: "confirmed", needs_review: false,
  type: "regular", confidence: 0.99, models: ["Gemini"], summary_i18n: summary,
};

function modelFetch(mode) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const isDecisions = String(url).includes("/decisions");
    if ((mode === "flash-fallback" && isDecisions) ||
        (mode === "decisions-fallback" && !isDecisions)) {
      return new Response("unavailable", { status: 503 });
    }
    if (isDecisions) return Response.json(decisions);
    const response = body.model === "gemini-4-neon"
      ? { decision: "approve_banked", confidence: 0.99, models: ["Gemini"], summary_i18n: summary }
      : { ...flash, type: mode === "tier2" ? "banked" : "regular" };
    return Response.json({ steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(response) }] }] });
  };
}

for (const mode of ["normal", "tier2", "flash-fallback", "decisions-fallback", "heuristic"]) {
  test(`${mode} confirmed approval retains official quote independently of website summary`, async () => {
    const verdict = await judgeResetTweet(tweet, {
      watchedHandles,
      env: mode === "heuristic"
        ? { ALLOW_HEURISTIC_FALLBACK: "true" }
        : { GEMINI_API_KEY: "test_key", JOINT_JUDGE_MODE: "fallback" },
      fetchImpl: modelFetch(mode),
    });
    assert.equal(verdict.status, "approved");
    assert.equal(verdict.reset.quoteText, tweet.text);
    if (["normal", "tier2", "flash-fallback"].includes(mode)) {
      assert.equal(verdict.reset.summary.en, summary.en);
    }
    const html = formatConfirmedTelegramHtml(verdict.reset);
    assert.ok(html.includes(`<blockquote>${tweet.text}</blockquote>`));
    assert.ok(!html.includes(summary.en));
  });
}

test("short confirmation remains verbatim and never quotes its model explanation or parent", () => {
  const html = formatConfirmedTelegramHtml({
    ...tweet, quoteText: "Done", summary,
    parentTweet: { text: "Please reset quota", authorName: "Requester" },
  });
  assert.ok(html.includes("<blockquote>Done</blockquote>"));
  assert.ok(html.includes("Varun"));
  assert.ok(!html.includes(summary.en));
  assert.ok(!html.includes("Please reset quota"));
  assert.ok(html.includes(tweet.url));
});

test("confirmed, expected and update quotes escape HTML without introducing summary or attribution into source text", () => {
  const quoteText = "  Reset <all> & enjoy!\nExactly as posted.  ";
  const item = { ...tweet, quoteText, summary };
  const quote = "<blockquote>  Reset &lt;all&gt; &amp; enjoy!\nExactly as posted.  </blockquote>";
  assert.ok(formatConfirmedTelegramHtml(item).includes(quote));
  const expected = formatExpectedTelegramHtml({ ...item, updates: [{ ...item, quoteText: "Done" }] });
  assert.ok(expected.includes(quote));
  assert.ok(expected.includes("<blockquote>Done</blockquote>"));
  assert.ok(!expected.includes(summary.en));
});

test("missing original text never quotes summaries, invents text, or attributes an empty quote", () => {
  const item = { ...tweet, summary };
  for (const html of [formatConfirmedTelegramHtml(item), formatExpectedTelegramHtml({ ...item, updates: [item] })]) {
    assert.ok(!html.includes("<blockquote>"));
    assert.ok(!html.includes(summary.en));
    assert.ok(!html.includes("Varun"));
    assert.ok(html.includes(tweet.url));
  }
});

test("long source text and accumulated updates retain source links within Telegram's message limit", () => {
  const long = { ...tweet, quoteText: "A".repeat(5000), summary };
  for (const html of [formatConfirmedTelegramHtml(long), formatExpectedTelegramHtml({ ...tweet, quoteText: "Reset", updates: [long] })]) {
    assert.ok(html.length <= 4096);
    assert.ok(html.includes(tweet.url));
    assert.ok(!html.includes(summary.en));
    assert.ok(!html.includes("<blockquote>"), "Oversized quotes must be omitted, never rewritten or truncated");
  }
});
