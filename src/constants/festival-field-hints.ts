// Editor guidance follows the Festival storefront mappers; image sizes are recommendations.
export const FESTIVAL_FIELD_DESCRIPTIONS: Record<string, Record<string, string>> = {
  "festival.offer-slide": {
    "coupon": "Select the Coupon for this slide. Coupons with and without a code are supported.",
    "titleOverride": "Optional. Leave empty to use the selected offer title.",
    "descriptionOverride": "Optional. Displayed in two lines; leave empty to use the selected offer description.",
    "badgeOverride": "Optional, for example Extra 20% Off. Leave empty to use the selected Coupon offer text. No badge is invented when both are empty."
  },
  "festival.explore-categories": {
    "categories": "Add each category once, then drag to reorder. Empty hides this section. Category navigation scrolls horizontally when needed on desktop and mobile. Choose Coupons inside each row to curate that category, or leave its Coupons empty for the latest live category Coupons.",
    "description": "Supporting text below the heading. Empty omits this text.",
    "enabled": "Turn off to hide category navigation and its Coupon listing without deleting selections.",
    "heading": "Section heading. Empty uses Explore Categories."
  },
  "festival.category-selection": {
    "category": "Choose a category. Its name appears in the collapsed row.",
    "labelOverride": "Optional; leave empty to use the current category name.",
    "imageOverride": "Optional square artwork: desktop 88 × 88 px; Retina 2× 176 × 176 px. The same image is used on mobile and cropped to a square. Keep the subject centred. Empty uses the category icon.",
    "coupons": "Optional Coupons only, with or without a code. Leave empty to use all latest live Coupons belonging to this category. Selected Coupons keep their order under Recommended; expired selections are omitted, not replaced."
  },
  "festival.product-section": {
    "items": "Select and reorder Product Deals. The slider uses every valid selection; empty means no product slider.",
    "categories": "Select and order category tabs below the Product Deal slider. The first category opens automatically. Each tab shows all its live Product Deals, with brand, store, bank and discount filters derived automatically from those Deals. Empty hides the tabs and listing.",
    "enabled": "Turn off to hide the entire Product Deal section: slider, category tiles and listing. Saved selections are retained.",
    "heading": "Optional heading. Empty uses the storefront’s Picked for you heading.",
    "description": "Optional supporting text. Empty omits it."
  },
  "festival.product-slide": {
    "deal": "Choose a Product Deal. Its current title appears in the collapsed row.",
    "titleOverride": "Optional. Leave empty to show the selected Product Deal’s current title."
  },
  "festival.product-category": {
    "category": "Choose a Category. Its name appears in the collapsed row.",
    "labelOverride": "Optional display label. Leave empty to use the current category name.",
    "imageOverride": "Recommended desktop artwork: 242 × 210 px; Retina 2×: 484 × 420 px. The same image fills a 110 × 132 px mobile tile with cover cropping. Keep important content centred and away from edges. Empty uses the category icon; if neither exists, a text-only tab is shown."
  },
  "festival.gift-section": {
    "categories": "Select a maximum of 6 unique categories and drag to reorder. These create only the tiles below the slider; they never add Coupons. Empty hides the tiles. Mobile displays 3 tiles per row.",
    "items": "Select and reorder the exact Coupons to show. Only selected live Coupons appear. An empty selection hides the slider.",
    "description": "Optional supporting text under the heading. Empty omits it.",
    "enabled": "Turn off to hide both the Gift Coupon slider and its category tiles while keeping your selections.",
    "heading": "Section heading. Empty uses Festival Gift Offers."
  },
  "festival.gift-category": {
    "category": "Choose a category. The selected name appears on the collapsed row.",
    "labelOverride": "Leave empty to use the current category name.",
    "imageOverride": "Recommended desktop artwork: 159 × 140 px; Retina 2×: 318 × 280 px. Artwork fits inside the decorative frame without cropping; the same image scales on mobile. Empty uses the category icon. If both are empty, the category has no artwork."
  },
  "festival.gift-coupon": {
    "coupon": "Choose a Coupon to display in this slider. Selections keep their order.",
    "titleOverride": "Leave empty to use the current Coupon title.",
    "descriptionOverride": "Optional, displayed on one line with ellipsis. Empty uses the Coupon description; if both are empty, no description is shown.",
    "imageOverride": "Artwork on the right side of the voucher. Recommended desktop: 233 × 247 px; Retina 2×: 466 × 494 px. Cover cropping applies; keep the subject centred, clear of the top discount badge. Empty uses the first selected Gift category’s artwork, then the merchant logo when that artwork is missing.",
    "occasionOverride": "Short occasion label. Empty falls back to Diwali Special; clearing this field does not hide the label.",
    "badgeOverride": "Optional discount text, for example Flat 50% OFF. Empty uses the Coupon offer text; if that is also empty, no discount text is shown."
  },
  "festival.savings-section": {
    "items": "Select up to 2 Coupons and drag to reorder. Each row needs a Coupon. Only selected live Coupons appear; empty hides the section. Desktop shows cards side by side; mobile uses a slider. This section sits between Explore Categories and Product Deals.",
    "enabled": "Turn off to hide both savings cards while retaining your selections."
  },
  "festival.savings-coupon": {
    "coupon": "Select one Coupon. Its title appears on the collapsed row.",
    "titleOverride": "Empty uses the Coupon title.",
    "descriptionOverride": "Optional short supporting text, displayed on one line. Empty uses the Coupon description; if both are empty, no description is shown.",
    "logoOverride": "Optional logo artwork: desktop approximately 66 × 26 px; Retina 2×: 132 × 52 px. The full logo fits without cropping; use a tightly trimmed image. Empty uses the selected Coupon’s merchant logo. Background colour comes from the displayed image’s saved media colour.",
    "badgeLabel": "Top badge line, for example Card offer. New rows start with Card offer; clear it to omit this line.",
    "badgeValue": "Main badge value, for example 10%. Empty uses the Coupon discount text; if unavailable, this line is empty.",
    "badgeCaption": "Bottom badge line, for example extra off*. New rows start with extra off*; clear it to omit this line.",
    "buttonLabel": "Empty uses Unlock Coupon or Get Deal according to the Coupon.",
    "termsText": "Short vertical terms note, for example *T&C Apply. New rows start with this text; clear it to hide the note. This changes only the card note, not the Coupon’s full terms."
  },
  "festival.responsive-banner": {
    "enabled": "Turn off to hide the banner without removing the uploaded image. This switch does not enable the whole Festival template.",
    "desktopImage": "Upload one banner for desktop, tablet and mobile. Recommended desktop artwork: 1440 px wide at your chosen height; Retina 2×: 2880 px wide at twice that height (for example 1440 × 400 → 2880 × 800 px). These are recommendations, not fixed dimensions. Export from the original artwork; enlarging a small image does not restore detail. Choose High in the upload dialog for more detail at the cost of larger files; it applies only to that upload. The banner fills the viewport and keeps its aspect ratio; wider screens may need a larger source. Include decorative badges in the artwork. Empty means no banner.",
    "altText": "Describe the banner for screen readers. Empty uses the media library alternative text; if both are empty, no descriptive alternative is available.",
    "linkUrl": "Optional banner destination: /page-path/ or a full HTTP(S) URL. Empty makes the banner non-clickable."
  },
  "festival.sale-countdown": {
    "enabled": "Enable only after completing both dates, both phase labels and both buttons. Turn off to keep an unfinished countdown saved without showing it.",
    "saleStartAt": "Required when enabled. Before this date and time the clock counts down to the start and uses the pre-sale text.",
    "saleEndAt": "Required when enabled; must be after the start. During the sale the clock counts down to this time. The countdown disappears after the sale ends.",
    "preSaleLabel": "Text before the sale starts, for example Sale starts in. Cannot be blank when enabled.",
    "preSaleCtaLabel": "Button text before the sale starts, for example View upcoming offers. Cannot be blank when enabled.",
    "preSaleCtaHref": "Required when enabled. Use /page-path/ or a full HTTP(S) URL. To link to a section use /page-path/#section-id; a bare #anchor is not accepted.",
    "liveLabel": "Text while the sale is live, for example Sale ends in. Cannot be blank when enabled.",
    "liveCtaLabel": "Button text while the sale is live, for example Shop offers. Cannot be blank when enabled.",
    "liveCtaHref": "Required when enabled. Use /page-path/ or a full HTTP(S) URL. To link to a section use /page-path/#section-id; a bare #anchor is not accepted."
  },
  "festival.offer-slider": {
    "enabled": "Turn off to hide this slider and retain its selections.",
    "items": "Add Coupon slides in display order; drag to reorder. Only selected live Coupons appear, with or without a code. Empty hides the slider; no offers are added automatically. Each added row needs a Coupon."
  }
};

export const FESTIVAL_FIELD_LABELS: Record<string, Record<string, string>> = {
  "festival.category-selection": {
    "coupons": "Selected Coupons (optional)",
    "imageOverride": "Category image override"
  },
  "festival.product-section": {
    "items": "Product Deals",
    "categories": "Category tiles",
  },
  "festival.product-slide": {
    "deal": "Product Deal",
    "titleOverride": "Title override (optional)"
  },
  "festival.product-category": {
    "category": "Category",
    "labelOverride": "Label override (optional)",
    "imageOverride": "Category image",
  },
  "festival.offer-slide": {
    "coupon": "Coupon"
  },
  "festival.gift-section": {
    "categories": "Coupon categories and tiles",
    "items": "Selected Coupons"
  }
};
