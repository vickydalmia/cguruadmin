/**
 * Google Ads generator — every validation limit, default and fixed value in
 * one place, plus the request/response contract shared by the admin settings
 * page and the server module (`src/ads-generator/`).
 *
 * Bundled into the admin panel, so it imports types only. Values
 * marked "TBD" are placeholders until the business decisions are made; change
 * them here, nothing else needs to move.
 *
 * Mounted on the ADMIN router at `/ads-generator` (no `/api` segment) behind
 * `admin::isAuthenticatedAdmin` + `global::ads-generator-manage-only`.
 */
import type { GenerationJob } from './ai-generation';

export const ADS_GENERATOR_ROUTE_PREFIX = '/ads-generator';

/**
 * Assignable RBAC action: Settings → Roles → <role> → Settings →
 * "Generate Google Ads". Registered in src/index.ts `register` (never
 * bootstrap, or grants are wiped on restart). Super Admins always pass.
 */
export const ADS_GENERATOR_ACTION = 'admin::ads-generator.generate';
export const ADS_GENERATOR_ACTION_ATTRIBUTES = {
  section: 'settings',
  displayName: 'Generate Google Ads',
  uid: 'ads-generator.generate',
  pluginName: 'admin',
  category: 'marketing',
  subCategory: 'ads generator',
} as const;

/** Bump whenever the system prompt, user prompt template or output shape changes. */
export const ADS_PROMPT_VERSION = 'ads-v8';
export const ADS_ARABIC_PROMPT_VERSION = 'ads-ar-v1';

/**
 * Two ways to write copy, chosen per campaign in the form:
 *  - evergreen: true on any day. No numbers, codes, dates or events; built
 *    from brand categories and approved CouponzGuru claims.
 *  - offer: names the current offer from Offer details. Goes stale when the
 *    offer changes; regenerate then.
 */
export const ADS_AD_TYPES = ['evergreen', 'offer'] as const;
export type AdsAdType = (typeof ADS_AD_TYPES)[number];

/**
 * Optional freshness and trust terms (business decision, 30 Oct 2026): used
 * in SOME lines where natural, never required, capped against stuffing. Both
 * ad types. They are CLAIMS: keep this list to what is true for
 * every store, because Google can disapprove misleading ads.
 */
export const ADS_TRUST_TERMS = ['Today', 'Live Now', 'Working', 'Manually Verified'] as const;

/**
 * The statements behind ADS_TRUST_TERMS, sent to the model as approved
 * evidence (both ad types). Add other CouponzGuru claims only if true for
 * every store, e.g. 'Free to use'.
 */
export const ADS_APPROVED_SITE_CLAIMS: readonly string[] = [
  'CouponzGuru coupons and codes are manually verified by our team.',
  'Listed coupon codes are working and live now.',
  'Coupons and deals are updated every day, so "Today" is accurate.',
];

// ── Account (TBD: one fixed account until account selection exists) ──
export const ADS_ACCOUNT_CURRENCY = 'INR';

// ── Form limits ──
export const ADS_FORM_LIMITS = {
  /** Campaigns in one generation run. Each one counts against the usage limits. */
  campaignsMax: 10,
  campaignNameMax: 100,
  brandNameMax: 60,
  labelMax: 80,
  landingPageMax: 500,
  offerDetailsMax: 1500,
  brandCategoriesMax: 10,
  brandCategoryNameMax: 40,
  countriesMax: 20,
  countryNameMax: 60,
  negativeListsMax: 10,
  negativeListNameMax: 100,
  // TBD: budget/CPA bounds in ADS_ACCOUNT_CURRENCY.
  dailyBudgetMin: 100,
  dailyBudgetMax: 100_000,
  targetCpaMin: 1,
  targetCpaMax: 10_000,
  /** Google: -100 (exclude device) or -90..+900 percent. */
  deviceAdjustmentMin: -90,
  deviceAdjustmentMax: 900,
  deviceAdjustmentExclude: -100,
} as const;

