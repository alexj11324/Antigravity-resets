// Parses official X Activity (`post.create`), flat X v2, and legacy v1.1 Account Activity
// webhook payloads, preserving separate parent-reply (`replied_to`) and quoted (`quoted`)
// tweet contexts and classifying official Antigravity quota reset announcements (`regular` vs `banked`).

const DEFAULT_WATCHED = ["_mohansolo", "_anshulr", "antigravity"];

const RESET_VERB_RE = /\b(reset|resetting|refreshed|refreshing|cleared|clearing|refilled|topped up|wiped)\b/i;
const QUOTA_NOUN_RE = /\b(quota|quotas|limit|limits|usage|bucket|buckets|throttle|throttles|rate limit|cap|caps|allowance|credits?)\b/i;
const BANKED_RE = /\b(banked\s+reset|banked\s+quota|claimable\s+reset|redeem\s+(your\s+)?reset)\b/i;
const QUESTION_NEGATION_RE = /\b(did\s+(antigravity|we)\s+reset|when\s+does|not\s+resetting|no\s+reset|in the works)\b/i;

const MODEL_PATTERNS = [
  { label: "Gemini 4 Carbon", re: /\bcarbon\b/i },
  { label: "Gemini 4 Neon", re: /\bneon\b/i },
  { label: "Gemini 4 Hydrogen", re: /\bhydrogen\b/i },
  { label: "Gemini 4 Argon", re: /\bargon\b/i },
  { label: "Gemini 3.8 Flash", re: /\b3\.8\s*flash\b/i },
];

export function parseWatchedHandles(envValue) {
  if (!envValue || typeof envValue !== "string") {
    return new Set(DEFAULT_WATCHED);
  }
  const parsed = envValue
    .split(",")
    .map((s) => s.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  return new Set(parsed.length > 0 ? parsed : DEFAULT_WATCHED);
}

function unwrapIncludeItem(item) {
  if (!item || typeof item !== "object") return null;
  if (item.data && typeof item.data === "object" && !Array.isArray(item.data)) {
    return item.data;
  }
  return item;
}

function buildIncludeMaps(...includeSources) {
  const usersById = new Map();
  const tweetsById = new Map();

  for (const inc of includeSources) {
    if (!inc || typeof inc !== "object") continue;
    if (Array.isArray(inc.users)) {
      for (const rawUser of inc.users) {
        const u = unwrapIncludeItem(rawUser);
        if (u?.id != null) usersById.set(String(u.id), u);
      }
    }
    if (Array.isArray(inc.tweets)) {
      for (const rawTweet of inc.tweets) {
        const t = unwrapIncludeItem(rawTweet);
        if (t?.id != null) tweetsById.set(String(t.id), t);
      }
    }
  }

  return { usersById, tweetsById };
}

function formatHandle(raw) {
  if (!raw || typeof raw !== "string") return null;
  const clean = raw.trim().replace(/^@/, "");
  return clean ? `@${clean}` : null;
}

function buildTweetUrl(handle, tweetId) {
  if (!tweetId) return null;
  const clean = handle ? handle.replace(/^@/, "") : null;
  return clean
    ? `https://x.com/${clean}/status/${tweetId}`
    : `https://x.com/i/web/status/${tweetId}`;
}

function resolveReferencedTweet(refId, tweetsById, usersById) {
  if (!refId) return null;
  const raw = tweetsById.get(String(refId));
  if (!raw) return null;

  const tweetId = raw.id != null ? String(raw.id) : String(refId);
  const authorObj =
    (raw.author_id != null ? usersById.get(String(raw.author_id)) : null) ||
    unwrapIncludeItem(raw.author) ||
    {};
  const authorHandle = formatHandle(authorObj.username || raw.author_handle || null);
  const authorName = authorObj.name || authorHandle || null;
  const text = String(raw.note_tweet?.text || raw.text || "").trim();

  return {
    tweetId,
    authorHandle,
    authorName,
    text,
    url: buildTweetUrl(authorHandle, tweetId),
  };
}

function parseV2PostObject(
  item,
  { usersById, tweetsById, knownAuthorsById = new Map(), eventUuid = null, requireComplete = false } = {},
) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return {
      tweet: null,
      skippedRetweet: false,
      error: requireComplete
        ? {
            eventType: "post.create",
            eventUuid,
            reason: "missing_or_invalid_payload",
            missingFields: ["payload"],
          }
        : null,
    };
  }

  const refs = Array.isArray(item.referenced_tweets) ? item.referenced_tweets : [];
  if (refs.some((r) => r?.type === "retweeted")) {
    return { tweet: null, skippedRetweet: true, error: null };
  }

  const id = item.id != null && String(item.id).trim() ? String(item.id).trim() : null;
  const text = String(item.note_tweet?.text || item.text || "").trim();
  const authorId = item.author_id != null ? String(item.author_id) : null;
  const user =
    (authorId ? usersById.get(authorId) : null) ||
    unwrapIncludeItem(item.author) ||
    {};
  // X author expansions are optional. Only the post's author ID can select a
  // known identity; the subscription filter must never supply that identity.
  const knownAuthor = authorId ? knownAuthorsById.get(authorId) : null;
  const authorHandle = formatHandle(user.username || item.author_handle || knownAuthor?.username || null);

  if (!id || !text || !authorHandle) {
    const missingFields = [];
    if (!id) missingFields.push("id");
    if (!text) missingFields.push("text");
    if (!authorHandle) missingFields.push("author_username");
    return {
      tweet: null,
      skippedRetweet: false,
      error: requireComplete
        ? {
            eventType: "post.create",
            eventUuid,
            reason: "unparseable_post_create",
            missingFields,
            tweetId: id,
            authorId,
            hasIncludesUsers: usersById.size > 0,
            hasIncludesTweets: tweetsById.size > 0,
          }
        : null,
    };
  }

  // Resolve replied-to parent tweet and quoted tweet completely separately.
  const repliedRef = refs.find((r) => r?.type === "replied_to");
  const replyToTweetId = repliedRef?.id
    ? String(repliedRef.id)
    : item.in_reply_to_tweet_id != null
      ? String(item.in_reply_to_tweet_id)
      : null;
  const isReply = Boolean(replyToTweetId || item.in_reply_to_user_id != null);
  const parentTweet = resolveReferencedTweet(replyToTweetId, tweetsById, usersById);

  const replyUser =
    item.in_reply_to_user_id != null
      ? usersById.get(String(item.in_reply_to_user_id))
      : null;
  const replyToHandle =
    parentTweet?.authorHandle || formatHandle(replyUser?.username || null);

  const quotedRef = refs.find((r) => r?.type === "quoted");
  const quotedTweetId = quotedRef?.id ? String(quotedRef.id) : null;
  const quotedTweet = resolveReferencedTweet(quotedTweetId, tweetsById, usersById);

  const cleanHandle = authorHandle.replace(/^@/, "");
  const timestamp = item.created_at
    ? new Date(item.created_at).toISOString()
    : new Date().toISOString();

  return {
    tweet: {
      tweetId: id,
      eventUuid,
      authorHandle,
      authorName: user.name || knownAuthor?.name || authorHandle,
      text,
      timestamp,
      isReply,
      replyToTweetId,
      replyToHandle,
      parentTweet,
      quotedTweetId,
      quotedTweet,
      quotedAuthor: quotedTweet?.authorHandle || null,
      quotedText: quotedTweet?.text || null,
      url: `https://x.com/${cleanHandle}/status/${id}`,
    },
    skippedRetweet: false,
    error: null,
  };
}

