# WordPress taxonomy slug rollout — 2026-07-30

This rollout renames and flattens 189 live WordPress category-taxonomy terms and
installs matching nginx 301 redirects. Chhabra555 is excluded because the live
database has no matching term at any slug.

The production read audit connected through the existing migration tunnel with
`SSH_USER=vira2804` and found:

- 189 exact live matches;
- 17 parented terms, all leaves with no children;
- zero name/type mismatches;
- zero target-slug collisions anywhere in the category taxonomy;
- zero invalid or duplicate target slugs.

The SSH account is sufficient for read verification but does not need database
write privileges. Run the SQL with a separate privileged MySQL account.

## 1. Install and test nginx without reloading

The production host is managed by SpinupWP. Its canonical HTTPS virtual host
automatically includes every file under:

`/etc/nginx/sites-available/www.couponzguru.com/server/`

The generated snippet is already staged, root-owned, at:

`/etc/nginx/snippets/taxonomy-redirects.conf`

Its SHA-256 matches
`migration/nginx/couponzguru-taxonomy-redirects-20260730.conf`:

```text
5b398a3c28460bf3a9ec0d922b35c8c9d425b972df1b5f45f46ab29402ed4478
```

Activate it with a persistent SpinupWP server fragment:

```bash
printf '%s\n' \
  'include /etc/nginx/snippets/taxonomy-redirects.conf;' |
  sudo tee \
    /etc/nginx/sites-available/www.couponzguru.com/server/taxonomy-redirects.conf
```

Validate the configuration, but do not reload yet:

```bash
sudo nginx -t
```

Reloading at this point would send legacy URLs to slugs WordPress does not yet
serve.

The existing HTTP and non-`www` virtual hosts already canonicalize scheme/host.
The taxonomy snippet therefore runs in the canonical HTTPS vhost. A request
made directly to an old canonical HTTPS URL gets one taxonomy redirect; an
HTTP or non-`www` request may first take the existing canonicalization hop.

## 2. Back up and run the guarded SQL

From the WordPress installation directory, export the database:

```bash
wp db export "before-taxonomy-slugs-$(date +%Y%m%d-%H%M%S).sql"
```

Run the SQL with a privileged MySQL account. Do not use `--force`:

```bash
mysql --batch --abort-source-on-error \
  -u <privileged-user> -p <wordpress-database> \
  < migration/sql/2026-07-30-update-wordpress-taxonomy-slugs.sql
```

Expected final result:

```text
migration_status: SUCCESS
taxonomy_slugs_updated: 189
taxonomy_parents_flattened: 17
```

Any preflight or postflight problem deliberately raises a duplicate-key error.
The mysql client must stop so the open transaction rolls back.

## 3. Rebuild WordPress caches

Direct SQL bypasses WordPress term hooks, so clear the object cache and rebuild
Yoast indexables before making the redirects live:

```bash
wp cache flush
wp yoast index --reindex
```

## 4. Reload nginx

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 5. Verify

For a parented example:

```bash
curl -sS -I https://www.couponzguru.com/shopping-coupon/flipkart/
curl -sS -I https://www.couponzguru.com/flipkart-coupons/
```

For a former root example:

```bash
curl -sS -I https://www.couponzguru.com/air-india-promo-codes/
curl -sS -I https://www.couponzguru.com/air-india-coupons/
```

Acceptance criteria:

- every canonical HTTPS legacy URL, with or without a trailing slash, returns
  one 301;
- `Location` is exactly
  `https://www.couponzguru.com/<new-slug>/`;
- each destination returns 200 and does not redirect back to a legacy URL;
- query strings survive the redirect;
- there are no taxonomy redirect chains or loops.
