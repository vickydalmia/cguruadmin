-- CouponzGuru WordPress taxonomy slug migration
-- Source: Target Campaigns - URL Redirecttion (2).csv
-- Generated: 2026-07-30
--
-- Scope:
--   * 189 existing WordPress category-taxonomy terms.
--   * Chhabra555 (CSV line 35) is deliberately excluded because the live
--     production database has no matching term and therefore no valid target.
--   * Every selected term becomes a root category (parent = 0).
--
-- IMPORTANT:
--   1. Take a full database backup first.
--   2. Execute with a privileged MySQL account in batch mode WITHOUT --force.
--      Recommended:
--        mysql --batch --abort-source-on-error -u <user> -p <database> \
--          < 2026-07-30-update-wordpress-taxonomy-slugs.sql
--   3. A preflight or postflight issue intentionally raises a duplicate-key
--      error. The mysql client must stop at that error so the open transaction
--      is rolled back.
--   4. After commit, run:
--        wp cache flush
--        wp yoast index --reindex
--   5. Reload nginx only after this file commits successfully.
--
-- The script changes only wp_terms.slug and wp_term_taxonomy.parent.

SET NAMES utf8mb4;

DROP TEMPORARY TABLE IF EXISTS _cguru_taxonomy_slug_changes;
DROP TEMPORARY TABLE IF EXISTS _cguru_taxonomy_candidates;
DROP TEMPORARY TABLE IF EXISTS _cguru_taxonomy_issues;
DROP TEMPORARY TABLE IF EXISTS _cguru_abort_guard;

