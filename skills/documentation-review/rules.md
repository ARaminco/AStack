# قواعد بازبینی Documentation

## قواعد الزامی
- سیاست زبان فقط از `../../system/language-policy.md` می‌آید و این فایل آن را تکرار نمی‌کند.
- هر توصیه باید بر پایه‌ی source، configuration، runtime evidence، documentation یا فرض صریح باشد.
- پیشنهادها باید با الگوهای native همان framework هماهنگ باشند.
- یافته‌ی مبهم بدون impact و verification پذیرفته نیست.

## معیار کیفیت
- بررسی `README` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `Architecture.md` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `API.md` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `runbooks` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `examples` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `decision records` و ثبت وضعیت pass، fail یا not applicable.
- بررسی `migration guides` و ثبت وضعیت pass، fail یا not applicable.

## escalation
- اگر مرزهای معماری تغییر می‌کند، `architecture-review` را اضافه کن.
- اگر user data، secrets، authentication، authorization یا external input درگیر است، `security-review` را اضافه کن.
- اگر release order، migration، queue، worker یا infrastructure state مهم است، `deployment-review` را اضافه کن.