function isActivityEnvelope(obj) {
  return Boolean(
    obj &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      typeof obj.event_type === "string" &&
      obj.event_type.trim().length > 0,
  );
}

/**
 * Parses an incoming X webhook JSON payload and returns extracted tweets plus
 * structured diagnostics for any declared `post.create` event that could not be parsed.
 */
export function parseWebhookPayload(payload, { knownAuthorsById = new Map() } = {}) {
  if (!payload || typeof payload !== "object") {
    return { eventType: "other", tweets: [], skippedRetweets: 0, errors: [] };
  }

  const tweets = [];
  const errors = [];
  let skippedRetweets = 0;
  let eventType = "other";

  // 1. Official X Activity API envelope(s):
  //    { data: { event_type: "post.create", payload: {...}, includes: {...} } }
  //    Also supports batched arrays of envelopes or top-level envelopes.
  const activityEnvelopes = [];
  if (isActivityEnvelope(payload)) {
    activityEnvelopes.push(payload);
  } else if (isActivityEnvelope(payload.data)) {
    activityEnvelopes.push(payload.data);
  } else if (
    Array.isArray(payload.data) &&
    payload.data.some((entry) => isActivityEnvelope(entry))
  ) {
    for (const entry of payload.data) {
      if (isActivityEnvelope(entry)) {
        activityEnvelopes.push(entry);
      }
    }
  }

  if (activityEnvelopes.length > 0) {
    const types = Array.from(new Set(activityEnvelopes.map((e) => e.event_type)));
    eventType = types.includes("post.create") ? "post.create" : types[0] || "activity";

    for (const envItem of activityEnvelopes) {
      if (envItem.event_type !== "post.create") continue;
      const eventUuid = envItem.event_uuid != null ? String(envItem.event_uuid) : null;
      const { usersById, tweetsById } = buildIncludeMaps(
        envItem.includes,
        payload.includes,
      );
      const parsed = parseV2PostObject(envItem.payload, {
        usersById,
        tweetsById,
        knownAuthorsById,
        eventUuid,
        requireComplete: true,
      });
      if (parsed.skippedRetweet) {
        skippedRetweets += 1;
      } else if (parsed.error) {
        errors.push(parsed.error);
      } else if (parsed.tweet) {
        tweets.push(parsed.tweet);
      }
    }

    return { eventType, tweets, skippedRetweets, errors };
  }

  // 2. Legacy v1.1 Account Activity API (`tweet_create_events`)
  if (Array.isArray(payload.tweet_create_events)) {
    eventType = "tweet_create_events";
    for (const tw of payload.tweet_create_events) {
      if (!tw) continue;
      if (tw.retweeted_status) {
        skippedRetweets += 1;
        continue;
      }
      const handle = formatHandle(tw.user?.screen_name || null);
      const text = String(tw.extended_tweet?.full_text || tw.full_text || tw.text || "").trim();
      const id = tw.id_str || (tw.id != null ? String(tw.id) : null);
      if (!id || !handle || !text) continue;

      const cleanHandle = handle.replace(/^@/, "");
      const replyToTweetId = tw.in_reply_to_status_id_str
        ? String(tw.in_reply_to_status_id_str)
        : null;
      const replyToHandle = formatHandle(tw.in_reply_to_screen_name || null);

      const quoted = tw.quoted_status || null;
      const quotedId = quoted?.id_str || (quoted?.id != null ? String(quoted.id) : null);
      const quotedAuthor = formatHandle(quoted?.user?.screen_name || null);
      const quotedText = quoted
        ? String(quoted.extended_tweet?.full_text || quoted.full_text || quoted.text || "").trim()
        : "";
      const quotedTweet =
        quoted && quotedText
          ? {
              tweetId: quotedId,
              authorHandle: quotedAuthor,
              authorName: quoted.user?.name || quotedAuthor || null,
              text: quotedText,
              url: buildTweetUrl(quotedAuthor, quotedId),
            }
          : null;

      tweets.push({
        tweetId: id,
        eventUuid: null,
        authorHandle: handle,
        authorName: tw.user?.name || handle,
        text,
        timestamp: tw.created_at
          ? new Date(tw.created_at).toISOString()
          : new Date().toISOString(),
        isReply: Boolean(replyToTweetId || tw.in_reply_to_user_id_str),
        replyToTweetId,
        replyToHandle,
        parentTweet: null,
        quotedTweetId: quotedId,
        quotedTweet,
        quotedAuthor: quotedTweet?.authorHandle || quotedAuthor || null,
        quotedText: quotedTweet?.text || null,
        url: `https://x.com/${cleanHandle}/status/${id}`,
      });
    }
  }

  // 3. Flat X v2 payload (`data` as single tweet object or array of tweet objects + top-level `includes`)
  const v2Items = Array.isArray(payload.data)
    ? payload.data.filter((item) => item && typeof item === "object" && !isActivityEnvelope(item))
    : payload.data &&
        typeof payload.data === "object" &&
        !isActivityEnvelope(payload.data) &&
        (payload.data.text || payload.data.note_tweet?.text)
      ? [payload.data]
      : [];

  if (v2Items.length > 0) {
    if (eventType === "other") eventType = "v2_data";
    const { usersById, tweetsById } = buildIncludeMaps(payload.includes);
    for (const item of v2Items) {
      const parsed = parseV2PostObject(item, {
        usersById,
        tweetsById,
        requireComplete: false,
      });
      if (parsed.skippedRetweet) {
        skippedRetweets += 1;
      } else if (parsed.tweet) {
        tweets.push(parsed.tweet);
      }
    }
  }

  return { eventType, tweets, skippedRetweets, errors };
}

