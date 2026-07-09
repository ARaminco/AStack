# قواعد بازبینی SEO

## قواعد الزامی
- سیاست زبان فقط از `../../system/language-policy.md` می‌آید و این فایل آن را تکرار نمی‌کند.
- هر توصیه باید بر پایه‌ی source، configuration، runtime evidence، documentation یا فرض صریح باشد.
- پیشنهادها باید با الگوهای native همان framework هماهنگ باشند.
- یافته‌ی مبهم بدون impact و verification پذیرفته نیست.

## معیار کیفیت
- بررسی `title` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `description` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `schema` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `JSON-LD` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `canonical` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `sitemap` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `robots` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `accessibility` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Core Web Vitals` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `internal links` و ثبت وضعیت pass، fail یا not applicable.

## escalation
- اگر مرزهای معماری تغییر می‌کند، `architecture-review` را اضافه کن.
- اگر user data، secrets، authentication، authorization یا external input درگیر است، `security-review` را اضافه کن.
- اگر release order، migration، queue، worker یا infrastructure state مهم است، `deployment-review` را اضافه کن.