/**
 * Landing pages must be on one of our CouponzGuru storefronts (any country,
 * so one admin can generate ads for every site). Exact hostnames, no wildcard:
 * cms./media./events./beta. subdomains are not ad destinations.
 */
export const ADS_ALLOWED_LANDING_DOMAINS = [
  'couponzguru.com', // India
  'couponzguru.ae', // UAE
  'couponzguruusa.com', // USA
  'couponzguru.sg', // Singapore
  'couponzguru.my', // Malaysia
  'couponzguru.ph', // Philippines
] as const;

export const ADS_ALLOWED_LANDING_HOSTS: readonly string[] = ADS_ALLOWED_LANDING_DOMAINS.flatMap(
  (domain) => [domain, `www.${domain}`],
);

/**
 * Text that has no business in an ad brief. A match blocks the request before
 * any OpenAI call (cheap prompt-injection / off-topic guard; lower-cased match).
 */
export const ADS_BLOCKED_INPUT_PATTERNS = [
  'ignore previous',
  'ignore all',
  'ignore the above',
  'disregard',
  'system prompt',
  'you are now',
  'act as',
  'pretend to',
  'jailbreak',
  'developer mode',
  '```',
  '<script',
  '{{',
  '}}',
] as const;

// ── OpenAI call limits ──
export const ADS_LLM_LIMITS = {
  /**
   * Defaults; override with ADS_GENERATOR_MAX_OUTPUT_TOKENS / ADS_GENERATOR_TIMEOUT_MS.
   * The output cap INCLUDES hidden reasoning tokens: at high effort a small cap
   * is spent on thinking and no JSON is written. It is a ceiling, not a charge.
   */
  maxOutputTokens: 16_000,
  timeoutMs: 180_000,
  /** Repair calls after the first attempt fails validation (total calls = 1 + this). */
  maxRepairAttempts: 2,
  /** Per admin user, rolling hour. Default only: override with ADS_GENERATOR_MAX_REQUESTS_PER_USER_PER_HOUR. */
  maxRequestsPerUserPerHour: 30,
  /** Whole instance, per UTC day. Default only: override with ADS_GENERATOR_MAX_REQUESTS_PER_DAY. */
  maxRequestsPerDay: 100,
  /** Identical form within this window returns the cached result, no new call. */
  resultCacheMs: 10 * 60_000,
  /** Finished background jobs stay readable this long (in memory). */
  jobRetentionMs: 30 * 60_000,
  /** How often the settings page polls a running job. */
  jobPollMs: 3_000,
  /** Campaigns of one batch generated at the same time. */
  batchConcurrency: 3,
} as const;

// ── Creative rules (checked in code after the model answers) ──
export const ADS_CREATIVE_RULES = {
  /** One responsive search ad per campaign. */
  adCount: 1,
  headlineCount: 10,
  descriptionCount: 4,
  // TBD: Google itself only requires <= 30; the kit asks for >= 24.
  headlineMin: 24,
  headlineMax: 30,
  descriptionMin: 72,
  descriptionMax: 90,
  headline1Intents: ['coupon', 'promo', 'discount'],
  /** Full brand name in at least this many of the 10 headlines, per ad (revision 3). Blocking. */
  minBrandHeadlines: 5,
} as const;

/**
 * Editorial limits (per ad) from the 30 Oct 2026 prompt revision. A breach
 * triggers a repair call; if it survives the repair budget the CSV is still
 * produced and the issue is shown to the reviewer as a warning.
 */