export function extractTweetsFromWebhookPayload(payload) {
  return parseWebhookPayload(payload).tweets;
}

export function classifyResetTweet(tweet, watchedHandles = new Set(DEFAULT_WATCHED)) {
  if (!tweet || !tweet.text || !tweet.authorHandle) return null;
  const normalizedHandle = tweet.authorHandle.replace(/^@/, "").toLowerCase();
  if (!watchedHandles.has(normalizedHandle)) return null;
  if (tweet.isReply && tweet.replyToHandle) {
    const replyTo = tweet.replyToHandle.replace(/^@/, "").toLowerCase();
    if (!watchedHandles.has(replyTo)) return null;
  }

  const text = tweet.text;
  if (QUESTION_NEGATION_RE.test(text)) return null;
  if (!RESET_VERB_RE.test(text) || !QUOTA_NOUN_RE.test(text)) return null;

  const models = MODEL_PATTERNS.filter((m) => m.re.test(text)).map((m) => m.label);
  const type = BANKED_RE.test(text) ? "banked" : "regular";

  return {
    id: `x-${tweet.tweetId}`,
    tweetId: tweet.tweetId,
    timestamp: tweet.timestamp,
    type,
    authorHandle: tweet.authorHandle,
    authorName: tweet.authorName,
    models: models.length > 0 ? models : ["Gemini"],
    url: tweet.url,
    summary: { en: text },
    thanksCount: 0,
    source: "x_webhook",
  };
}
