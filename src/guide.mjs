// Long-form guide page: how Antigravity quota actually works, what a "reset"
// is, and how this tracker decides what counts. Server-rendered per locale so
// each language is independently indexable, which a client-side toggle is not.

import { copyFor, escapeHtml, jsonForScript, langUrl, SITE_ORIGIN, SITE_NAME } from "./seo-data.mjs";
import { buildOrganizationNode } from "./seo-jsonld.mjs";

// Bumped when the guide copy below changes. Kept next to the copy so a content
// edit and its schema date are one diff.
const GUIDE_MODIFIED = "2026-11-26";

const OG_LOCALE = { en: "en_US", "zh-CN": "zh_CN", "zh-TW": "zh_TW", ja: "ja_JP", ko: "ko_KR" };

const GUIDE_PATH = {
  en: "/guide",
  "zh-CN": "/zh-CN/guide",
  "zh-TW": "/zh-TW/guide",
  ja: "/ja/guide",
  ko: "/ko/guide",
};

const COPY = {
  en: {
    title: "How Antigravity quota and resets actually work",
    description:
      "A plain explanation of the Antigravity 5-hour window, the weekly cap, what an official reset is, and what this tracker does and does not track.",
    intro:
      "Antigravity does not expose a single countdown. Your remaining capacity comes from two overlapping clocks and, occasionally, from a manual push by the team. This page explains each piece so the numbers on the tracker make sense.",
    quickAnswer:
      "Antigravity quota is not one countdown. A rolling five-hour window refills automatically, a weekly cap can pause those refills, and an official reset is an unscheduled extra refill the Antigravity team announces on X. This tracker records only those announcements, never the automatic refreshes.",
    sections: [
      {
        h: "The 5-hour rolling window",
        p: "Paid Google AI Pro and Ultra plans refresh automatically on a rolling cycle of about five hours. Older usage ages out of the window and capacity returns, which is why the meter moves without anyone announcing anything. This automatic refresh is not what the tracker records: it happens on its own, every day, for every account.",
      },
      {
        h: "The weekly cap above it",
        p: "The rolling window sits underneath a broader weekly limit. Heavy multi-agent sessions can exhaust that weekly allowance early, and once it is gone the normal five-hour refreshes pause until the weekly timer rolls over or Google pushes an extra reset. If your meter has stopped moving, this is usually why.",
      },
      {
        h: "What an official reset is",
        p: "Every so often the Antigravity team grants an unscheduled refill: for a holiday, a model launch, an incident, or simply goodwill. Varun Mohan and the Antigravity team announce these on X first. The tracker records only these announcements: verified posts from the official accounts, with the original link, timestamp, and affected models.",
      },
      {
        h: "Banked resets",
        p: "A banked reset is a credit you save and redeem later rather than an immediate refill. Because it changes what your meter shows, the tracker labels it separately from a regular reset instead of treating both as the same event.",
      },
      {
        h: "Checking your own remaining quota",
        p: "Open the Antigravity CLI and run /usage or /quota for the interactive panel, or open Settings then Models inside the IDE. This tracker never touches your Google account: it reads public X posts only, so it can tell you what was announced but not what your personal meter says.",
      },
      {
        h: "How this tracker decides what counts",
        p: "A post is accepted only when an official account announces a broad reset that is live or explicitly scheduled. Teasers, polls, retrospectives, quota increases without a reset, routine explanations of the five-hour window, and one-on-one support replies are all rejected. Disagreements between the automated checks are escalated to a second model and then to a human.",
      },
      {
        h: "A worked example",
        p: "Suppose you exhaust the five-hour window at 09:00. Capacity returns gradually as that usage ages out, roughly five hours later, with no announcement and nothing to track. If the weekly cap is also exhausted, those automatic refills pause and the meter stays flat until the weekly timer rolls over. An official reset is the only event that changes that picture out of schedule, which is why the tracker records it and nothing else.",
      },
      {
        h: "What does not count as a reset",
        p: "A teaser, a poll asking whether you want a reset, a retrospective about a past reset, a quota increase that raises the ceiling without refilling usage, a routine explanation of the five-hour window, and a one-to-one support reply are all rejected. So is every automatic five-hour refresh, even though your meter moves. The only test is whether an official account announced an out-of-schedule refill that applies broadly.",
      },
      {
        h: "How the statistics are computed",
        p: "Average interval is the mean number of days between consecutive confirmed announcements, not between your personal refills. Longest wait is the largest gap on record. Both are computed from the verified archive only: rejected candidates and automatic refreshes never enter the calculation, so the numbers describe how often the team grants extra capacity, not how often your meter moves.",
      },
      {
        h: "Why your personal meter is not shown",
        p: "The tracker never asks for your Google account, so it cannot read your remaining quota. That is a deliberate limit: an alert service that could see your usage would need access it does not need. Use /usage or /quota in the CLI, or Settings then Models in the IDE, for the number that applies to you.",
      },
      {
        h: "Why resets are announced on X first",
        p: "Official resets are announced on X before anywhere else. That is the channel the Antigravity team actually uses, so it is also the fastest public signal available: the tracker reads those posts directly rather than waiting for documentation, release notes, or forum threads to catch up. When a post is ambiguous, the tracker waits for the follow-up instead of guessing.",
      },
    ],
    back: "Back to the live tracker",
  },
  "zh-CN": {
    title: "Antigravity 配额与重置机制说明",
    description:
      "讲清楚 Antigravity 的 5 小时滚动窗口、周上限、什么是官方重置，以及这个追踪器记录什么、不记录什么。",
    intro:
      "Antigravity 并没有一个统一的倒计时。你的剩余额度由两个重叠的时钟决定，偶尔还会因为团队的额外推送而变化。本页把每一部分拆开说明，这样追踪器上的数字才说得通。",
    quickAnswer:
      "Antigravity 的额度不是一个倒计时：约 5 小时的滚动窗口会自动恢复，之上的周上限可能让恢复暂停，而官方重置是团队在 X 上额外公布的、计划外的补充。本追踪器只记录这类公告，不记录每天自动发生的刷新。",
    sections: [
      {
        h: "5 小时滚动窗口",
        p: "付费的 Google AI Pro 与 Ultra 套餐按约 5 小时的滚动周期自动刷新。较早的使用量会滑出窗口，额度随之恢复，所以额度条会在没有任何公告的情况下自己上涨。这个自动刷新不是追踪器记录的内容：它每天、每个账号都会自然发生。",
      },
      {
        h: "之上还有周上限",
        p: "5 小时滚动窗口是建立在一个更宽的周额度之下的。高强度的多 agent 会话可能提前用光周额度，一旦耗尽，常规的 5 小时刷新会暂停，直到周计时器重置或 Google 额外推送一次重置。如果你的额度条长时间不动，通常就是这个原因。",
      },
      {
        h: "什么算官方重置",
        p: "Antigravity 团队偶尔会额外推送一次计划外的重置：节日、模型发布、故障补偿，或者单纯是善意。Varun Mohan 与 Antigravity 团队会先在 X 上公布。追踪器只记录这类公告：来自官方账号的已核实发帖，附带原帖链接、时间和受影响的模型。",
      },
      {
        h: "banked 重置",
        p: "banked 重置是一份可以存起来、之后再兑换的额度，而不是立即到账的补充。由于它改变的是你额度条上的数字，追踪器会把它与常规重置分开标注，而不是把两者当成同一件事。",
      },
      {
        h: "如何查看自己的剩余额度",
        p: "打开 Antigravity CLI 运行 /usage 或 /quota 查看交互面板，或在 IDE 中打开 Settings 里的 Models。本追踪器从不接触你的 Google 账号：它只读取公开的 X 发帖，所以它能告诉你官方公布了什么，但看不到你个人的额度条。",
      },
      {
        h: "追踪器如何判定",
        p: "只有官方账号宣布的、已经生效或明确排期的全局重置才会被接受。预告、投票、回顾、只提高额度上限而不重置用量、对 5 小时窗口的常规解释、以及一对一客服回复，都会被拒绝。自动判定出现分歧时，会升级到第二个模型，再交给人工复核。",
      },
      {
        h: "一个具体例子",
        p: "假设你在 09:00 用完 5 小时窗口的额度。随着这批用量在约 5 小时后滑出窗口，额度会逐步恢复，过程中没有任何公告，也没有什么可追踪的。如果周上限也已耗尽，这些自动恢复会暂停，额度条会一直不动，直到周计时器重置。官方重置是唯一能让这个局面提前改变的额外事件，所以追踪器只记录它。",
      },
      {
        h: "什么不算重置",
        p: "预告、询问是否想要重置的投票、对过去重置的回顾、只提高上限而不补充用量的额度上调、对 5 小时窗口的常规解释、以及一对一客服回复，都会被拒绝。每一次自动的 5 小时刷新也一样，即使你的额度条确实动了。判断标准只有一条：是否有官方账号宣布了一次适用于广泛用户的、计划外的补充。",
      },
      {
        h: "统计口径",
        p: "平均间隔是相邻两次已确认公告之间的平均天数，不是你自己额度恢复的间隔。最长等待是记录中最大的空档。两者都只基于已核实的档案计算：被拒绝的候选和自动刷新从不进入计算，所以这些数字描述的是团队额外发放额度的频率，而不是你的额度条多久动一次。",
      },
      {
        h: "为什么不显示你的个人额度",
        p: "追踪器从不索取你的 Google 账号，因此无法读取你的剩余额度。这是刻意的限制：一个能看到你用量的提醒服务，需要它本不需要的权限。要看属于你的数字，请在 CLI 里运行 /usage 或 /quota，或在 IDE 中打开 Settings 里的 Models。",
      },
      {
        h: "为什么重置总是先出现在 X 上",
        p: "官方重置总是先公布在 X 上。这是 Antigravity 团队实际使用的渠道，因此也是最快的公开信号：追踪器直接读取这些帖子，而不是等文档、发布说明或论坛帖子跟上。当一条帖子含义不明时，追踪器会等后续说明，而不是猜。",
      },
    ],
    back: "返回实时追踪页",
  },
  "zh-TW": {
    title: "Antigravity 配額與重置機制說明",
    description:
      "講清楚 Antigravity 的 5 小時滾動視窗、週上限、什麼是官方重置，以及這個追蹤器記錄什麼、不記錄什麼。",
    intro:
      "Antigravity 並沒有一個統一的倒數計時。你的剩餘額度由兩個重疊的時鐘決定，偶爾還會因為團隊的額外推送而改變。本頁把每一部分拆開說明，這樣追蹤器上的數字才說得通。",
    quickAnswer:
      "Antigravity 的額度不是一個倒數計時：約 5 小時的滾動視窗會自動恢復，之上的週上限可能讓恢復暫停，而官方重置是團隊在 X 上額外公布的、計畫外的補充。本追蹤器只記錄這類公告，不記錄每天自動發生的重新整理。",
    sections: [
      {
        h: "5 小時滾動視窗",
        p: "付費的 Google AI Pro 與 Ultra 方案按約 5 小時的滾動週期自動刷新。較早的使用量會滑出視窗，額度隨之恢復，所以額度條會在沒有任何公告的情況下自己上升。這個自動刷新不是追蹤器記錄的內容：它每天、每個帳號都會自然發生。",
      },
      {
        h: "之上還有週上限",
        p: "5 小時滾動視窗建立在一個更寬的週額度之下。高強度的多 agent 工作階段可能提前用光週額度，一旦耗盡，常規的 5 小時刷新會暫停，直到週計時器重置或 Google 額外推送一次重置。如果你的額度條長時間不動，通常就是這個原因。",
      },
      {
        h: "什麼算官方重置",
        p: "Antigravity 團隊偶爾會額外推送一次計畫外的重置：節日、模型發布、故障補償，或單純是善意。Varun Mohan 與 Antigravity 團隊會先在 X 上公布。追蹤器只記錄這類公告：來自官方帳號的已核實發文，附上原帖連結、時間與受影響的模型。",
      },
      {
        h: "banked 重置",
        p: "banked 重置是一份可以存起來、之後再兌換的額度，而不是立即到帳的補充。由於它改變的是你額度條上的數字，追蹤器會把它與常規重置分開標註，而不是把兩者當成同一件事。",
      },
      {
        h: "如何查看自己的剩餘額度",
        p: "開啟 Antigravity CLI 執行 /usage 或 /quota 查看互動面板，或在 IDE 中開啟 Settings 裡的 Models。本追蹤器從不接觸你的 Google 帳號：它只讀取公開的 X 發文，所以它能告訴你官方公布了什麼，但看不到你個人的額度條。",
      },
      {
        h: "追蹤器如何判定",
        p: "只有官方帳號宣布的、已經生效或明確排程的全局重置才會被接受。預告、投票、回顧、只提高額度上限而不重置用量、對 5 小時視窗的常規解釋、以及一對一客服回覆，都會被拒絕。自動判定出現分歧時，會升級到第二個模型，再交給人工複核。",
      },
      {
        h: "一個具體例子",
        p: "假設你在 09:00 用完 5 小時視窗的額度。隨著這批用量在約 5 小時後滑出視窗，額度會逐步恢復，過程中沒有任何公告，也沒有什麼可追蹤的。如果週上限也已耗盡，這些自動恢復會暫停，額度條會一直不動，直到週計時器重置。官方重置是唯一能讓這個局面提前改變的額外事件，所以追蹤器只記錄它。",
      },
      {
        h: "什麼不算重置",
        p: "預告、詢問是否想要重置的投票、對過去重置的回顧、只提高上限而不補充用量的額度上調、對 5 小時視窗的常規解釋、以及一對一客服回覆，都會被拒絕。每一次自動的 5 小時刷新也一樣，即使你的額度條確實動了。判斷標準只有一條：是否有官方帳號宣布了一次適用於廣泛使用者的、計畫外的補充。",
      },
      {
        h: "統計口徑",
        p: "平均間隔是相鄰兩次已確認公告之間的平均天數，不是你自己額度恢復的間隔。最長等待是紀錄中最大的空檔。兩者都只基於已核實的檔案計算：被拒絕的候選和自動刷新從不進入計算，所以這些數字描述的是團隊額外發放額度的頻率，而不是你的額度條多久動一次。",
      },
      {
        h: "為什麼不顯示你的個人額度",
        p: "追蹤器從不索取你的 Google 帳號，因此無法讀取你的剩餘額度。這是刻意的限制：一個能看到你用量的提醒服務，需要它本不需要的權限。要看屬於你的數字，請在 CLI 裡執行 /usage 或 /quota，或在 IDE 中開啟 Settings 裡的 Models。",
      },
      {
        h: "為什麼重置總是先出現在 X 上",
        p: "官方重置總是先公布在 X 上。這是 Antigravity 團隊實際使用的管道，因此也是最快的公開訊號：追蹤器直接讀取這些貼文，而不是等文件、發布說明或論壇貼文跟上。當一則貼文含義不明時，追蹤器會等後續說明，而不是猜。",
      },
    ],
    back: "返回即時追蹤頁",
  },
  ja: {
    title: "Antigravity のクォータとリセットの仕組み",
    description:
      "Antigravity の 5 時間ローリングウィンドウ、週上限、公式リセットとは何か、この追跡サイトが記録するもの・しないものを説明します。",
    intro:
      "Antigravity に単一のカウントダウンはありません。残量は重なり合う 2 つの時計と、ときどき行われるチームからの追加付与で決まります。このページで各部分を分けて説明するので、追跡サイトの数字が読めるようになります。",
    quickAnswer:
      "Antigravity のクォータは 1 つのカウントダウンではありません。約 5 時間のローリングウィンドウが自動で回復し、その上の週上限が回復を止めることがあり、公式リセットはチームが X で告知する予定外の追加付与です。この追跡サイトはその告知だけを記録します。",
    sections: [
      {
        h: "5 時間のローリングウィンドウ",
        p: "有料の Google AI Pro / Ultra プランは約 5 時間のローリング周期で自動更新されます。古い使用量がウィンドウから外れると容量が戻るため、告知がなくてもメーターは動きます。この自動更新は追跡対象ではありません。毎日すべてのアカウントで自然に起きるものです。",
      },
      {
        h: "その上にある週上限",
        p: "ローリングウィンドウは、より広い週上限の下にあります。マルチエージェントの重いセッションは週の割当を早く使い切り、使い切ると週のタイマーが戻るか Google が追加リセットを行うまで通常の 5 時間更新が止まります。メーターが動かないときは、たいていこれが理由です。",
      },
      {
        h: "公式リセットとは",
        p: "Antigravity チームはときどき、祝日・モデル公開・障害対応・あるいは善意で、予定外の追加リセットを行います。Varun Mohan と Antigravity チームはまず X でこれを告知します。追跡サイトが記録するのはこの告知だけです。公式アカウントの確認済み投稿で、元投稿リンク・時刻・対象モデルを伴うものです。",
      },
      {
        h: "banked リセット",
        p: "banked リセットは、すぐに補充されるのではなく、保存して後で引き換えるクレジットです。メーターの表示が変わるため、追跡サイトでは通常のリセットと同じ扱いにせず、別ラベルで記録します。",
      },
      {
        h: "自分の残量を確認する方法",
        p: "Antigravity CLI で /usage または /quota を実行するとインタラクティブなパネルが開きます。IDE では Settings の Models を開いてください。この追跡サイトはあなたの Google アカウントに一切アクセスしません。公開された X 投稿だけを読むため、公式の発表は分かりますが、あなた個人のメーターは分かりません。",
      },
      {
        h: "判定のしかた",
        p: "公式アカウントが、すでに有効か明確に予定された全体リセットを告知した場合のみ採用します。ティザー、投票、振り返り、リセットを伴わない上限引き上げ、5 時間ウィンドウの定型的な説明、1 対 1 のサポート返信はすべて却下します。自動判定が割れた場合は 2 つ目のモデルに、それでも決まらない場合は人間の確認に回します。",
      },
      {
        h: "具体例",
        p: "5 時間ウィンドウの割当を 09:00 に使い切ったとします。その使用量が約 5 時間かけてウィンドウから外れるにつれて容量は徐々に戻り、その間に告知はなく、追跡すべき出来事もありません。週上限も使い切っている場合、この自動回復は止まり、週のタイマーが戻るまでメーターは動きません。公式リセットは、この状況を予定外に変える唯一の出来事であり、追跡サイトが記録するのはそれだけです。",
      },
      {
        h: "リセットと見なされないもの",
        p: "ティーザー、リセットを望むか尋ねる投票、過去のリセットの振り返り、使用量を戻さず上限だけを上げる発表、5 時間ウィンドウの定型的な説明、1 対 1 のサポート返信は、すべて却下されます。自動の 5 時間更新も同様です。メーターが動いても記録しません。判断基準は 1 つだけです。公式アカウントが、広く適用される予定外の補充を告知したかどうか。",
      },
      {
        h: "統計の算出方法",
        p: "平均間隔は、連続する確認済み告知の間の平均日数であり、あなた個人の回復間隔ではありません。最長待機は記録上の最大の空白です。どちらも検証済みのアーカイブだけから計算します。却下された候補や自動更新は計算に入らないため、これらの数字はチームが追加容量を付与する頻度を表し、あなたのメーターが動く頻度ではありません。",
      },
      {
        h: "個人のメーターを表示しない理由",
        p: "追跡サイトは Google アカウントを要求しないため、残りの割当を読むことはできません。これは意図的な制限です。利用状況を見られる通知サービスは、本来不要な権限を必要としてしまいます。自分に適用される数字は、CLI の /usage または /quota、あるいは IDE の Settings > Models で確認してください。",
      },
      {
        h: "リセットが最初に X で告知される理由",
        p: "公式リセットは何より先に X で告知されます。Antigravity チームが実際に使っているチャネルであり、最も早い公開シグナルでもあります。追跡サイトはドキュメントやリリースノート、フォーラムが追いつくのを待たず、投稿を直接読みます。投稿が曖昧な場合は、推測せず続報を待ちます。",
      },
    ],
    back: "ライブ追跡ページへ戻る",
  },
  ko: {
    title: "Antigravity 할당량과 리셋의 동작 방식",
    description:
      "Antigravity 의 5시간 롤링 윈도우, 주간 상한, 공식 리셋이 무엇인지, 그리고 이 추적 사이트가 무엇을 기록하고 무엇을 기록하지 않는지 설명합니다.",
    intro:
      "Antigravity 에는 단일 카운트다운이 없습니다. 남은 용량은 겹치는 두 개의 시계와, 때때로 팀이 추가로 지급하는 리셋으로 결정됩니다. 이 페이지에서 각 부분을 나눠 설명하므로 추적 사이트의 숫자를 이해할 수 있습니다.",
    quickAnswer:
      "Antigravity 할당량은 하나의 카운트다운이 아닙니다. 약 5시간 롤링 윈도우가 자동으로 회복되고, 그 위의 주간 상한이 회복을 멈출 수 있으며, 공식 리셋은 팀이 X에서 알리는 예정에 없던 추가 지급입니다. 이 추적 사이트는 그 공지만 기록합니다.",
    sections: [
      {
        h: "5시간 롤링 윈도우",
        p: "유료 Google AI Pro / Ultra 요금제는 약 5시간의 롤링 주기로 자동 갱신됩니다. 오래된 사용량이 윈도우에서 빠지면 용량이 돌아오기 때문에, 아무 공지가 없어도 미터가 움직입니다. 이 자동 갱신은 추적 대상이 아닙니다. 매일 모든 계정에서 자연스럽게 일어나는 일입니다.",
      },
      {
        h: "그 위에 있는 주간 상한",
        p: "롤링 윈도우는 더 넓은 주간 한도 아래에 있습니다. 멀티 에이전트 세션을 많이 돌리면 주간 할당을 일찍 소진할 수 있고, 소진되면 주간 타이머가 돌아오거나 Google 이 추가 리셋을 지급할 때까지 일반적인 5시간 갱신이 멈춥니다. 미터가 멈춰 있다면 대개 이 때문입니다.",
      },
      {
        h: "공식 리셋이란",
        p: "Antigravity 팀은 때때로 예정에 없던 리셋을 지급합니다. 공휴일, 모델 출시, 장애 대응, 또는 단순한 호의일 수 있습니다. Varun Mohan 과 Antigravity 팀은 이를 먼저 X 에 알립니다. 추적 사이트는 이 공지만 기록합니다. 공식 계정의 확인된 게시물과 원문 링크, 시각, 대상 모델을 함께 남깁니다.",
      },
      {
        h: "banked 리셋",
        p: "banked 리셋은 즉시 충전되는 것이 아니라 저장했다가 나중에 사용하는 크레딧입니다. 미터 표시가 달라지므로 추적 사이트는 이를 일반 리셋과 같은 사건으로 취급하지 않고 별도로 표시합니다.",
      },
      {
        h: "내 남은 할당량 확인",
        p: "Antigravity CLI 에서 /usage 또는 /quota 를 실행하면 대화형 패널이 열립니다. IDE 에서는 Settings 의 Models 를 여세요. 이 추적 사이트는 귀하의 Google 계정에 접근하지 않습니다. 공개된 X 게시물만 읽기 때문에 공식 발표는 알 수 있지만 개인 미터는 알 수 없습니다.",
      },
      {
        h: "판정 방식",
        p: "공식 계정이 이미 적용되었거나 명확히 예정된 전체 리셋을 발표한 경우에만 채택합니다. 티저, 투표, 회고, 리셋 없이 상한만 올리는 발표, 5시간 윈도우에 대한 정형 설명, 1 대 1 지원 답변은 모두 거부합니다. 자동 판정이 갈리면 두 번째 모델로, 그래도 갈리면 사람이 검토합니다.",
      },
      {
        h: "구체적인 예",
        p: "5시간 윈도우의 할당량을 09:00에 모두 썼다고 가정해 봅시다. 그 사용량이 약 5시간에 걸쳐 윈도우에서 빠지면서 용량이 서서히 돌아오고, 그동안 어떤 공지도 없으며 추적할 사건도 없습니다. 주간 상한까지 소진했다면 이 자동 회복은 멈추고, 주간 타이머가 돌아올 때까지 미터는 움직이지 않습니다. 공식 리셋은 이 상황을 예정에 없이 바꾸는 유일한 사건이며, 추적 사이트는 그것만 기록합니다.",
      },
      {
        h: "리셋으로 보지 않는 것",
        p: "티저, 리셋을 원하는지 묻는 투표, 과거 리셋 회고, 사용량은 되돌리지 않고 상한만 올리는 발표, 5시간 윈도우에 대한 정형 설명, 1대1 지원 답변은 모두 거부됩니다. 자동 5시간 갱신도 마찬가지입니다. 미터가 움직여도 기록하지 않습니다. 판단 기준은 하나입니다. 공식 계정이 널리 적용되는 예정에 없던 보충을 알렸는가.",
      },
      {
        h: "통계 계산 방식",
        p: "평균 간격은 연속된 확인된 공지 사이의 평균 일수이며, 개인의 회복 간격이 아닙니다. 최장 대기는 기록상 가장 큰 공백입니다. 둘 다 검증된 아카이브만으로 계산합니다. 거부된 후보와 자동 갱신은 계산에 들어가지 않으므로, 이 숫자는 팀이 추가 용량을 지급하는 빈도를 뜻하며 미터가 움직이는 빈도가 아닙니다.",
      },
      {
        h: "개인 미터를 표시하지 않는 이유",
        p: "추적 사이트는 Google 계정을 요구하지 않으므로 남은 할당량을 읽을 수 없습니다. 이는 의도된 제한입니다. 사용량을 볼 수 있는 알림 서비스는 필요 없는 권한을 요구하게 됩니다. 내게 적용되는 숫자는 CLI의 /usage 또는 /quota, 또는 IDE의 Settings > Models에서 확인하세요.",
      },
      {
        h: "리셋이 가장 먼저 X에 올라오는 이유",
        p: "공식 리셋은 무엇보다 먼저 X에서 공지됩니다. Antigravity 팀이 실제로 사용하는 채널이자 가장 빠른 공개 신호입니다. 추적 사이트는 문서나 릴리스 노트, 포럼이 따라올 때까지 기다리지 않고 게시물을 직접 읽습니다. 게시물이 모호하면 추측하지 않고 후속 설명을 기다립니다.",
      },
    ],
    back: "실시간 추적 페이지로 돌아가기",
  },
};