export const ADS_EDITORIAL_RULES = {
  /** Above this, review for needless repetition (the blocking minimum is ADS_CREATIVE_RULES.minBrandHeadlines). */
  maxBrandHeadlines: 7,
  maxBrandDescriptions: 2,
  /** Headlines with coupon/promo wording; revision 3 mixes coupon terms freely, this only stops stuffing. */
  maxCouponIntentHeadlines: 5,
  maxCouponzGuruHeadlines: 1,
  maxCouponzGuruDescriptions: 1,
  /** Supporting headlines that are just "browse/check/view…" instructions. */
  maxInstructionHeadlines: 2,
  /**
   * Headlines pairing the full brand with a concrete hook: offer ads need a
   * number from Offer details ("Myntra Up To 50% Off Fashion"); evergreen ads
   * need a supplied category plus a coupon term ("Myntra Shoe Coupon Codes").
   */
  minBrandHookHeadlines: 3,
  couponTerms: ['coupon', 'code', 'discount', 'offer', 'deal', 'promo'],
  /** Trust terms are optional; these only cap how many lines may carry one. */
  maxTrustHeadlines: 3,
  maxTrustDescriptions: 2,
  instructionVerbs: ['browse', 'check', 'view', 'see', 'review', 'explore'],
} as const;

/** Vague listing/search narration and hype the prompt asks to avoid (lower-cased substring match). */
export const ADS_FILLER_PHRASES = [
  'savings search',
  'savings journey',
  'shopping visit',
  'listed deal',
  'listed offer',
  'offer shown',
  // Vague endings and process lines that give no reason to click.
  'for less',
  'smarter prices',
  'smaller prices',
  'smaller bills',
  'without full price',
  'coupon terms',
  'terms apply',
  'choose a deal',
  'which coupon',
  'unlock',
  'elevate',
  'discover amazing',
  'ultimate',
  'unbeatable',
] as const;

/** Words the copy may never use (lower-cased substring match). Blocking. */
export const ADS_BANNED_COPY_PHRASES = [
  'guarantee',
  'best price',
  'lowest price',
  '#1',
  'number one',
  'limited time',
  'hurry',
  'ends soon',
  // Trust terms signal freshness, never a deadline.
  'today only',
  'only today',
  'ends today',
  'expires today',
  'last day today',
  'act now',
  'last chance',
  '!!',
] as const;

/**
 * Evergreen ads must stay true on any day: time and event words are blocking
 * (whole-word, case-insensitive). Numbers and codes are blocked separately.
 */
export const ADS_EVERGREEN_BLOCKED_TERMS = [
  // 'today' is allowed: it is an approved trust term (ADS_TRUST_TERMS).
  'tonight', 'tomorrow', 'this week', 'this weekend', 'this month', 'right now',
  'ends', 'ending', 'expires', 'expiring', 'until', 'till', 'last day', 'deadline',
  'flash sale', 'season sale', 'end of season', 'clearance',
  'diwali', 'holi', 'eid', 'ramadan', 'christmas', 'new year', 'black friday', 'cyber monday',
  'independence day', 'republic day', 'festive', 'festival', 'summer sale', 'winter sale',
  'cashback', 'free delivery', 'free shipping', 'new users', 'first order',
] as const;

/**
 * Offer ads: copy may only join two offers ("50% + extra 20%", "plus",
 * "on top") when Offer details explicitly says they combine. Blocking.
 * A negative phrase ("not stackable") always wins over a positive one.
 */
export const ADS_STACKING_COPY_TERMS = ['+', 'plus', 'on top', 'combined', 'stacked', 'together with'] as const;
export const ADS_STACKING_EVIDENCE_TERMS = ['+', 'plus', 'on top', 'can be combined', 'combinable', 'stackable', 'together with', 'in addition to'] as const;
export const ADS_NON_STACKING_TERMS = [
  'not stackable', 'non-stackable', 'non stackable', 'cannot be combined', "can't be combined",
  'not combinable', 'not valid with other', 'cannot be clubbed', 'not clubbable',
] as const;

/**
 * Arabic wording the English rules also forbid. Written in normalized spelling
 * (see normalizeArabic) and matched as whole words with common prefixes. Blocking.
 */