CREATE TEMPORARY TABLE _cguru_taxonomy_slug_changes (
  source_line SMALLINT UNSIGNED NOT NULL PRIMARY KEY,
  display_name VARCHAR(255) NOT NULL,
  expected_type VARCHAR(32) NOT NULL,
  old_complete_slug VARCHAR(512) NOT NULL,
  old_leaf_slug VARCHAR(255) NOT NULL,
  old_parent_slug VARCHAR(255) NULL,
  new_slug VARCHAR(255) NOT NULL,
  UNIQUE KEY uq_cguru_old_complete_slug (old_complete_slug),
  UNIQUE KEY uq_cguru_new_slug (new_slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO _cguru_taxonomy_slug_changes
  (source_line, display_name, expected_type, old_complete_slug, old_leaf_slug, old_parent_slug, new_slug)
VALUES
  (2, 'Adidas India', 'Store', 'shopping-coupon/adidas-india', 'adidas-india', 'shopping-coupon', 'adidas-coupons'),
  (3, 'Adlabs Imagica', 'Store', 'adlabs-imagica-deals-coupons', 'adlabs-imagica-deals-coupons', NULL, 'adlabs-imagica-coupons'),
  (4, 'Air Conditioner', 'Category', 'air-conditioner-offers', 'air-conditioner-offers', NULL, 'air-conditioner-coupons'),
  (5, 'Air India', 'Store', 'air-india-promo-codes', 'air-india-promo-codes', NULL, 'air-india-coupons'),
  (6, 'Air India Express', 'Store', 'airindiaexpresscoupons', 'airindiaexpresscoupons', NULL, 'air-india-express-coupons'),
  (7, 'Air Serbia', 'Store', 'air-serbia-coupon-codes', 'air-serbia-coupon-codes', NULL, 'air-serbia-coupons'),
  (8, 'Airtel Payments Bank', 'Bank', 'airtel-payments-bank-offers', 'airtel-payments-bank-offers', NULL, 'airtel-payments-bank-coupons'),
  (9, 'Allman', 'Store', 'allman-coupon-codes', 'allman-coupon-codes', NULL, 'allman-coupons'),
  (10, 'Amazon', 'Store', 'amazon', 'amazon', NULL, 'amazon-coupons'),
  (11, 'American Express', 'Bank', 'american-express-offers', 'american-express-offers', NULL, 'american-express-coupons'),
  (12, 'Antamedia', 'Store', 'antamedia-coupon', 'antamedia-coupon', NULL, 'antamedia-coupons'),
  (13, 'Apple', 'Brand', 'apple-online-offers', 'apple-online-offers', NULL, 'apple-coupons'),
  (14, 'AskYourPDF', 'Store', 'askyourpdf-coupon', 'askyourpdf-coupon', NULL, 'askyourpdf-coupons'),
  (15, 'Asus', 'Store', 'asus-offers-online', 'asus-offers-online', NULL, 'asus-coupons'),
  (16, 'AutoShorts.Ai', 'Store', 'autoshortsai-couopns', 'autoshortsai-couopns', NULL, 'autoshortsai-coupons'),
  (17, 'AXIS Bank', 'Bank', 'axis-bank', 'axis-bank', NULL, 'axis-bank-coupons'),
  (18, 'Baby Products', 'Category', 'baby-products-offers', 'baby-products-offers', NULL, 'baby-products-coupons'),
  (19, 'Bags', 'Category', 'bags-offers-coupons', 'bags-offers-coupons', NULL, 'bags-coupons'),
  (20, 'Banyan Tree Hotels &amp; Resorts', 'Store', 'banyan-tree-hotels-and-resorts', 'banyan-tree-hotels-and-resorts', NULL, 'banyan-tree-coupons'),
  (21, 'Bata', 'Store', 'bata-shoes-coupon-code', 'bata-shoes-coupon-code', NULL, 'bata-coupons'),
  (22, 'Bike Gear', 'Store', 'bikegear-coupon', 'bikegear-coupon', NULL, 'bikegear-coupons'),
  (23, 'Bluestone', 'Store', 'shopping-coupon/bluestone', 'bluestone', 'shopping-coupon', 'bluestone-coupons'),
  (24, 'Bookmyshow', 'Store', 'bookmyshow-coupons-offers', 'bookmyshow-coupons-offers', NULL, 'bookmyshow-coupons'),
  (25, 'Books', 'Category', 'books-coupons-offers', 'books-coupons-offers', NULL, 'books-coupons'),
  (26, 'BounceBan', 'Store', 'bounceban-coupon', 'bounceban-coupon', NULL, 'bounceban-coupons'),
  (27, 'BOX8- Desi Meals', 'Store', 'box8-coupon-codes', 'box8-coupon-codes', NULL, 'box8-coupons'),
  (28, 'Bus Tickets', 'Category', 'bus-booking-offers-coupons', 'bus-booking-offers-coupons', NULL, 'bus-booking-coupons'),
  (29, 'Cameras', 'Category', 'camera-offers', 'camera-offers', NULL, 'camera-coupons'),
  (30, 'Car Accessories', 'Category', 'car-accessories-offers', 'car-accessories-offers', NULL, 'car-accessories-coupons'),
  (31, 'Caratlane', 'Store', 'shopping-coupon/caratlane', 'caratlane', 'shopping-coupon', 'caratlane-coupons'),
  (32, 'Casio', 'Store', 'casio-online-offers', 'casio-online-offers', NULL, 'casio-coupons'),
  (33, 'Cbazaar', 'Store', 'cbazaar', 'cbazaar', NULL, 'cbazaar-coupons'),
  (34, 'Chef Solutions', 'Store', 'chef-solutions-coupon-codes', 'chef-solutions-coupon-codes', NULL, 'chef-solutions-coupons'),
  (36, 'Clothing', 'Category', 'clothing-coupons-offers', 'clothing-coupons-offers', NULL, 'clothing-coupons'),
  (37, 'Code Sector', 'Store', 'codesector', 'codesector', NULL, 'codesector-coupons'),
  (38, 'Coohom', 'Store', 'coohom-coupon', 'coohom-coupon', NULL, 'coohom-coupons'),
  (39, 'Cosmetics', 'Category', 'cosmetics-offers', 'cosmetics-offers', NULL, 'cosmetics-coupons'),
  (40, 'Dailyobjects', 'Store', 'shopping-coupon/dailyobjects', 'dailyobjects', 'shopping-coupon', 'dailyobjects-coupons'),
  (41, 'Daniel Wellington', 'Brand', 'danielwellington', 'danielwellington', NULL, 'daniel-wellington-coupons'),
  (42, 'DC Shoes', 'Brand', 'dcshoes-coupon-codes', 'dcshoes-coupon-codes', NULL, 'dcshoes-coupons'),
  (43, 'Dell', 'Store', 'dell-online-offers', 'dell-online-offers', NULL, 'dell-coupons'),
  (44, 'Diwali Offers', 'Category', 'diwali-offers-coupons', 'diwali-offers-coupons', NULL, 'diwali-coupons'),
  (45, 'Domestic Flights', 'Category', 'trip-india-domestic-flight-coupon-code', 'trip-india-domestic-flight-coupon-code', NULL, 'domestic-flight-coupons'),
  (46, 'Dresses', 'Category', 'dresses-online-offers', 'dresses-online-offers', NULL, 'dresses-coupons'),
  (47, 'DTH Recharge', 'Category', 'dth-recharge-coupon-offers', 'dth-recharge-coupon-offers', NULL, 'dth-recharge-coupons'),
  (48, 'Dubai Pass', 'Brand', 'dubaipass-coupon-codes', 'dubaipass-coupon-codes', NULL, 'dubaipass-coupons'),
  (49, 'E-Iceblue', 'Store', 'eiceblue', 'eiceblue', NULL, 'eiceblue-coupons'),
  (50, 'Elai.io', 'Store', 'elaiio-coupon-codes', 'elaiio-coupon-codes', NULL, 'elaiio-coupons'),
  (51, 'Electronics', 'Category', 'electronics-coupons-offers', 'electronics-coupons-offers', NULL, 'electronics-coupons'),
  (52, 'Element14', 'Store', 'element14', 'element14', NULL, 'element14-coupons'),
  (53, 'Emirates', 'Store', 'emirates-promotion-code', 'emirates-promotion-code', NULL, 'emirates-coupons'),
  (54, 'Eurail Global Pass', 'Brand', 'eurail-global-pass', 'eurail-global-pass', NULL, 'eurail-pass-coupons'),
  (55, 'Expedia', 'Store', 'travelcoupons/expedia', 'expedia', 'travelcoupons', 'expedia-coupons'),
  (56, 'Fashion And Lifestyle', 'Category', 'fashions-coupons-offers', 'fashions-coupons-offers', NULL, 'fashions-coupons'),
  (57, 'Fastrack', 'Store', 'fastrack-deals-offers-coupons', 'fastrack-deals-offers-coupons', NULL, 'fastrack-coupons'),
  (58, 'Fathers Day', 'Category', 'fathers-day-offers-coupons', 'fathers-day-offers-coupons', NULL, 'fathers-day-coupons'),
  (59, 'Firstcry', 'Store', 'shopping-coupon/firstcry-com', 'firstcry-com', 'shopping-coupon', 'firstcry-coupons'),
  (60, 'Flipkart', 'Store', 'shopping-coupon/flipkart', 'flipkart', 'shopping-coupon', 'flipkart-coupons'),
  (61, 'FlowerAura', 'Store', 'floweraura', 'floweraura', NULL, 'floweraura-coupons'),
  (62, 'Football Monk', 'Store', 'footballmonkcoupons', 'footballmonkcoupons', NULL, 'footballmonk-coupons'),
  (63, 'Footwear', 'Category', 'footwear-coupons-offers', 'footwear-coupons-offers', NULL, 'footwear-coupons'),
  (64, 'ForMen', 'Brand', 'formen-coupon-codes', 'formen-coupon-codes', NULL, 'formen-coupons'),
  (65, 'Fun and Activities', 'Category', 'fun-activities-offers', 'fun-activities-offers', NULL, 'fun-activities-coupons'),
  (66, 'Furniture', 'Category', 'furniture-offers', 'furniture-offers', NULL, 'furniture-coupons'),
  (67, 'Gaming Consoles', 'Category', 'gaming-consoles-offers', 'gaming-consoles-offers', NULL, 'gaming-consoles-coupons'),
  (68, 'Gift Cards', 'Category', 'gift-cards-vouchers', 'gift-cards-vouchers', NULL, 'gift-cards-coupons'),
  (69, 'Gillette', 'Brand', 'gillette-online-offers', 'gillette-online-offers', NULL, 'gillette-coupons'),
  (70, 'GKB Opticals', 'Store', 'shopping-coupon/gkb-opticals', 'gkb-opticals', 'shopping-coupon', 'gkb-opticals-coupons'),
  (71, 'Goibibo', 'Store', 'goibibo-coupon-codes', 'goibibo-coupon-codes', NULL, 'goibibo-coupons'),
  (72, 'Google Pay', 'Bank', 'google-pay-offers', 'google-pay-offers', NULL, 'google-pay-coupons'),
  (73, 'Grocery', 'Category', 'grocery-offers', 'grocery-offers', NULL, 'grocery-coupons'),
  (74, 'HDFC Bank', 'Bank', 'hdfc-bank-deals-offers', 'hdfc-bank-deals-offers', NULL, 'hdfc-bank-coupons'),
  (75, 'Headphones', 'Category', 'headphones-speakers', 'headphones-speakers', NULL, 'headphones-coupons'),
  (76, 'Health And Fitness', 'Category', 'health-fitness-offers', 'health-fitness-offers', NULL, 'health-fitness-coupons'),
  (77, 'Home and Kitchen', 'Category', 'home-kitchen-offers', 'home-kitchen-offers', NULL, 'home-kitchen-coupons'),
  (78, 'Home Decor', 'Category', 'home-decor-offers', 'home-decor-offers', NULL, 'home-decor-coupons'),
  (79, 'Home Furnishing', 'Category', 'home-furnishing-offers', 'home-furnishing-offers', NULL, 'home-furnishing-coupons'),
  (80, 'Hotel Bookings', 'Category', 'hotel-deal-coupons', 'hotel-deal-coupons', NULL, 'domestic-hotel-coupons'),
  (81, 'Hotels.com', 'Store', 'travelcoupons/hotels-com', 'hotels-com', 'travelcoupons', 'hotels-com-coupons'),
  (82, 'IBVPN', 'Store', 'ibvpn-coupon', 'ibvpn-coupon', NULL, 'ibvpn-coupons'),
  (83, 'India Circus', 'Store', 'india-circus', 'india-circus', NULL, 'india-circus-coupons'),
  (84, 'IndiGo Flights', 'Store', 'indigo-flights-coupon-code', 'indigo-flights-coupon-code', NULL, 'indigo-coupons'),
  (85, 'Intermiles', 'Store', 'intermiles-coupon-codes', 'intermiles-coupon-codes', NULL, 'intermiles-coupons'),
  (86, 'Jeans', 'Category', 'jeans-online-offers', 'jeans-online-offers', NULL, 'jeans-coupons'),
  (87, 'Jewellery', 'Category', 'jewellery-offers', 'jewellery-offers', NULL, 'jewellery-coupons'),
  (88, 'Jockey', 'Store', 'jockey-online-offers', 'jockey-online-offers', NULL, 'jockey-coupons'),
  (89, 'Jovees', 'Store', 'jovees-coupon-codes', 'jovees-coupon-codes', NULL, 'jovees-coupons'),
  (90, 'Kaya Science', 'Store', 'kaya-science', 'kaya-science', NULL, 'kaya-science-coupons'),
  (91, 'KICKS CREW', 'Store', 'kicks-crew-coupon-codes', 'kicks-crew-coupon-codes', NULL, 'kicks-crew-coupons'),
  (92, 'Kitchen Appliances', 'Category', 'kitchen-apppliances-offers', 'kitchen-apppliances-offers', NULL, 'kitchen-apppliances-coupons'),
  (93, 'Kotak Bank', 'Bank', 'kotak-bank', 'kotak-bank', NULL, 'kotak-bank-coupons'),
  (94, 'Kurtis', 'Category', 'kurtis-online-offers', 'kurtis-online-offers', NULL, 'kurtis-coupons'),
  (95, 'LaOrgano', 'Brand', 'laorgano', 'laorgano', NULL, 'laorgano-coupons'),
  (96, 'Laptops', 'Category', 'laptop-coupons-offers', 'laptop-coupons-offers', NULL, 'laptop-coupons'),
  (97, 'Lenovo', 'Store', 'lenovo', 'lenovo', NULL, 'lenovo-coupons'),
  (98, 'Levis', 'Store', 'levis-online-offers', 'levis-online-offers', NULL, 'levis-coupons'),
  (99, 'LG Electronics', 'Brand', 'lg-online-offers', 'lg-online-offers', NULL, 'lg-coupons'),
  (100, 'LifeLong Online', 'Store', 'lifelongindiaonline', 'lifelongindiaonline', NULL, 'lifelong-coupons'),
  (101, 'Limeroad', 'Store', 'limeroad', 'limeroad', NULL, 'limeroad-coupons'),
  (102, 'Lingerie', 'Category', 'lingerie-coupons-offers', 'lingerie-coupons-offers', NULL, 'lingerie-coupons'),
  (103, 'London Pass', 'Brand', 'london-pass', 'london-pass', NULL, 'london-pass-coupons'),
  (104, 'Loreal', 'Brand', 'loreal-online-offers', 'loreal-online-offers', NULL, 'loreal-coupons'),
  (105, 'MacBook', 'Brand', 'macbook-offers', 'macbook-offers', NULL, 'macbook-coupons'),
  (106, 'Makemytrip', 'Store', 'makemytrip-flight-coupon', 'makemytrip-flight-coupon', NULL, 'makemytrip-coupons'),
  (107, 'Makemytrip Bus', 'Store', 'makemytrip-bus-coupon-code', 'makemytrip-bus-coupon-code', NULL, 'makemytrip-bus-coupons'),
  (108, 'Mamypoko Pants', 'Brand', 'mamypokopants-offers', 'mamypokopants-offers', NULL, 'mamy-poko-pants-coupons'),
  (109, 'McDonalds', 'Store', 'mcdonalds', 'mcdonalds', NULL, 'mcdonalds-coupons'),
  (110, 'Microwave', 'Category', 'microwave-offers', 'microwave-offers', NULL, 'microwave-coupons'),
  (111, 'Mobile Accessories', 'Category', 'mobile-accessories-offers', 'mobile-accessories-offers', NULL, 'mobile-accessories-coupons'),
  (112, 'Mobile Covers', 'Category', 'mobile-covers-online-offers', 'mobile-covers-online-offers', NULL, 'mobile-covers-coupons'),
  (113, 'Mobile Phones', 'Category', 'mobile-coupons-deals', 'mobile-coupons-deals', NULL, 'mobile-coupons'),
  (114, 'Mokobara', 'Store', 'mokobara-coupon-codes', 'mokobara-coupon-codes', NULL, 'mokobara-coupons'),
  (115, 'Mothers Day', 'Category', 'mothersday-offers-deals', 'mothersday-offers-deals', NULL, 'mothersday-coupons'),
  (116, 'Motorola', 'Brand', 'motorola-offers', 'motorola-offers', NULL, 'motorola-coupons'),
  (117, 'Myntra', 'Store', 'shopping-coupon/myntra-com', 'myntra-com', 'shopping-coupon', 'myntra-coupons'),
  (118, 'Nike', 'Brand', 'nike-online-offers', 'nike-online-offers', NULL, 'nike-coupons'),
  (119, 'Nova', 'Brand', 'nova-offers', 'nova-offers', NULL, 'nova-coupons'),
  (120, 'Novology', 'Brand', 'novology-coupon', 'novology-coupon', NULL, 'novology-coupons'),
  (121, 'Oi-Gong', 'Store', 'oigong-coupon-codes', 'oigong-coupon-codes', NULL, 'oigong-coupons'),
  (122, 'Ola Cabs', 'Store', 'ola-cabs', 'ola-cabs', NULL, 'ola-coupons'),
  (123, 'Online Doctor''s Consultation', 'Category', 'online-dr-consultation', 'online-dr-consultation', NULL, 'dr-consultation-coupons'),
  (124, 'Ourlittlejoys', 'Store', 'our-little-joys', 'our-little-joys', NULL, 'our-little-joys-coupons'),
  (125, 'Paypal', 'Bank', 'paypal-offers', 'paypal-offers', NULL, 'paypal-coupons'),
  (126, 'Paytm', 'Bank', 'paytm-promo-code', 'paytm-promo-code', NULL, 'paytm-coupons'),
  (127, 'Pen Drives and Hard Disks', 'Category', 'pen-drive-hard-disk-offers', 'pen-drive-hard-disk-offers', NULL, 'hard-disk-coupons'),
  (128, 'Pepperfry', 'Store', 'shopping-coupon/pepperfry', 'pepperfry', 'shopping-coupon', 'pepperfry-coupons'),
  (129, 'Perfumes', 'Category', 'perfumes-offers', 'perfumes-offers', NULL, 'perfumes-coupons'),
  (130, 'Personalized Gift Items', 'Category', 'personalized-gifts-offers', 'personalized-gifts-offers', NULL, 'personalized-gifts-coupons'),
  (131, 'Pet Products', 'Category', 'pet-products-offers', 'pet-products-offers', NULL, 'pet-products-coupons'),
  (132, 'Philips', 'Brand', 'philips-online-offers', 'philips-online-offers', NULL, 'philips-coupons'),
  (133, 'Polaroid', 'Store', 'polaroid-coupon', 'polaroid-coupon', NULL, 'polaroid-coupons'),
  (134, 'Power Banks', 'Category', 'power-banks-offers', 'power-banks-offers', NULL, 'power-banks-coupons'),
  (135, 'Pretty Secrets', 'Brand', 'pretty-secrets', 'pretty-secrets', NULL, 'pretty-secrets-coupons'),
  (136, 'Prime Day', 'Category', 'prime-day-coupons-offers', 'prime-day-coupons-offers', NULL, 'prime-day-coupons'),
  (137, 'Printland', 'Store', 'printland', 'printland', NULL, 'printland-coupons'),
  (138, 'Printvenue', 'Store', 'printvenue', 'printvenue', NULL, 'printvenue-coupons'),
  (139, 'Puma India', 'Brand', 'shopping-coupon/puma-india', 'puma-india', 'shopping-coupon', 'puma-coupons'),
  (140, 'Purplle', 'Store', 'shopping-coupon/purplle', 'purplle', 'shopping-coupon', 'purplle-coupons'),
  (141, 'Raksha Bandhan', 'Category', 'rakhi-offers-coupons', 'rakhi-offers-coupons', NULL, 'rakhi-coupons'),
  (142, 'Ray Ban', 'Brand', 'rayban-online-offers', 'rayban-online-offers', NULL, 'rayban-coupons'),
  (143, 'Redbus', 'Brand', 'redbus-coupon-code', 'redbus-coupon-code', NULL, 'redbus-coupons'),
  (144, 'Reebok', 'Brand', 'reebok-online-offers', 'reebok-online-offers', NULL, 'reebok-coupons'),
  (145, 'Reequil', 'Brand', 'reequil', 'reequil', NULL, 'reequil-coupons'),
  (146, 'Refrigerators', 'Category', 'refrigerators-offers', 'refrigerators-offers', NULL, 'refrigerators-coupons'),
  (147, 'Refurbished', 'Category', 'refurbished-offers', 'refurbished-offers', NULL, 'refurbished-coupons'),
  (148, 'Restaurant', 'Category', 'restaurant-deals-coupons', 'restaurant-deals-coupons', NULL, 'restaurant-coupons'),
  (149, 'Samsung', 'Brand', 'shopping-coupon/samsung-mobiles', 'samsung-mobiles', 'shopping-coupon', 'samsung-coupons'),
  (150, 'SBI Card', 'Bank', 'sbi-card', 'sbi-card', NULL, 'sbi-coupons'),
  (151, 'Shoppers Stop', 'Store', 'shoppers-stop-discount-coupon-code', 'shoppers-stop-discount-coupon-code', NULL, 'shoppers-stop-coupons'),
  (152, 'Singles Day Offers', 'Category', 'singles-day-offers', 'singles-day-offers', NULL, 'singles-day-coupons'),
  (153, 'Snapdeal', 'Store', 'snapdeal-promo-coupons', 'snapdeal-promo-coupons', NULL, 'snapdeal-coupons'),
  (154, 'Sofa', 'Brand', 'sofa-online-offers', 'sofa-online-offers', NULL, 'sofa-coupons'),
  (155, 'Sony', 'Brand', 'sony-online-offers', 'sony-online-offers', NULL, 'sony-coupons'),
  (156, 'Spa and Salon Services', 'Category', 'spa-salon-offers', 'spa-salon-offers', NULL, 'spa-coupons'),
  (157, 'Speakers', 'Category', 'speakers-offers', 'speakers-offers', NULL, 'speakers-coupons'),
  (158, 'SpiceJet', 'Brand', 'travelcoupons/spicejet', 'spicejet', 'travelcoupons', 'spicejet-coupons'),
  (159, 'Sports Products', 'Category', 'sports-products-offers', 'sports-products-offers', NULL, 'sports-coupons'),
  (160, 'Student Laptops', 'Store', 'studentlaptop-discount-offers', 'studentlaptop-discount-offers', NULL, 'student-laptop-discount-coupons'),
  (161, 'Sun World Ba Na Hills', 'Brand', 'sun-world-ba-na-hills', 'sun-world-ba-na-hills', NULL, 'sunworld-coupons'),
  (162, 'Sunglasses', 'Category', 'sunglasses-offers', 'sunglasses-offers', NULL, 'sunglasses-coupons'),
  (163, 'Surat Diamonds', 'Store', 'shopping-coupon/surat-diamonds', 'surat-diamonds', 'shopping-coupon', 'surat-diamonds-coupons'),
  (164, 'T-shirt', 'Category', 'tshirt-online-offers', 'tshirt-online-offers', NULL, 'tshirt-coupons'),
  (165, 'Tablets', 'Category', 'tablet-offers', 'tablet-offers', NULL, 'tablet-coupons'),
  (166, 'Taxi and Cabs Booking', 'Category', 'taxi-cabs-booking', 'taxi-cabs-booking', NULL, 'taxi-coupons'),
  (167, 'Television', 'Category', 'television-online-offers', 'television-online-offers', NULL, 'television-coupons'),
  (168, 'Thomas Cook', 'Store', 'thomas-cook', 'thomas-cook', NULL, 'thomas-cook-coupons'),
  (169, 'Tommy Hilfiger', 'Brand', 'tommyhilfiger-online-offers', 'tommyhilfiger-online-offers', NULL, 'tommy-hilfiger-coupons'),
  (170, 'TourRadar', 'Store', 'tour-radar-promo-code', 'tour-radar-promo-code', NULL, 'tour-radar-coupons'),
  (171, 'Trimmers and Shavers', 'Category', 'trimmers-shavers-offers', 'trimmers-shavers-offers', NULL, 'trimmers-coupons'),
  (172, 'Tupperware', 'Brand', 'tupperware-online-offers', 'tupperware-online-offers', NULL, 'tupperware-coupons'),
  (173, 'Tyres', 'Category', 'tyres-online-offers', 'tyres-online-offers', NULL, 'tyres-coupons'),
  (174, 'Ugreen', 'Store', 'ugreen-coupon', 'ugreen-coupon', NULL, 'ugreen-coupons'),
  (175, 'UltraPlay', 'Store', 'ultraplay-coupon', 'ultraplay-coupon', NULL, 'ultraplay-coupons'),
  (176, 'United Colors of Benetton', 'Brand', 'ucb-promo-codes', 'ucb-promo-codes', NULL, 'ucb-coupons'),
  (177, 'Vacations By Mariott Bonvoy', 'Store', 'vacations-by-mariott-bonvoy', 'vacations-by-mariott-bonvoy', NULL, 'marriot-vacation-coupons'),
  (178, 'Valentines Day', 'Category', 'valentines-day-coupons-offers', 'valentines-day-coupons-offers', NULL, 'valentines-day-coupons'),
  (179, 'Visa Card Offers', 'Bank', 'visacard-offers', 'visacard-offers', NULL, 'visacard-coupons'),
  (180, 'Vistaprint', 'Store', 'vistaprint', 'vistaprint', NULL, 'vistaprint-coupons'),
  (181, 'Viva Glam', 'Store', 'vivaglam-coupon', 'vivaglam-coupon', NULL, 'vivaglam-coupons'),
  (182, 'Washing Machine', 'Category', 'washing-machines-offer', 'washing-machines-offer', NULL, 'washing-machines-coupons'),
  (183, 'Watches', 'Category', 'watches-coupons-offers', 'watches-coupons-offers', NULL, 'watches-coupons'),
  (184, 'Watcho', 'Store', 'watcho-coupon-code', 'watcho-coupon-code', NULL, 'watcho-coupons'),
  (185, 'Water Kingdom', 'Store', 'water-kingdom-offers', 'water-kingdom-offers', NULL, 'water-kingdom-coupons'),
  (186, 'WYBOT', 'Brand', 'wybot-codes', 'wybot-codes', NULL, 'wybot-coupons'),
  (187, 'Xcaret', 'Store', 'xcaret-coupon-codes', 'xcaret-coupon-codes', NULL, 'xcaret-coupons'),
  (188, 'Xiaomi', 'Brand', 'xiaomi-mi-offers-online', 'xiaomi-mi-offers-online', NULL, 'xiaomi-coupons'),
  (189, 'Yatra', 'Store', 'yatra-promotion-coupons', 'yatra-promotion-coupons', NULL, 'yatra-coupons'),
  (190, 'Zeneme', 'Brand', 'zeneme-coupon-codes', 'zeneme-coupon-codes', NULL, 'zeneme-coupons'),
  (191, 'Zivame', 'Brand', 'shopping-coupon/zivame', 'zivame', 'shopping-coupon', 'zivame-coupons');

START TRANSACTION;

CREATE TEMPORARY TABLE _cguru_taxonomy_candidates
ENGINE=InnoDB
AS
SELECT
  changes.source_line,
  changes.display_name,
  changes.expected_type,
  changes.old_complete_slug,
  changes.old_leaf_slug,
  changes.old_parent_slug,
  changes.new_slug,
  terms.term_id,
  terms.name AS actual_name,
  terms.slug AS actual_slug,
  taxonomy.term_taxonomy_id,
  taxonomy.parent AS actual_parent,
  parent_terms.slug AS actual_parent_slug,
  COALESCE(NULLIF(term_types.choose_type, ''), 'Store') AS actual_type
FROM _cguru_taxonomy_slug_changes AS changes
JOIN wp_terms AS terms
  ON terms.slug = changes.old_leaf_slug
JOIN wp_term_taxonomy AS taxonomy
  ON taxonomy.term_id = terms.term_id
 AND taxonomy.taxonomy = 'category'
LEFT JOIN wp_terms AS parent_terms
  ON parent_terms.term_id = taxonomy.parent
LEFT JOIN (
  SELECT term_id, MAX(meta_value) AS choose_type
  FROM wp_termmeta
  WHERE meta_key = 'choose_type'
  GROUP BY term_id
) AS term_types
  ON term_types.term_id = terms.term_id
WHERE
  (
    changes.old_parent_slug IS NULL
    AND taxonomy.parent = 0
  )
  OR
  (
    changes.old_parent_slug IS NOT NULL
    AND taxonomy.parent <> 0
    AND parent_terms.slug = changes.old_parent_slug
  );

CREATE TEMPORARY TABLE _cguru_taxonomy_issues (
  issue_type VARCHAR(64) NOT NULL,
  source_line SMALLINT UNSIGNED NULL,
  details VARCHAR(1000) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The embedded manifest must remain exactly the 189 audited live terms.
INSERT INTO _cguru_taxonomy_issues (issue_type, source_line, details)
SELECT
  'mapping-count',
  NULL,
  CONCAT('Expected 189 mappings, found ', mapping_count)
FROM (
  SELECT COUNT(*) AS mapping_count
  FROM _cguru_taxonomy_slug_changes
) AS counts
WHERE mapping_count <> 189;

-- Every legacy full path must resolve to exactly one WordPress category term.
INSERT INTO _cguru_taxonomy_issues (issue_type, source_line, details)
SELECT
  'source-match-count',
  changes.source_line,
  CONCAT(
    changes.old_complete_slug,
    ' matched ',
    COUNT(candidates.term_id),
    ' category terms; expected exactly 1'
  )
FROM _cguru_taxonomy_slug_changes AS changes
LEFT JOIN _cguru_taxonomy_candidates AS candidates
  ON candidates.source_line = changes.source_line
GROUP BY
  changes.source_line,
  changes.old_complete_slug
HAVING COUNT(candidates.term_id) <> 1;

-- Protect against the CSV pointing at a similarly-named term of another type.
INSERT INTO _cguru_taxonomy_issues (issue_type, source_line, details)
SELECT
  'type-mismatch',
  source_line,
  CONCAT(
    old_complete_slug,
    ' expected type ',
    expected_type,
    ' but WordPress has ',
    actual_type
  )
FROM _cguru_taxonomy_candidates
WHERE actual_type <> expected_type;

INSERT INTO _cguru_taxonomy_issues (issue_type, source_line, details)
SELECT
  'name-mismatch',
  source_line,
  CONCAT(
    old_complete_slug,
    ' expected name ',
    display_name,
    ' but WordPress has ',
    actual_name
  )
FROM _cguru_taxonomy_candidates
WHERE LOWER(REPLACE(actual_name, '&amp;', '&'))
   <> LOWER(REPLACE(display_name, '&amp;', '&'));

-- WordPress requires a slug to be unique across the category taxonomy, even
-- when an existing owner sits under a different parent.
INSERT INTO _cguru_taxonomy_issues (issue_type, source_line, details)
SELECT DISTINCT
  'target-collision',
  candidates.source_line,
  CONCAT(
    candidates.new_slug,
    ' is already owned by term ',
    existing_terms.term_id,
    ' (',
    existing_terms.name,
    ')'
  )
FROM _cguru_taxonomy_candidates AS candidates
JOIN wp_terms AS existing_terms
  ON existing_terms.slug = candidates.new_slug
JOIN wp_term_taxonomy AS existing_taxonomy
  ON existing_taxonomy.term_id = existing_terms.term_id
 AND existing_taxonomy.taxonomy = 'category'
WHERE existing_terms.term_id <> candidates.term_id;

-- Moving or renaming a parent would also change every descendant URL.
INSERT INTO _cguru_taxonomy_issues (issue_type, source_line, details)
SELECT
  'selected-term-has-child',
  candidates.source_line,
  CONCAT(
    candidates.old_complete_slug,
    ' has child term ',
    child_taxonomy.term_id,
    '; descendant URLs were not included in this migration'
  )
FROM _cguru_taxonomy_candidates AS candidates
JOIN wp_term_taxonomy AS child_taxonomy
  ON child_taxonomy.parent = candidates.term_id
 AND child_taxonomy.taxonomy = 'category';

-- wp_terms is shared by taxonomy rows. Refuse to rename a term_id that is
-- unexpectedly used by more than the one audited category taxonomy row.
INSERT INTO _cguru_taxonomy_issues (issue_type, source_line, details)
SELECT
  'shared-term-row',
  candidates.source_line,
  CONCAT(
    candidates.old_complete_slug,
    ' term_id ',
    candidates.term_id,
    ' is used by ',
    COUNT(all_taxonomies.term_taxonomy_id),
    ' taxonomy rows'
  )
FROM _cguru_taxonomy_candidates AS candidates
JOIN wp_term_taxonomy AS all_taxonomies
  ON all_taxonomies.term_id = candidates.term_id
GROUP BY
  candidates.source_line,
  candidates.old_complete_slug,
  candidates.term_id
HAVING COUNT(all_taxonomies.term_taxonomy_id) <> 1;

-- Show every problem before intentionally stopping the mysql client.
SELECT issue_type, source_line, details
FROM _cguru_taxonomy_issues
ORDER BY source_line, issue_type;

CREATE TEMPORARY TABLE _cguru_abort_guard (
  id TINYINT NOT NULL PRIMARY KEY
) ENGINE=InnoDB;

INSERT INTO _cguru_abort_guard (id) VALUES (1);

-- If any preflight issue exists this duplicates id=1 and aborts the batch.
INSERT INTO _cguru_abort_guard (id)
SELECT 1
FROM _cguru_taxonomy_issues
LIMIT 1;

-- The issue-count join is a second safety net for clients configured to
-- continue after SQL errors: no base-table update can run with an issue.
UPDATE wp_terms AS terms
JOIN _cguru_taxonomy_candidates AS candidates
  ON candidates.term_id = terms.term_id
JOIN (
  SELECT COUNT(*) AS issue_count
  FROM _cguru_taxonomy_issues
) AS guard
  ON guard.issue_count = 0
SET terms.slug = candidates.new_slug;

SET @cguru_slug_rows := ROW_COUNT();

UPDATE wp_term_taxonomy AS taxonomy
JOIN _cguru_taxonomy_candidates AS candidates
  ON candidates.term_taxonomy_id = taxonomy.term_taxonomy_id
JOIN (
  SELECT COUNT(*) AS issue_count
  FROM _cguru_taxonomy_issues
) AS guard
  ON guard.issue_count = 0
SET taxonomy.parent = 0
WHERE taxonomy.taxonomy = 'category';

SET @cguru_parent_rows := ROW_COUNT();

-- Postflight checks happen before COMMIT.
DELETE FROM _cguru_taxonomy_issues;

INSERT INTO _cguru_taxonomy_issues (issue_type, source_line, details)
SELECT
  'slug-update-count',
  NULL,
  CONCAT('Expected 189 changed slug rows, changed ', @cguru_slug_rows)
WHERE @cguru_slug_rows <> 189;

INSERT INTO _cguru_taxonomy_issues (issue_type, source_line, details)
SELECT
  'parent-update-count',
  NULL,
  CONCAT('Expected 17 changed parent rows, changed ', @cguru_parent_rows)
WHERE @cguru_parent_rows <> 17;

INSERT INTO _cguru_taxonomy_issues (issue_type, source_line, details)
SELECT
  'postcondition',
  candidates.source_line,
  CONCAT(
    'Expected root slug ',
    candidates.new_slug,
    '; found slug ',
    terms.slug,
    ' and parent ',
    taxonomy.parent
  )
FROM _cguru_taxonomy_candidates AS candidates
JOIN wp_terms AS terms
  ON terms.term_id = candidates.term_id
JOIN wp_term_taxonomy AS taxonomy
  ON taxonomy.term_taxonomy_id = candidates.term_taxonomy_id
WHERE terms.slug <> candidates.new_slug
   OR taxonomy.parent <> 0
   OR taxonomy.taxonomy <> 'category';

INSERT INTO _cguru_taxonomy_issues (issue_type, source_line, details)
SELECT
  'post-update-target-collision',
  MIN(candidates.source_line),
  CONCAT(
    candidates.new_slug,
    ' is owned by ',
    COUNT(DISTINCT category_terms.term_id),
    ' category terms after the update'
  )
FROM _cguru_taxonomy_candidates AS candidates
JOIN wp_terms AS category_terms
  ON category_terms.slug = candidates.new_slug
JOIN wp_term_taxonomy AS category_taxonomy
  ON category_taxonomy.term_id = category_terms.term_id
 AND category_taxonomy.taxonomy = 'category'
GROUP BY candidates.new_slug
HAVING COUNT(DISTINCT category_terms.term_id) <> 1;

SELECT issue_type, source_line, details
FROM _cguru_taxonomy_issues
ORDER BY source_line, issue_type;

DELETE FROM _cguru_abort_guard;
INSERT INTO _cguru_abort_guard (id) VALUES (1);

-- A postflight issue aborts before COMMIT; closing the connection rolls back.
INSERT INTO _cguru_abort_guard (id)
SELECT 1
FROM _cguru_taxonomy_issues
LIMIT 1;

SELECT
  @cguru_slug_rows AS changed_slug_rows,
  @cguru_parent_rows AS changed_parent_rows,
  (SELECT COUNT(*) FROM _cguru_taxonomy_issues) AS postflight_issues;

COMMIT;

SELECT
  'SUCCESS' AS migration_status,
  189 AS taxonomy_slugs_updated,
  17 AS taxonomy_parents_flattened,
  'Chhabra555 excluded: no live WordPress term' AS note;
