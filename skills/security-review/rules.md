# قواعد بازبینی Security

## قواعد الزامی
- سیاست زبان فقط از `../../system/language-policy.md` می‌آید و این فایل آن را تکرار نمی‌کند.
- هر توصیه باید بر پایه‌ی source، configuration، runtime evidence، documentation یا فرض صریح باشد.
- پیشنهادها باید با الگوهای native همان framework هماهنگ باشند.
- یافته‌ی مبهم بدون impact و verification پذیرفته نیست.

## معیار کیفیت
- بررسی `OWASP Top 10` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `JWT` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `OAuth` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `CSRF` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `XSS` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `SQL Injection` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `secrets` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `rate limiting` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `permissions` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `dependency vulnerabilities` و ثبت وضعیت pass، fail یا not applicable.

## escalation
- اگر مرزهای معماری تغییر می‌کند، `architecture-review` را اضافه کن.
- اگر user data، secrets، authentication، authorization یا external input درگیر است، `security-review` را اضافه کن.
- اگر release order، migration، queue، worker یا infrastructure state مهم است، `deployment-review` را اضافه کن.