export const ADS_ARABIC_BANNED_PHRASES = [
  'مضمون', 'ضمان', 'نضمن', 'افضل سعر', 'افضل الاسعار', 'اقل سعر', 'اقل الاسعار', 'ارخص', 'ارخص سعر', 'ارخص الاسعار',
  'رقم 1', 'رقم واحد', 'الاول في', 'لفتره محدوده', 'لوقت محدود', 'عرض محدود', 'سارع', 'سارعوا', 'سارعي', 'بادر', 'بادروا',
  'لا تفوت', 'لا تفوتوا', 'لا تفوتي', 'ينتهي قريبا', 'ينتهي اليوم', 'اليوم فقط', 'فقط اليوم', 'الان فقط', 'اخر فرصه', 'فرصه اخيره',
] as const;

/** Arabic equivalents of ADS_EVERGREEN_BLOCKED_TERMS (same normalized whole-word match). */
export const ADS_ARABIC_EVERGREEN_BLOCKED_TERMS = [
  'رمضان', 'عيد', 'الفطر', 'الاضحي', 'الجمعه البيضاء', 'الجمعه السوداء', 'بلاك فرايدي', 'الاثنين الالكتروني', 'سايبر مانداي',
  'راس السنه', 'السنه الجديده', 'كريسماس', 'ديوالي', 'اليوم الوطني', 'موسم', 'موسمي', 'تصفيه', 'الليله', 'غدا',
  'هذا الاسبوع', 'نهايه الاسبوع', 'هذا الشهر', 'الان', 'ينتهي', 'تنتهي', 'اخر يوم', 'كاش باك', 'استرداد نقدي',
  'توصيل مجاني', 'شحن مجاني', 'مستخدمين جدد', 'العملاء الجدد', 'اول طلب',
] as const;

/** Spelled-out numbers: figures must stay in digits unless the English line words them too. */
export const ADS_ARABIC_NUMBER_WORDS = [
  'اثنين', 'ثلاث', 'اربع', 'خمس', 'ست', 'سبع', 'ثمان', 'تسع', 'عشر', 'عشرين', 'ثلاثين', 'اربعين', 'خمسين', 'ستين', 'سبعين',
  'ثمانين', 'تسعين', 'مئه', 'مائه', 'بالمئه', 'بالمائه', 'الف', 'نصف', 'ربع',
] as const;

/** Claims a translation may only make when its English line states them. */
export const ADS_ARABIC_CLAIM_EVIDENCE = [
  { arabic: ['توصيل مجاني', 'شحن مجاني', 'مجانا', 'مجاني', 'هديه'], english: /\b(free|gift)\b/i },
  { arabic: ['كاش باك', 'استرداد نقدي'], english: /\bcash\s?back\b/i },
] as const;

export const ADS_ARABIC_MANUAL_STEPS = [
  'Have an Arabic speaker review the ad copy before enabling the campaign.',
  'Set the campaign language to Arabic in Google Ads before enabling it.',
  'Keywords stay in English. Add Arabic keywords in Google Ads if you want to match Arabic searches.',
] as const;

// ── Fixed campaign values written by the CSV builder ──
export const ADS_KEYWORD_SUFFIXES = [
  'coupon',
  'coupons',
  'coupon code',
  'coupon codes',
  'discount',
  'discount code',
  'discount coupon',
  'promo code',
  'offers',
  'deals',
] as const;

export const ADS_COUNTRY_ALIASES: Record<string, string> = {
  USA: 'United States',
  US: 'United States',
  UAE: 'United Arab Emirates',
  UK: 'United Kingdom',
};

export const ADS_DEVICE_NAMES = {
  mobileAdjustment: 'Mobile devices with full browsers',
  tabletAdjustment: 'Tablets with full browsers',
  desktopAdjustment: 'Computers',
} as const;

export const ADS_CAMPAIGN_DEFAULTS = {
  entityStatus: 'Paused',
  campaignType: 'Search',
  networks: 'Google search',
  budgetType: 'Daily',
  bidStrategyType: 'Maximize Conversions',
  euPoliticalAds: 'No',
  adGroupType: 'Standard',
  adGroupSuffix: ' | Coupons & Discounts',
  keywordMatchType: 'Phrase match',
  adType: 'Responsive search ad',
  path1: 'coupons',
  path2: 'deals',
} as const;

