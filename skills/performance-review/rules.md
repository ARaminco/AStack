# قواعد بازبینی Performance

## قواعد الزامی
- سیاست زبان فقط از `../../system/language-policy.md` می‌آید و این فایل آن را تکرار نمی‌کند.
- هر توصیه باید بر پایه‌ی source، configuration، runtime evidence، documentation یا فرض صریح باشد.
- پیشنهادها باید با الگوهای native همان framework هماهنگ باشند.
- یافته‌ی مبهم بدون impact و verification پذیرفته نیست.

## معیار کیفیت
- بررسی `database performance` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Redis` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `caching` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `workers` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `queues` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Docker` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `memory` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `CPU` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `network` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `bundle size` و ثبت وضعیت pass، fail یا not applicable.

## escalation
- اگر مرزهای معماری تغییر می‌کند، `architecture-review` را اضافه کن.
- اگر user data، secrets، authentication، authorization یا external input درگیر است، `security-review` را اضافه کن.
- اگر release order، migration، queue، worker یا infrastructure state مهم است، `deployment-review` را اضافه کن.