/**
 * Markdown mirror of a guide page, so an agent that asks for the alternates
 * gets this page's own content instead of the homepage mirror.
 * @param {string} lang
 * @returns {string}
 */
export function renderGuideMarkdown(lang) {
  const copy = COPY[lang] || COPY.en;
  const canonical = `${SITE_ORIGIN}${GUIDE_PATH[lang] || GUIDE_PATH.en}`;
  return [
    `# ${copy.title}`,
    "",
    copy.intro,
    "",
    `> ${copy.quickAnswer}`,
    "",
    ...copy.sections.flatMap((section) => [`## ${section.h}`, "", section.p, ""]),
    `[${copy.back}](${canonical})`,
    "",
  ].join("\n");
}

/**
 * @param {string} pathname
 * @returns {string} locale code for a guide path
 */
function guideLang(pathname) {
  for (const [code, path] of Object.entries(GUIDE_PATH)) {
    if (path === pathname) return code;
  }
  return "en";
}

function alternates() {
  return [
    ...Object.entries(GUIDE_PATH).map(
      ([code, path]) => `<link rel="alternate" hreflang="${code}" href="${SITE_ORIGIN}${path}" />`,
    ),
    `<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}/guide" />`,
  ].join("");
}

/**
 * @param {Request} request
 * @param {object} env
 * @param {string} pathname
 */