export const ADS_MANUAL_STEPS = [
  'Confirm AI Max is OFF for this campaign before enabling it.',
  'Select the intended conversion goal before enabling the campaign.',
  'Upload via Google Ads → Bulk actions → Uploads, then Preview before Apply.',
] as const;

// ── Contract ──

/** Raw form exactly as the settings page sends it: text fields only. */
export type AdsGeneratorFormInput = {
  /** 'evergreen' or 'offer' (see ADS_AD_TYPES). */
  adType: string;
  campaignName: string;
  brandName: string;
  /** Comma-separated, e.g. "India, UAE, USA". */
  countries: string;
  landingPage: string;
  dailyBudget: string;
  targetCpa: string;
  label: string;
  mobileAdjustment: string;
  tabletAdjustment: string;
  desktopAdjustment: string;
  /** Comma-separated shared negative keyword list names. */
  negativeKeywordLists: string;
  /** Offer ads only: verified offer facts; the only source for claims. */
  offerDetails: string;
  /** Evergreen ads only, required: comma-separated, e.g. "Fashion, shoes, beauty". */
  brandCategories: string;
};

export type GeneratedAd = { headlines: string[]; descriptions: string[] };

/** The Arabic translation of a validated English result. */
export type AdsArabicVersion = {
  promptVersion: string;
  ads: GeneratedAd[];
  warnings: string[];
  manualSteps: string[];
  usage: { calls: number; inputTokens: number; outputTokens: number };
  csv: { filename: string; content: string; rows: number };
};

export type AdsGeneratorResult = {
  adType: AdsAdType;
  promptVersion: string;
  model: string;
  cached: boolean;
  keywords: string[];
  ads: GeneratedAd[];
  warnings: string[];
  manualSteps: string[];
  usage: { calls: number; inputTokens: number; outputTokens: number };
  csv: { filename: string; content: string; rows: number };
  /** Present when Arabic was requested; its CSV is the one to download. */
  arabic?: AdsArabicVersion;
};

/** POST /generate body: one to ADS_FORM_LIMITS.campaignsMax campaigns. */
export type AdsLanguage = 'en' | 'ar';

export type AdsGeneratorBatchInput = {
  campaigns: AdsGeneratorFormInput[];
  /** 'ar': write and validate English first, then translate it for the download. */
  language?: AdsLanguage;
};

/** POST /generate body that reruns only a finished job's failed campaigns. */
export type AdsGeneratorRetryInput = {
  retryJobId: string;
  replacements: { index: number; form: AdsGeneratorFormInput }[];
};

export type AdsGenerationRequest = AdsGeneratorBatchInput | AdsGeneratorRetryInput;

/** One campaign's progress and outcome inside a batch. */
export type AdsCampaignRun = {
  index: number;
  campaignName: string;
  /** Identifies this exact brief, so a retry reuses it without a new OpenAI call. */
  key: string;
  /** The English step's key, so a failed translation never pays for English again. */
  englishKey?: string;
  /** Validated English kept while, or after, its translation fails. */
  english?: Omit<AdsGeneratorResult, 'cached'>;
  phase?: 'english' | 'arabic';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  /** OpenAI calls made so far for this campaign. */
  attempt: number;
  result?: AdsGeneratorResult;
  error?: { message: string; problems: string[] };
};

export type AdsBatchResult = { campaigns: AdsCampaignRun[] };

/**
 * A background generation (POST /generate starts it, GET /jobs/:id polls it).
 * `result` fills in while it runs. A finished job can hold both successful
 * and failed campaigns; each campaign carries its own status.
 */
export type AdsGeneratorJob = GenerationJob<AdsBatchResult>;

export type AdsGeneratorOptions = {
  configured: boolean;
  currency: string;
  promptVersion: string;
  limits: typeof ADS_FORM_LIMITS;
};