export function handleGuideRequest(request, env, pathname) {
  const lang = guideLang(pathname);
  const copy = COPY[lang] || COPY.en;
  const canonical = `${SITE_ORIGIN}${GUIDE_PATH[lang]}`;
  const home = langUrl(lang);

  const body = copy.sections
    .map(
      (section) =>
        `<section class="section-block"><h2 class="section-title">${escapeHtml(section.h)}</h2><p class="section-sub">${escapeHtml(section.p)}</p></section>`,
    )
    .join("");

  const article = {
    "@context": "https://schema.org",
    "@graph": [
      buildOrganizationNode(),
      {
        "@type": "Article",
        "@id": `${canonical}#article`,
        headline: copy.title,
        description: copy.description,
        inLanguage: lang,
        url: canonical,
        mainEntityOfPage: canonical,
        image: `${SITE_ORIGIN}/og-image.jpg`,
        datePublished: "2026-11-26",
        dateModified: GUIDE_MODIFIED,
        isAccessibleForFree: true,
        author: { "@id": `${SITE_ORIGIN}/#organization` },
        publisher: { "@id": `${SITE_ORIGIN}/#organization` },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: SITE_NAME,
            item: `${SITE_ORIGIN}${lang === "en" ? "/" : `/${lang}`}`,
          },
          { "@type": "ListItem", position: 2, name: copy.title, item: canonical },
        ],
      },
    ],
  };

  const html = `<!doctype html>
<html lang="${lang}" data-theme="light">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(copy.title)} &mdash; ${escapeHtml(SITE_NAME)}</title>
    <meta name="description" content="${escapeHtml(copy.description)}" />
    <meta name="robots" content="index,follow,max-image-preview:large" />
    <link rel="canonical" href="${canonical}" />
    ${alternates()}
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />
    <meta property="og:title" content="${escapeHtml(copy.title)}" />
    <meta property="og:description" content="${escapeHtml(copy.description)}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${SITE_ORIGIN}/og-image.jpg" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:locale" content="${OG_LOCALE[lang] || "en_US"}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content="${SITE_ORIGIN}/og-image.jpg" />
    <link rel="icon" type="image/png" sizes="256x256" href="/favicon.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/manifest.json" />
    <script type="application/ld+json">${jsonForScript(article)}</script>
    <link rel="alternate" type="application/rss+xml" title="Antigravity Resets RSS" href="${SITE_ORIGIN}/feed.xml" />
    <link rel="alternate" type="text/markdown" title="Markdown" href="${SITE_ORIGIN}${lang === "en" ? "/guide.md" : `/${lang}/guide.md`}" />
    <link rel="preload" href="/fonts/fredoka-latin.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="preload" href="/fonts/plus-jakarta-sans-latin.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <div class="page">
      <header class="top-header">
        <div class="brand-group">
          <div class="avatar-ring">
            <img src="/assets/varun-avatar.webp" alt="Varun Mohan" width="52" height="52" />
          </div>
          <a class="brand-title" href="${home}" style="text-decoration:none;color:inherit">${escapeHtml(SITE_NAME)}</a>
        </div>
      </header>
      <main>
        <h1 class="section-title" style="font-size:2rem;margin:18px 0 12px">${escapeHtml(copy.title)}</h1>
        <p class="section-sub" style="font-size:1.0625rem">${escapeHtml(copy.intro)}</p>
        <p class="guide-answer">${escapeHtml(copy.quickAnswer)}</p>
        ${body}
        <p><a class="text-link" href="${home}">${escapeHtml(copy.back)} &rarr;</a></p>
      </main>
      <footer class="site-footer">
        <p class="footer-disclaimer">${escapeHtml(copyFor(lang).footerDisclaimer || "")}</p>
        <nav class="footer-links" aria-label="Related pages">
          <a class="text-link" href="${home}">${escapeHtml(SITE_NAME)}</a>
          <span aria-hidden="true">&middot;</span>
          <a class="text-link" href="/api-docs">API</a>
          <span aria-hidden="true">&middot;</span>
          <a class="text-link" href="/llms.txt">llms.txt</a>
          <span aria-hidden="true">&middot;</span>
          <a class="text-link" href="/about">About</a>
          <span aria-hidden="true">&middot;</span>
          <a class="text-link" href="/privacy">Privacy</a>
        </nav>
      </footer>
    </div>
  </body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Language": lang,
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}

/**
 * Serve the Markdown mirror of a guide page.
 * @param {string} lang
 * @returns {Response}
 */
export function handleGuideMarkdownRequest(lang) {
  const resolved = GUIDE_PATH[lang] ? lang : "en";
  return new Response(renderGuideMarkdown(resolved), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Language": resolved,
      "X-Robots-Tag": "noindex",
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}

export { GUIDE_PATH };
